import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { api, type ServerEvent } from "./client";

export interface QueryInvalidator {
  invalidateQueries: (filters: { queryKey: readonly unknown[] }) => unknown;
}

export interface EventTarget {
  sessionId: string | null;
  client: QueryInvalidator;
}

/**
 * Map cross-cutting `/api/events` names to React Query invalidations.
 * `artifacts.changed` refreshes the artifact list, any open content/versions
 * views and the active session transcript.
 */
export function handleGlobalEvent(event: ServerEvent, target: EventTarget): readonly unknown[][] {
  const keys: unknown[][] = [];
  if (event.name === "artifacts.changed") {
    keys.push(["artifacts"], ["artifact-content"], ["artifact-versions"]);
    if (target.sessionId) keys.push(["session", target.sessionId]);
  } else if (event.name === "engine.status") {
    keys.push(["engine"]);
  } else if (event.name === "sessions.changed") {
    keys.push(["sessions"]);
  } else if (
    event.name === "mcp.status" ||
    event.name === "mcp.tools_changed" ||
    event.name === "mcp.server_changed"
  ) {
    keys.push(["mcp"], ["mcp-status"]);
  } else if (
    event.name === "mcp.approval_required" ||
    event.name === "mcp.approval_denied"
  ) {
    keys.push(["mcp-approvals"]);
  }
  for (const queryKey of keys) {
    void target.client.invalidateQueries({ queryKey });
  }
  return keys;
}

/**
 * Authenticated SSE via fetch (EventSource cannot send the launch token).
 * Reconnects with capped exponential backoff; the parser lives in ./sse.
 */
export function useServerEvents(activeSessionId: string | null): void {
  const queryClient = useQueryClient();
  const sessionRef = useRef(activeSessionId);

  useEffect(() => {
    sessionRef.current = activeSessionId;
  }, [activeSessionId]);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    let attempt = 0;

    const schedule = () => {
      if (stopped) return;
      attempt += 1;
      const delay = Math.min(30_000, 1_000 * 2 ** Math.min(attempt, 5));
      timer = setTimeout(connect, delay);
    };

    const connect = () => {
      if (stopped) return;
      api
        .streamEvents((event) => {
          attempt = 0;
          handleGlobalEvent(event, {
            sessionId: sessionRef.current,
            client: queryClient,
          });
        }, controller.signal)
        .then(() => {
          if (!stopped) schedule();
        })
        .catch(() => {
          if (!stopped) schedule();
        });
    };

    connect();
    return () => {
      stopped = true;
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [queryClient]);
}
