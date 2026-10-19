import { useEffect, useRef, useState } from "react";
import { Plus, Terminal as TerminalIcon, X } from "lucide-react";
import { api, isMockMode } from "@/api/client";
import { Button } from "@/cds";
import { cx } from "@/lib/cx";
import { errorMessage } from "@/lib/errorMessage";
import { TerminalPane } from "./TerminalPane";
import { useTerminalTabs } from "./useTerminalTabs";
import "@xterm/xterm/css/xterm.css";

function Hint({ text }: { text: string }) {
  return (
    <div className="flex h-full items-center justify-center p-6 text-center">
      <p className="max-w-[34ch] text-[11.5px] leading-relaxed text-ink-3">{text}</p>
    </div>
  );
}

/**
 * Integrated terminal panel (T0).
 *
 * The backend owns the PTY; this panel owns tab state and the xterm pane. The
 * WebSocket authenticates with the HttpOnly cookie set by `ensureSessionCookie`
 * in main.tsx, so the launch token never appears in the WS URL.
 */
export function TerminalPanel({ sessionId }: { sessionId: string | null }) {
  const tabs = useTerminalTabs(sessionId, {
    storage: typeof window === "undefined" ? null : window.localStorage,
    storageKey: "autoagent.terminals",
    defaultCwd: "~",
    maxTabs: 4,
  });
  const tabsRef = useRef(tabs.tabs);
  tabsRef.current = tabs.tabs;
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const reconciled = useRef<string | null>(null);
  const create = tabs.create;

  // Reconcile local tabs with the backend when a conversation is selected.
  useEffect(() => {
    if (!sessionId || isMockMode() || reconciled.current === sessionId) return;
    reconciled.current = sessionId;
    let cancelled = false;
    void (async () => {
      try {
        const views = await api.terminals(sessionId);
        if (cancelled) return;
        for (const view of views) {
          if (!tabsRef.current.some((tab) => tab.id === view.tabId)) {
            create({
              id: view.tabId,
              cwd: view.cwd,
              shell: view.shell,
              title: `Terminal ${view.tabId.slice(0, 4)}`,
            });
          }
        }
      } catch (cause) {
        if (!cancelled) {
          setError(errorMessage(cause, "Terminals could not be loaded."));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [create, sessionId]);

  const add = async () => {
    if (!sessionId) return;
    setBusy(true);
    setError(null);
    try {
      const view = await api.createTerminal(sessionId, {});
      create({
        id: view.tabId,
        cwd: view.cwd,
        shell: view.shell,
        title: `Terminal ${tabsRef.current.length + 1}`,
      });
    } catch (cause) {
      setError(errorMessage(cause, "The terminal could not be created."));
    } finally {
      setBusy(false);
    }
  };

  const closeTab = async (tabId: string) => {
    setError(null);
    if (sessionId) {
      try {
        await api.deleteTerminal(sessionId, tabId);
      } catch {
        // The local tab still closes; the backend reaps orphaned PTYs.
      }
    }
    tabs.close(tabId);
  };

  const active = tabs.activeTab;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="hairline-b flex items-center gap-1 overflow-x-auto px-2 py-1.5">
        {tabs.tabs.map((tab) => {
          const selected = tab.id === tabs.activeId;
          return (
            <div
              key={tab.id}
              className={cx(
                "flex flex-none items-center gap-1 rounded-md px-1.5 py-1 text-[11px]",
                selected
                  ? "bg-[var(--segmented-thumb)] text-ink shadow-thumb"
                  : "text-ink-3 hover:text-ink-2",
              )}
            >
              <button
                type="button"
                aria-selected={selected}
                onClick={() => tabs.select(tab.id)}
                className="max-w-[130px] truncate focus-visible:outline-none focus-visible:shadow-focus"
                title={tab.title}
              >
                {tab.title}
              </button>
              <button
                type="button"
                aria-label={`Close ${tab.title}`}
                onClick={() => void closeTab(tab.id)}
                className="rounded-full p-0.5 text-ink-3 hover:text-bad focus-visible:outline-none focus-visible:shadow-focus"
              >
                <X size={9} strokeWidth={2.2} />
              </button>
            </div>
          );
        })}
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="New terminal"
          onClick={() => void add()}
          disabled={busy || !sessionId}
        >
          <Plus size={12} strokeWidth={2} />
        </Button>
      </div>

      {error ? (
        <p role="alert" className="px-3 py-2 text-[10.5px] leading-relaxed text-bad">
          {error}
        </p>
      ) : null}

      <div className="min-h-0 flex-1">
        {!sessionId ? (
          <Hint text="Select a conversation to open a terminal." />
        ) : isMockMode() ? (
          <Hint text="The integrated terminal requires the local backend; mock mode is enabled." />
        ) : active ? (
          <TerminalPane
            key={active.id}
            sessionId={sessionId}
            tabId={active.id}
            cwd={active.cwd}
            shell={active.shell ?? ""}
            className="h-full"
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
            <TerminalIcon size={20} strokeWidth={1.8} className="text-ink-3" />
            <p className="text-[12px] text-ink-2">No terminal tabs yet.</p>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void add()}
              disabled={busy || !sessionId}
            >
              <Plus size={12} strokeWidth={2} />
              New terminal
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
