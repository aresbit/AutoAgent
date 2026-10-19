"""MCP tool approval policy.

The module decides *what* should happen to a call; it never renders UI and
never mutates consent state.  The application layer turns an ``ask`` decision
into a consent prompt (``mcp.approval_required``) and retries the same call
with an ``ApprovalContext`` that records the user's answer.

Decision precedence, highest first:

1. ``ApprovalContext.auto_approve`` (explicit bypass, e.g. a trusted local test)
2. explicit deny rules (server/tool glob)
3. explicit allow rules (server/tool glob)
4. per-server mode ``deny``
5. recorded per-call consent (``approved_tools`` / ``approved_servers``)
6. read-only tools when the server policy allows them
7. per-server mode ``auto`` (subject to destructive/open-world guards)
8. per-server mode ``ask``

Annotation defaults follow the MCP specification conservatively: absent
``destructiveHint`` and ``openWorldHint`` mean *true*, while ``readOnlyHint``
and ``idempotentHint`` default to *false*.
"""

from __future__ import annotations

import fnmatch
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Literal

ApprovalAction = Literal["allow", "ask", "deny"]
RiskLevel = Literal["read_only", "write", "destructive", "open_world", "unknown"]
ServerMode = Literal["auto", "ask", "deny"]


@dataclass(frozen=True, slots=True)
class ToolAnnotations:
    """Normalized MCP tool annotations.

    Pre: ``raw`` is the ``annotations`` object from ``tools/list`` or ``None``.
    Post: booleans are safe defaults; ``read_only`` implies ``not destructive``.
    """

    title: str | None = None
    read_only: bool = False
    destructive: bool = True
    idempotent: bool = False
    open_world: bool = True

    @classmethod
    def from_mcp(cls, raw: Mapping[str, object] | None) -> ToolAnnotations:
        if raw is None:
            return cls()
        read_only = raw.get("readOnlyHint") is True
        destructive_value = raw.get("destructiveHint")
        open_world_value = raw.get("openWorldHint")
        title = raw.get("title")
        return cls(
            title=title if isinstance(title, str) else None,
            read_only=read_only,
            destructive=False if read_only else destructive_value is not False,
            idempotent=raw.get("idempotentHint") is True,
            open_world=open_world_value is not False,
        )

    @property
    def risk(self) -> RiskLevel:
        if self.read_only:
            return "read_only"
        if self.destructive:
            return "destructive"
        if self.open_world:
            return "open_world"
        return "write"


@dataclass(frozen=True, slots=True)
class ToolMetadata:
    """The approval-relevant slice of one discovered MCP tool."""

    server: str
    tool: str
    annotations: ToolAnnotations = field(default_factory=ToolAnnotations)
    description: str = ""

    @property
    def risk(self) -> RiskLevel:
        return self.annotations.risk


@dataclass(frozen=True, slots=True)
class Rule:
    """A server/tool glob rule.

    ``server`` and ``tool`` accept ``fnmatch`` patterns (``*``, ``?``, ``[``).
    """

    server: str = "*"
    tool: str = "*"
    reason: str = ""

    def matches(self, server: str, tool: str) -> bool:
        """Post: case-sensitive glob match against both dimensions."""

        return fnmatch.fnmatchcase(server, self.server) and fnmatch.fnmatchcase(tool, self.tool)


@dataclass(frozen=True, slots=True)
class ServerApprovalPolicy:
    """Per-server policy; the global policy is the fallback."""

    mode: ServerMode = "ask"
    allow_tools: frozenset[str] = frozenset()
    deny_tools: frozenset[str] = frozenset()
    allow_read_only: bool = True
    allow_destructive: bool = False
    allow_open_world: bool = False
    auto_approve_idempotent: bool = True


@dataclass(frozen=True, slots=True)
class ApprovalContext:
    """Consent accumulated for one invocation or one agent run.

    Pre: ``approved_tools`` contains exact tool names; ``approved_servers``
         contains exact server names.
    """

    approved_tools: frozenset[str] = frozenset()
    approved_servers: frozenset[str] = frozenset()
    auto_approve: bool = False


@dataclass(frozen=True, slots=True)
class ApprovalDecision:
    """The engine's verdict.  ``reason`` is safe to show in the UI."""

    action: ApprovalAction
    code: str
    reason: str
    risk: RiskLevel


class ApprovalEngine:
    """Stateless decision engine.

    Pre: rules and policies are immutable values (copy them when updating).
    Post: ``evaluate`` is pure and thread-safe; it performs no I/O.
    """

    def __init__(
        self,
        *,
        default_policy: ServerApprovalPolicy | None = None,
        server_policies: Mapping[str, ServerApprovalPolicy] | None = None,
        deny_rules: Sequence[Rule] = (),
        allow_rules: Sequence[Rule] = (),
    ) -> None:
        self._default = default_policy or ServerApprovalPolicy()
        self._server_policies = dict(server_policies or {})
        self._deny_rules = tuple(deny_rules)
        self._allow_rules = tuple(allow_rules)

    def policy_for(self, server: str) -> ServerApprovalPolicy:
        """Post: returns the configured policy or the default policy."""

        return self._server_policies.get(server, self._default)

    def set_server_policy(self, server: str, policy: ServerApprovalPolicy) -> None:
        """Post: subsequent decisions for ``server`` use ``policy``."""

        self._server_policies[server] = policy

    def evaluate(
        self,
        metadata: ToolMetadata,
        context: ApprovalContext | None = None,
    ) -> ApprovalDecision:
        """Classify one call.

        Pre: ``metadata.server`` and ``metadata.tool`` are non-empty.
        Post: returns exactly one decision; ``ask`` never means "allowed".
        """

        approval = context or ApprovalContext()
        risk = metadata.risk
        if approval.auto_approve:
            return ApprovalDecision("allow", "bypass", "Approval was bypassed for this call.", risk)

        for rule in self._deny_rules:
            if rule.matches(metadata.server, metadata.tool):
                reason = rule.reason or f"{metadata.server}/{metadata.tool} is denied by policy."
                return ApprovalDecision("deny", "denied_by_rule", reason, risk)

        for rule in self._allow_rules:
            if rule.matches(metadata.server, metadata.tool):
                reason = rule.reason or f"{metadata.server}/{metadata.tool} is allowed by policy."
                return ApprovalDecision("allow", "allowed_by_rule", reason, risk)

        policy = self.policy_for(metadata.server)
        if policy.mode == "deny":
            return ApprovalDecision(
                "deny",
                "server_denied",
                f"MCP server {metadata.server} is configured to deny all calls.",
                risk,
            )
        if metadata.tool in policy.deny_tools:
            return ApprovalDecision(
                "deny",
                "tool_denied",
                f"{metadata.server}/{metadata.tool} is denied for this server.",
                risk,
            )
        if metadata.tool in policy.allow_tools:
            return ApprovalDecision(
                "allow",
                "tool_allowlist",
                f"{metadata.server}/{metadata.tool} is on the server allowlist.",
                risk,
            )
        if metadata.tool in approval.approved_tools or metadata.server in approval.approved_servers:
            return ApprovalDecision(
                "allow",
                "session_consent",
                f"{metadata.server}/{metadata.tool} was approved for this session.",
                risk,
            )
        if risk == "read_only" and policy.allow_read_only:
            return ApprovalDecision(
                "allow",
                "read_only",
                f"{metadata.server}/{metadata.tool} is read-only.",
                risk,
            )
        if policy.mode == "auto":
            if risk == "destructive" and not policy.allow_destructive:
                return self._ask(
                    metadata,
                    risk,
                    "destructive tool requires explicit approval",
                )
            if risk == "open_world" and not policy.allow_open_world:
                return self._ask(
                    metadata,
                    risk,
                    "open-world tool requires explicit approval",
                )
            if (
                risk in {"write", "open_world"}
                and policy.auto_approve_idempotent
                and metadata.annotations.idempotent
            ):
                return ApprovalDecision(
                    "allow",
                    "auto_idempotent",
                    f"{metadata.server}/{metadata.tool} is idempotent.",
                    risk,
                )
            return ApprovalDecision(
                "allow",
                "auto_server",
                f"MCP server {metadata.server} auto-approves {risk} tools.",
                risk,
            )
        return self._ask(metadata, risk, f"{risk} tool is not pre-approved")

    @staticmethod
    def _ask(metadata: ToolMetadata, risk: RiskLevel, detail: str) -> ApprovalDecision:
        return ApprovalDecision(
            "ask",
            "consent_required",
            f"{metadata.server}/{metadata.tool}: {detail}.",
            risk,
        )

    def filter_tools(
        self,
        tools: Iterable[ToolMetadata],
        context: ApprovalContext | None = None,
    ) -> tuple[ToolMetadata, ...]:
        """Post: returns tools whose decision is ``allow``; order is preserved."""

        return tuple(tool for tool in tools if self.evaluate(tool, context).action == "allow")


__all__ = [
    "ApprovalAction",
    "ApprovalContext",
    "ApprovalDecision",
    "ApprovalEngine",
    "RiskLevel",
    "Rule",
    "ServerApprovalPolicy",
    "ServerMode",
    "ToolAnnotations",
    "ToolMetadata",
]
