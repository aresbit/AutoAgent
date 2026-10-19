/**
 * Reference MCP status panel.
 *
 * Drop-in next to McpPanel.tsx once the backend routes in PATCH_PLAN exist:
 *
 *   <McpStatusPanel
 *     client={new McpStatusClient({ getToken: getLaunchToken })}
 *     initialStatuses={statuses}
 *   />
 *
 * It renders connection state, tool counts, the last error, a reconnect action,
 * a logs drawer and the approve/deny prompt. It uses plain Tailwind classes so
 * it can be reviewed without touching `@/cds`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  McpApprovalRequest,
  McpLogEntry,
  McpServerStatus,
  McpStatusClient,
  McpStatusEvent,
  McpStreamState,
} from "./mcpStatusClient";

export interface McpStatusPanelProps {
  readonly client: McpStatusClient;
  readonly initialStatuses?: readonly McpServerStatus[];
  readonly className?: string;
}

const MAX_VISIBLE_LOGS = 500;

function cx(...parts: ReadonlyArray<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

function stateTone(state: McpServerStatus["state"]): string {
  if (state === "connected") return "bg-emerald-500/15 text-emerald-600";
  if (state === "error") return "bg-red-500/15 text-red-600";
  if (state === "connecting" || state === "reconnecting") {
    return "bg-amber-500/15 text-amber-600";
  }
  return "bg-black/5 text-ink-2";
}

function logTone(level: McpLogEntry["level"]): string {
  if (level === "error") return "text-red-600";
  if (level === "warning") return "text-amber-600";
  if (level === "stderr") return "text-ink-2";
  return "text-ink";
}

function formatTime(ts: number): string {
  if (!ts) return "";
  return new Date(ts).toLocaleTimeString();
}

export function McpStatusPanel({
  client,
  initialStatuses = [],
  className,
}: McpStatusPanelProps) {
  const [statuses, setStatuses] = useState<Record<string, McpServerStatus>>(() => {
    const initial: Record<string, McpServerStatus> = {};
    for (const status of initialStatuses) initial[status.name] = status;
    return initial;
  });
  const [streamState, setStreamState] = useState<McpStreamState>("connecting");
  const [logsServer, setLogsServer] = useState<string | null>(null);
  const [logs, setLogs] = useState<readonly McpLogEntry[]>([]);
  const [approval, setApproval] = useState<McpApprovalRequest | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const logsServerRef = useRef<string | null>(null);
  const logEndRef = useRef<HTMLDivElement | null>(null);

  const upsert = useCallback((status: McpServerStatus): void => {
    setStatuses((current) => ({ ...current, [status.name]: status }));
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const next = await client.listServers();
      const record: Record<string, McpServerStatus> = {};
      for (const status of next) record[status.name] = status;
      setStatuses(record);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "MCP status could not be loaded.");
    }
  }, [client]);

  useEffect(() => {
    let cancelled = false;

    const onEvent = (event: McpStatusEvent): void => {
      if (cancelled) return;
      if (event.type === "mcp.status") {
        upsert(event.status);
      } else if (event.type === "mcp.approval_required") {
        setApproval(event.approval);
      } else if (event.type === "mcp.tools_changed") {
        setStatuses((current) => {
          const existing = current[event.server];
          if (!existing) return current;
          return {
            ...current,
            [event.server]: { ...existing, toolCount: event.tools.length },
          };
        });
      } else if (event.type === "mcp.log") {
        if (logsServerRef.current === event.server) {
          setLogs((current) => [...current, event.entry].slice(-MAX_VISIBLE_LOGS));
        }
      } else if (event.type === "mcp.server_changed") {
        void client
          .server(event.server)
          .then((status) => {
            if (!cancelled) upsert(status);
          })
          .catch(() => undefined);
      }
    };

    const unsubscribe = client.subscribe(onEvent, setStreamState);
    if (initialStatuses.length === 0) void refresh();

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [client, initialStatuses.length, refresh, upsert]);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ block: "end" });
  }, [logs]);

  const servers = useMemo(
    () => Object.values(statuses).sort((left, right) => left.name.localeCompare(right.name)),
    [statuses],
  );

  const openLogs = useCallback(
    async (name: string): Promise<void> => {
      logsServerRef.current = name;
      setLogsServer(name);
      setLogs([]);
      try {
        const entries = await client.logs(name);
        if (logsServerRef.current === name) setLogs(entries);
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : "MCP logs could not be loaded.");
      }
    },
    [client],
  );

  const closeLogs = useCallback((): void => {
    logsServerRef.current = null;
    setLogsServer(null);
    setLogs([]);
  }, []);

  const reconnect = useCallback(
    async (name: string): Promise<void> => {
      setBusy(`reconnect:${name}`);
      try {
        upsert(await client.reconnect(name));
        setError(null);
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : "Reconnect failed.");
      } finally {
        setBusy(null);
      }
    },
    [client, upsert],
  );

  const decide = useCallback(
    async (decision: "allow" | "deny", scope: "once" | "session"): Promise<void> => {
      if (!approval) return;
      setBusy(`approval:${approval.callId}`);
      try {
        await client.decideApproval(
          approval.server,
          approval.tool,
          decision,
          scope,
          approval.callId,
        );
        setApproval(null);
        setError(null);
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : "The decision was not recorded.");
      } finally {
        setBusy(null);
      }
    },
    [approval, client],
  );

  return (
    <section className={cx("flex flex-col gap-3", className)} aria-label="MCP servers">
      <header className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-[13px] font-semibold text-ink">MCP connections</h2>
          <p className="text-[11.5px] text-ink-3">
            Persistent sessions with health checks and live tool invalidation.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span
            className={cx(
              "rounded-full px-2 py-0.5 text-[10.5px] font-medium",
              streamState === "open"
                ? "bg-emerald-500/15 text-emerald-600"
                : "bg-black/5 text-ink-2",
            )}
            role="status"
          >
            events: {streamState}
          </span>
          <button
            type="button"
            className="rounded-md bg-panel-2 px-2 py-1 text-[11.5px] text-ink-2 transition-colors hover:bg-selected hover:text-ink focus-visible:outline-none focus-visible:shadow-focus"
            onClick={() => void refresh()}
          >
            Refresh
          </button>
        </div>
      </header>

      {error ? (
        <p className="rounded-md bg-red-500/10 px-2 py-1 text-[11.5px] text-red-600" role="alert">
          {error}
        </p>
      ) : null}

      {approval ? (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
          <p className="text-[12px] font-medium text-ink">
            Approval required: {approval.server}/{approval.tool}
          </p>
          <p className="mt-0.5 text-[11.5px] text-ink-2">
            {approval.reason} Risk: {approval.risk}.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy !== null}
              className="rounded-md bg-accent px-2.5 py-1 text-[11.5px] font-medium text-white disabled:opacity-50"
              onClick={() => void decide("allow", "once")}
            >
              Allow once
            </button>
            <button
              type="button"
              disabled={busy !== null}
              className="rounded-md bg-panel-2 px-2.5 py-1 text-[11.5px] font-medium text-ink disabled:opacity-50"
              onClick={() => void decide("allow", "session")}
            >
              Allow for session
            </button>
            <button
              type="button"
              disabled={busy !== null}
              className="rounded-md bg-red-500/15 px-2.5 py-1 text-[11.5px] font-medium text-red-600 disabled:opacity-50"
              onClick={() => void decide("deny", "once")}
            >
              Deny
            </button>
          </div>
        </div>
      ) : null}

      {servers.length === 0 ? (
        <p className="rounded-md border border-dashed border-line px-3 py-4 text-center text-[12px] text-ink-3">
          No MCP servers configured.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {servers.map((server) => (
            <li
              key={server.name}
              className="rounded-lg border border-line bg-panel p-3"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-[12px] font-medium text-ink">{server.name}</span>
                <span
                  className={cx(
                    "rounded-full px-2 py-0.5 text-[10.5px] font-medium",
                    stateTone(server.state),
                  )}
                >
                  {server.state}
                </span>
                <span className="text-[11px] text-ink-3">
                  {server.toolCount} tools
                  {server.resourceCount ? ` · ${server.resourceCount} resources` : ""}
                  {server.promptCount ? ` · ${server.promptCount} prompts` : ""}
                </span>
                <span className="ml-auto flex gap-1">
                  <button
                    type="button"
                    className="rounded-md px-2 py-1 text-[11px] text-ink-2 transition-colors hover:bg-panel-2 hover:text-ink focus-visible:outline-none focus-visible:shadow-focus"
                    onClick={() => void openLogs(server.name)}
                  >
                    Logs
                  </button>
                  <button
                    type="button"
                    disabled={busy !== null}
                    className="rounded-md px-2 py-1 text-[11px] text-ink-2 transition-colors hover:bg-panel-2 hover:text-ink focus-visible:outline-none focus-visible:shadow-focus disabled:opacity-50"
                    onClick={() => void reconnect(server.name)}
                  >
                    {busy === `reconnect:${server.name}` ? "Reconnecting…" : "Reconnect"}
                  </button>
                </span>
              </div>
              <p className="mt-1 text-[11px] text-ink-3">
                {server.serverName ?? "unknown server"}
                {server.serverVersion ? ` v${server.serverVersion}` : ""}
                {server.protocolVersion ? ` · MCP ${server.protocolVersion}` : ""}
                {server.sessionId ? ` · session ${server.sessionId.slice(0, 8)}` : ""}
                {server.pid ? ` · pid ${server.pid}` : ""}
              </p>
              {server.lastError ? (
                <p className="mt-1 rounded bg-red-500/10 px-2 py-1 text-[11px] text-red-600">
                  {server.lastError}
                  {server.reconnectAttempts
                    ? ` (attempt ${server.reconnectAttempts}, retry in ${
                        server.nextRetryInMs ?? 0
                      } ms)`
                    : ""}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {logsServer ? (
        <div className="fixed inset-0 z-40 flex justify-end bg-black/20" role="presentation">
          <aside
            className="flex h-full w-[440px] max-w-[90vw] flex-col border-l border-line bg-panel shadow-xl"
            aria-label={`Logs for ${logsServer}`}
          >
            <header className="flex items-center justify-between border-b border-line px-3 py-2">
              <div>
                <h3 className="text-[12.5px] font-semibold text-ink">{logsServer}</h3>
                <p className="text-[10.5px] text-ink-3">Connection and server stderr logs</p>
              </div>
              <button
                type="button"
                className="rounded-md px-2 py-1 text-[11.5px] text-ink-2 hover:bg-panel-2 hover:text-ink"
                onClick={closeLogs}
              >
                Close
              </button>
            </header>
            <div className="flex-1 overflow-auto px-3 py-2 font-mono text-[11px]">
              {logs.length === 0 ? (
                <p className="text-ink-3">No log entries yet.</p>
              ) : (
                logs.map((entry, index) => (
                  <p
                    key={`${entry.ts}:${index}`}
                    className={cx("whitespace-pre-wrap break-words", logTone(entry.level))}
                  >
                    <span className="text-ink-3">{formatTime(entry.ts)} </span>
                    <span className="uppercase">{entry.level}</span> {entry.message}
                  </p>
                ))
              )}
              <div ref={logEndRef} />
            </div>
          </aside>
        </div>
      ) : null}
    </section>
  );
}

export default McpStatusPanel;
