"""Domain exceptions.

Every exception carries a stable, public error code and the HTTP status that the
single boundary mapper assigns to it. Messages are safe to show to a local
desktop client: no argv, environment, file paths or tracebacks.
"""

from __future__ import annotations


class DomainError(Exception):
    """Base class for expected domain failures.

    Pre: ``message`` is a human-readable, already-sanitized description.
    Post: ``code`` is a stable upper-snake-case identifier and ``status_code``
          is in the 4xx/5xx range.
    """

    code: str = "DOMAIN_ERROR"
    status_code: int = 400

    def __init__(self, message: str = "") -> None:
        super().__init__(message)
        self.message = message or self.code.replace("_", " ").capitalize()


class InvalidInput(DomainError):
    code = "INVALID_INPUT"
    status_code = 400


class InvalidTurnId(InvalidInput):
    code = "INVALID_TURN_ID"


class InvalidSettings(InvalidInput):
    code = "INVALID_SETTINGS"


class PermissionModeUnsupported(InvalidInput):
    code = "PERMISSION_MODE_UNSUPPORTED"


class Unauthorized(DomainError):
    code = "UNAUTHORIZED"
    status_code = 401


class Forbidden(DomainError):
    code = "FORBIDDEN"
    status_code = 403


class NotFound(DomainError):
    code = "NOT_FOUND"
    status_code = 404


class SessionNotFound(NotFound):
    code = "SESSION_NOT_FOUND"


class TurnNotFound(NotFound):
    code = "TURN_NOT_FOUND"


class ProviderNotFound(NotFound):
    code = "PROVIDER_NOT_FOUND"


class Conflict(DomainError):
    code = "CONFLICT"
    status_code = 409


class TurnInProgress(Conflict):
    code = "TURN_IN_PROGRESS"


class TurnAlreadyFinished(Conflict):
    code = "TURN_ALREADY_FINISHED"


class EngineUnavailable(DomainError):
    code = "ENGINE_UNAVAILABLE"
    status_code = 503


class EngineInitTimeout(EngineUnavailable):
    code = "ENGINE_INIT_TIMEOUT"


class EngineExited(DomainError):
    code = "ENGINE_EXITED"
    status_code = 502


class WorkspaceUnavailable(DomainError):
    code = "WORKSPACE_UNAVAILABLE"
    status_code = 503


class SkillNotFound(NotFound):
    code = "SKILL_NOT_FOUND"


class McpServerNotFound(NotFound):
    code = "MCP_SERVER_NOT_FOUND"


class McpToolNotFound(NotFound):
    code = "MCP_TOOL_NOT_FOUND"


class McpUnavailable(DomainError):
    code = "MCP_UNAVAILABLE"
    status_code = 502


class ArtifactNotFound(NotFound):
    code = "ARTIFACT_NOT_FOUND"


class ArtifactUnavailable(DomainError):
    code = "ARTIFACT_UNAVAILABLE"
    status_code = 503
