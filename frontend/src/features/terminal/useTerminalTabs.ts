/**
 * Terminal tab state for one conversation.
 *
 * - Stable ids are generated once and survive re-renders/reconnects.
 * - Snapshots are kept in memory per session and optionally mirrored to
 *   localStorage (best effort; private mode/quota errors are ignored).
 * - This hook owns UI state only.  The panel creates the backend tab first with
 *   `POST /api/sessions/{id}/terminals`, then calls `create({ id: view.tabId,
 *   cwd: view.cwd, shell: view.shell })` so the local id is the server id.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export interface TerminalTab {
  readonly id: string;
  readonly title: string;
  readonly cwd: string;
  readonly shell?: string;
}

export interface TerminalTabsView {
  readonly tabs: readonly TerminalTab[];
  readonly activeId: string | null;
}

export interface UseTerminalTabsOptions {
  /** Storage abstraction; pass `null` to disable persistence. */
  readonly storage?: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
  /** Prefix for per-session keys. */
  readonly storageKey?: string;
  /** Used when `create()` is called without a cwd. */
  readonly defaultCwd?: string;
  readonly maxTabs?: number;
}

export interface TerminalTabInput {
  /** Server-generated tab id (from POST /terminals).  Omit for a local id. */
  readonly id?: string;
  readonly cwd?: string;
  readonly shell?: string;
  readonly title?: string;
}

export interface UseTerminalTabsResult extends TerminalTabsView {
  readonly activeTab: TerminalTab | null;
  create: (input?: TerminalTabInput) => TerminalTab | null;
  close: (tabId: string) => void;
  select: (tabId: string) => void;
  rename: (tabId: string, title: string) => void;
  updateCwd: (tabId: string, cwd: string) => void;
  clear: () => void;
}

interface InternalState extends TerminalTabsView {
  readonly sessionId: string | null;
}

const DEFAULT_STORAGE_KEY = "autoagent.terminal.tabs.v1";
const DEFAULT_MAX_TABS = 8;
const TITLE_LIMIT = 80;

let fallbackCounter = 0;

function makeTabId(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === "function") {
    return `term-${cryptoApi.randomUUID()}`;
  }
  fallbackCounter += 1;
  return `term-${Date.now().toString(36)}-${fallbackCounter.toString(36)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function emptyState(sessionId: string | null): InternalState {
  return { sessionId, tabs: [], activeId: null };
}

function parseTab(value: unknown): TerminalTab | null {
  if (!isRecord(value)) return null;
  const id = value["id"];
  const title = value["title"];
  const cwd = value["cwd"];
  const shell = value["shell"];
  if (typeof id !== "string" || id.length === 0) return null;
  if (typeof title !== "string") return null;
  if (typeof cwd !== "string") return null;
  if (shell !== undefined && typeof shell !== "string") return null;
  return shell === undefined
    ? { id, title, cwd }
    : { id, title, cwd, shell };
}

function parseState(value: unknown, sessionId: string): InternalState {
  if (!isRecord(value)) return emptyState(sessionId);
  const rawTabs = value["tabs"];
  if (!Array.isArray(rawTabs)) return emptyState(sessionId);

  const seen = new Set<string>();
  const tabs: TerminalTab[] = [];
  for (const raw of rawTabs) {
    const tab = parseTab(raw);
    if (tab === null || seen.has(tab.id)) continue;
    seen.add(tab.id);
    tabs.push(tab);
  }

  const rawActive = value["activeId"];
  let activeId =
    typeof rawActive === "string" && seen.has(rawActive) ? rawActive : null;
  if (activeId === null && tabs.length > 0) {
    activeId = tabs[0]?.id ?? null;
  }
  return { sessionId, tabs, activeId };
}

function storageKeyFor(prefix: string, sessionId: string): string {
  return `${prefix}:${sessionId}`;
}

function loadState(
  sessionId: string | null,
  storage: UseTerminalTabsOptions["storage"],
  prefix: string,
): InternalState {
  if (sessionId === null || !storage) return emptyState(sessionId);
  try {
    const raw = storage.getItem(storageKeyFor(prefix, sessionId));
    if (raw === null) return emptyState(sessionId);
    const parsed: unknown = JSON.parse(raw);
    return parseState(parsed, sessionId);
  } catch {
    return emptyState(sessionId);
  }
}

function saveState(
  sessionId: string | null,
  state: InternalState,
  storage: UseTerminalTabsOptions["storage"],
  prefix: string,
): void {
  if (sessionId === null || !storage || state.sessionId !== sessionId) return;
  try {
    storage.setItem(
      storageKeyFor(prefix, sessionId),
      JSON.stringify({ tabs: state.tabs, activeId: state.activeId }),
    );
  } catch {
    // Quota or private-mode failures must not break terminal usage.
  }
}

/**
 * Manage tabs for `sessionId`.
 *
 * Pre: `sessionId` is stable while a terminal is mounted; switching sessions
 *      snapshots the previous tabs and loads the next session's snapshot.
 * Post: `activeId` is either `null` or the id of a tab in `tabs`.
 */
export function useTerminalTabs(
  sessionId: string | null,
  options: UseTerminalTabsOptions = {},
): UseTerminalTabsResult {
  const storage =
    options.storage !== undefined
      ? options.storage
      : typeof window !== "undefined"
        ? window.localStorage
        : null;
  const prefix = options.storageKey ?? DEFAULT_STORAGE_KEY;
  const defaultCwd = options.defaultCwd ?? "";
  const maxTabs = Math.max(1, options.maxTabs ?? DEFAULT_MAX_TABS);

  const [state, setState] = useState<InternalState>(() =>
    loadState(sessionId, storage, prefix),
  );
  const latestState = useRef<InternalState>(state);
  const loadedSession = useRef<string | null>(sessionId);
  // In-memory mirror: keeps tabs when localStorage is unavailable and makes
  // session switches instant even when persistence is disabled.
  const memory = useRef(new Map<string, InternalState>());

  // Persist the latest committed snapshot.  (Never write in a state updater:
  // StrictMode may invoke updaters twice.)
  useEffect(() => {
    latestState.current = state;
    if (state.sessionId !== null) {
      memory.current.set(state.sessionId, state);
    }
    saveState(state.sessionId, state, storage, prefix);
  }, [state, storage, prefix]);

  // Session switch: save the outgoing snapshot (already persisted) and load
  // the incoming one, preferring the in-memory mirror.
  useEffect(() => {
    if (loadedSession.current === sessionId) return;
    loadedSession.current = sessionId;
    const next =
      sessionId === null
        ? emptyState(null)
        : (memory.current.get(sessionId) ??
          loadState(sessionId, storage, prefix));
    latestState.current = next;
    setState(next);
  }, [sessionId, storage, prefix]);

  const visible: InternalState =
    state.sessionId === sessionId ? state : emptyState(sessionId);

  const activeTab = useMemo(
    () => visible.tabs.find((tab) => tab.id === visible.activeId) ?? null,
    [visible.tabs, visible.activeId],
  );

  const create = useCallback(
    (input: TerminalTabInput = {}): TerminalTab | null => {
      if (sessionId === null) return null;
      const current = latestState.current;
      if (current.sessionId !== sessionId || current.tabs.length >= maxTabs) {
        return null;
      }

      const id = input.id ?? makeTabId();
      if (current.tabs.some((tab) => tab.id === id)) return null;
      const title = input.title?.trim().slice(0, TITLE_LIMIT);
      const tab: TerminalTab = {
        id,
        title: title && title.length > 0 ? title : `Terminal ${current.tabs.length + 1}`,
        cwd: input.cwd ?? defaultCwd,
        ...(input.shell ? { shell: input.shell } : {}),
      };

      setState((prev) => {
        if (
          prev.sessionId !== sessionId ||
          prev.tabs.length >= maxTabs ||
          prev.tabs.some((existing) => existing.id === id)
        ) {
          return prev;
        }
        const tabs = [...prev.tabs, tab];
        return { sessionId, tabs, activeId: tab.id };
      });
      return tab;
    },
    [sessionId, defaultCwd, maxTabs],
  );

  const close = useCallback(
    (tabId: string): void => {
      setState((prev) => {
        if (prev.sessionId !== sessionId) return prev;
        const index = prev.tabs.findIndex((tab) => tab.id === tabId);
        if (index < 0) return prev;
        const tabs = prev.tabs.filter((tab) => tab.id !== tabId);
        const activeId =
          prev.activeId === tabId
            ? (tabs[Math.min(index, tabs.length - 1)]?.id ?? null)
            : prev.activeId;
        return { ...prev, tabs, activeId };
      });
    },
    [sessionId],
  );

  const select = useCallback(
    (tabId: string): void => {
      setState((prev) => {
        if (prev.sessionId !== sessionId) return prev;
        if (!prev.tabs.some((tab) => tab.id === tabId)) return prev;
        return { ...prev, activeId: tabId };
      });
    },
    [sessionId],
  );

  const rename = useCallback(
    (tabId: string, title: string): void => {
      const clean = title.trim().slice(0, TITLE_LIMIT);
      if (clean.length === 0) return;
      setState((prev) => {
        if (prev.sessionId !== sessionId) return prev;
        return {
          ...prev,
          tabs: prev.tabs.map((tab) =>
            tab.id === tabId ? { ...tab, title: clean } : tab,
          ),
        };
      });
    },
    [sessionId],
  );

  const updateCwd = useCallback(
    (tabId: string, cwd: string): void => {
      setState((prev) => {
        if (prev.sessionId !== sessionId) return prev;
        return {
          ...prev,
          tabs: prev.tabs.map((tab) =>
            tab.id === tabId ? { ...tab, cwd } : tab,
          ),
        };
      });
    },
    [sessionId],
  );

  const clear = useCallback((): void => {
    setState(emptyState(sessionId));
    if (sessionId !== null) {
      memory.current.delete(sessionId);
    }
    if (sessionId !== null && storage) {
      try {
        storage.removeItem(storageKeyFor(prefix, sessionId));
      } catch {
        // ignore
      }
    }
  }, [sessionId, storage, prefix]);

  return {
    tabs: visible.tabs,
    activeId: visible.activeId,
    activeTab,
    create,
    close,
    select,
    rename,
    updateCwd,
    clear,
  };
}
