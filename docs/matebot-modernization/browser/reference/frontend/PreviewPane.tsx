/**
 * Browser/preview pane for the AutoAgent right-hand control panel.
 *
 * The native `WebContentsView` is drawn by Electron above the renderer, so all
 * chrome (tab strip, address bar, console, screenshot strip) lives outside the
 * `viewport` rectangle.  Nothing in this component tries to overlay the native
 * view; the visible area is reported to the main process with a ResizeObserver
 * and the native view is positioned exactly there.
 *
 * In a plain browser (`vite dev` in a tab) the preload bridge is absent and the
 * component renders an explicit unavailable state instead of an iframe.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import {
  PreviewClientError,
  createPreviewClient,
  isPreviewAddress,
  normalizePreviewBounds,
  type PreviewBounds,
  type PreviewConsoleEntry,
  type PreviewScreenshot,
  type PreviewTabState,
} from './previewClient.js';

export interface PreviewPaneProps {
  /** Created once on mount; later changes are ignored. */
  initialUrl?: string;
  /** Enable the address form. The main process still enforces its allowlist. */
  editableAddress?: boolean;
  className?: string;
  /** Optional host hook, e.g. to attach the capture to a chat message. */
  onScreenshot?: (screenshot: PreviewScreenshot) => void;
}

const MAX_RENDERED_LOGS = 200;

function describeError(error: unknown): string {
  if (error instanceof PreviewClientError) return error.message;
  if (error instanceof Error) return error.message;
  return 'Preview request failed.';
}

function tabLabel(tab: PreviewTabState): string {
  if (tab.title.trim().length > 0 && tab.title !== 'Preview') return tab.title;
  try {
    const url = new URL(tab.url);
    if (url.hostname.length > 0) return url.hostname;
  } catch {
    // about:blank and malformed transitional URLs use the fallback.
  }
  return 'New tab';
}

function tabAddress(tab: PreviewTabState): string {
  return tab.url === 'about:blank' ? 'about:blank' : tab.url;
}

export function PreviewPane({
  initialUrl,
  editableAddress = false,
  className,
  onScreenshot,
}: PreviewPaneProps) {
  const [client] = useState(() => createPreviewClient());
  const [tabs, setTabs] = useState<PreviewTabState[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [address, setAddress] = useState('');
  const [draft, setDraft] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [capture, setCapture] = useState<PreviewScreenshot | null>(null);
  const [logs, setLogs] = useState<PreviewConsoleEntry[]>([]);
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const activeIdRef = useRef<string | null>(null);
  const tabsRef = useRef<PreviewTabState[]>([]);
  const previousActiveRef = useRef<string | null>(null);
  const editingRef = useRef(false);
  const composingRef = useRef(false);

  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);

  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    void (async () => {
      try {
        const state = await client.create(initialUrl ? { url: initialUrl } : {});
        if (cancelled) {
          void client.close(state.id).catch(() => undefined);
          return;
        }
        setTabs((current) => (current.some((tab) => tab.id === state.id) ? current : [...current, state]));
        activeIdRef.current = state.id;
        setActiveId(state.id);
        setAddress(tabAddress(state));
        setDraft(tabAddress(state));
      } catch (error) {
        if (!cancelled) setNotice(describeError(error));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [client, initialUrl]);

  // Close every tab owned by this pane when it unmounts.
  useEffect(() => {
    if (!client) return;
    return () => {
      const owned = tabsRef.current;
      tabsRef.current = [];
      for (const tab of owned) {
        void client.close(tab.id).catch(() => undefined);
      }
    };
  }, [client]);

  useEffect(() => {
    if (!client) return;
    return client.onEvent((event) => {
      switch (event.type) {
        case 'state': {
          const next = event.state;
          setTabs((current) => {
            if (current.some((tab) => tab.id === next.id)) {
              return current.map((tab) => (tab.id === next.id ? next : tab));
            }
            return [...current, next];
          });
          if (activeIdRef.current === next.id) {
            setAddress(tabAddress(next));
            if (!editingRef.current) setDraft(tabAddress(next));
          }
          break;
        }
        case 'closed': {
          const remaining = tabsRef.current.filter((tab) => tab.id !== event.tabId);
          tabsRef.current = remaining;
          setTabs(remaining);
          if (activeIdRef.current === event.tabId) {
            const next = remaining[0]?.id ?? null;
            activeIdRef.current = next;
            setActiveId(next);
          }
          break;
        }
        case 'console': {
          if (activeIdRef.current === event.entry.tabId) {
            setLogs((current) => [...current, event.entry].slice(-MAX_RENDERED_LOGS));
          }
          break;
        }
        case 'blocked-navigation': {
          setNotice(`Navigation blocked (${event.reason}): ${event.url}`);
          break;
        }
        case 'external-open': {
          setNotice('The page requested a popup. Use "Open" to launch it in the system browser.');
          break;
        }
        case 'download': {
          setNotice(
            event.state === 'denied'
              ? `Download denied: ${event.filename}`
              : `Download ${event.state}: ${event.filename}`,
          );
          break;
        }
        default:
          break;
      }
    });
  }, [client]);

  const sendBounds = useCallback(() => {
    const element = viewportRef.current;
    const tabId = activeIdRef.current;
    if (!client || !element || !tabId) return;
    const rect = element.getBoundingClientRect();
    const bounds: PreviewBounds = normalizePreviewBounds({
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height,
    });
    void client.setBounds(tabId, bounds).catch(() => undefined);
  }, [client]);

  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    let frame = 0;
    const schedule = (): void => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(sendBounds);
    };
    const observer = new ResizeObserver(schedule);
    observer.observe(element);
    window.addEventListener('resize', schedule);
    schedule();
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', schedule);
      cancelAnimationFrame(frame);
    };
  }, [sendBounds]);

  useEffect(() => {
    if (!client || !activeId) return;
    const previous = previousActiveRef.current;
    previousActiveRef.current = activeId;
    let cancelled = false;
    void (async () => {
      try {
        if (previous && previous !== activeId) {
          // The previous tab may have been closed; never let that block the
          // new active tab from being shown.
          await client.hide(previous).catch(() => undefined);
        }
        if (cancelled) return;
        await client.show(activeId);
        await client.focus(activeId);
        sendBounds();
      } catch (error) {
        if (!cancelled) setNotice(describeError(error));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeId, client, sendBounds]);

  const createTab = useCallback(async () => {
    if (!client) return;
    setBusy(true);
    try {
      const state = await client.create({});
      setTabs((current) => [...current, state]);
      setActiveId(state.id);
      activeIdRef.current = state.id;
      setNotice(null);
    } catch (error) {
      setNotice(describeError(error));
    } finally {
      setBusy(false);
    }
  }, [client]);

  const closeTab = useCallback(
    async (tabId: string) => {
      if (!client) return;
      try {
        await client.close(tabId);
      } catch (error) {
        setNotice(describeError(error));
      }
    },
    [client],
  );

  const navigateTo = useCallback(
    async (value: string) => {
      if (!client || !activeId) return;
      const target = value.trim();
      if (!isPreviewAddress(target)) {
        setNotice('Enter an https:// or autoagent-preview:// address.');
        return;
      }
      setBusy(true);
      try {
        const state = await client.navigate(activeId, target);
        setAddress(tabAddress(state));
        setDraft(tabAddress(state));
        setNotice(null);
      } catch (error) {
        setNotice(describeError(error));
      } finally {
        setBusy(false);
      }
    },
    [activeId, client],
  );

  const history = useCallback(
    async (direction: 'back' | 'forward') => {
      if (!client || !activeId) return;
      try {
        const state =
          direction === 'back' ? await client.back(activeId) : await client.forward(activeId);
        setAddress(tabAddress(state));
      } catch (error) {
        setNotice(describeError(error));
      }
    },
    [activeId, client],
  );

  const reload = useCallback(async () => {
    if (!client || !activeId) return;
    try {
      const state = await client.reload(activeId);
      setAddress(tabAddress(state));
      setNotice(null);
    } catch (error) {
      setNotice(describeError(error));
    }
  }, [activeId, client]);

  const takeScreenshot = useCallback(async () => {
    if (!client || !activeId) return;
    setBusy(true);
    try {
      const shot = await client.screenshot(activeId, true);
      if (shot) {
        setCapture(shot);
        onScreenshot?.(shot);
      } else {
        setNotice('No visual change since the last capture.');
      }
    } catch (error) {
      setNotice(describeError(error));
    } finally {
      setBusy(false);
    }
  }, [activeId, client, onScreenshot]);

  const openExternal = useCallback(async () => {
    if (!client || !activeId) return;
    const url = address;
    try {
      await client.openExternal(activeId, url);
    } catch (error) {
      setNotice(describeError(error));
    }
  }, [activeId, address, client]);

  const toggleConsole = useCallback(() => {
    const next = !consoleOpen;
    setConsoleOpen(next);
    if (next && client && activeId) {
      void client
        .logs(activeId, { limit: MAX_RENDERED_LOGS })
        .then((entries) => setLogs(entries))
        .catch((error: unknown) => setNotice(describeError(error)));
    }
  }, [activeId, client, consoleOpen]);

  const submitAddress = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (composingRef.current) return;
      void navigateTo(draft);
    },
    [draft, navigateTo],
  );

  if (!client) {
    return (
      <div
        className={`flex h-full items-center justify-center p-6 text-center text-[12px] text-neutral-400 ${className ?? ''}`}
        role="status"
      >
        Preview is available in the AutoAgent desktop shell only.
      </div>
    );
  }

  const active = tabs.find((tab) => tab.id === activeId) ?? null;
  const addressDisabled = busy || !active;

  return (
    <section className={`flex h-full min-h-0 flex-col bg-neutral-950 text-neutral-200 ${className ?? ''}`}>
      <div className="flex items-center gap-1 overflow-x-auto border-b border-white/10 px-2 py-1" role="tablist" aria-label="Preview tabs">
        {tabs.map((tab) => {
          const selected = tab.id === activeId;
          return (
            <div
              key={tab.id}
              className={`flex shrink-0 items-center gap-1 rounded px-2 py-1 text-[11px] ${
                selected ? 'bg-white/10 text-white' : 'text-neutral-400 hover:bg-white/5'
              }`}
            >
              <button
                type="button"
                role="tab"
                aria-selected={selected}
                aria-controls="preview-viewport"
                className="max-w-[160px] truncate"
                title={tabAddress(tab)}
                onClick={() => setActiveId(tab.id)}
              >
                {tabLabel(tab)}
              </button>
              <button
                type="button"
                aria-label={`Close ${tabLabel(tab)}`}
                className="rounded px-1 text-neutral-500 hover:bg-white/10 hover:text-white"
                onClick={() => {
                  void closeTab(tab.id);
                }}
              >
                x
              </button>
            </div>
          );
        })}
        <button
          type="button"
          aria-label="New preview tab"
          disabled={busy}
          className="shrink-0 rounded px-2 py-1 text-[13px] text-neutral-400 hover:bg-white/5 hover:text-white disabled:opacity-40"
          onClick={() => {
            void createTab();
          }}
        >
          +
        </button>
      </div>

      <div className="flex items-center gap-1 border-b border-white/10 px-2 py-1">
        <button
          type="button"
          className="rounded px-2 py-1 text-[11px] hover:bg-white/10 disabled:opacity-40"
          disabled={!active?.canGoBack}
          onClick={() => {
            void history('back');
          }}
        >
          Back
        </button>
        <button
          type="button"
          className="rounded px-2 py-1 text-[11px] hover:bg-white/10 disabled:opacity-40"
          disabled={!active?.canGoForward}
          onClick={() => {
            void history('forward');
          }}
        >
          Forward
        </button>
        <button
          type="button"
          className="rounded px-2 py-1 text-[11px] hover:bg-white/10 disabled:opacity-40"
          disabled={!active}
          onClick={() => {
            void reload();
          }}
        >
          Reload
        </button>

        {active?.loading ? (
          <span
            className="px-1 text-[10px] text-sky-300"
            role="status"
            aria-live="polite"
          >
            Loading
          </span>
        ) : null}

        {editableAddress ? (
          <form className="min-w-0 flex-1" onSubmit={submitAddress}>
            <input
              aria-label="Preview address"
              className="w-full rounded border border-white/10 bg-black/40 px-2 py-1 text-[11px] text-neutral-200 outline-none focus:border-white/30"
              value={draft}
              spellCheck={false}
              autoComplete="off"
              disabled={addressDisabled}
              onCompositionStart={() => {
                composingRef.current = true;
              }}
              onCompositionEnd={() => {
                composingRef.current = false;
              }}
              onKeyDown={(event) => {
                if (
                  event.key === 'Enter' &&
                  (event.nativeEvent.isComposing || composingRef.current)
                ) {
                  // IME confirmation Enter must not submit the address form.
                  event.preventDefault();
                }
              }}
              onFocus={() => {
                editingRef.current = true;
              }}
              onBlur={() => {
                editingRef.current = false;
              }}
              onChange={(event) => setDraft(event.target.value)}
            />
          </form>
        ) : (
          <div
            className="min-w-0 flex-1 truncate rounded border border-white/5 bg-black/30 px-2 py-1 text-[11px] text-neutral-400"
            title={address}
          >
            {address || 'about:blank'}
          </div>
        )}

        <button
          type="button"
          className="rounded px-2 py-1 text-[11px] hover:bg-white/10 disabled:opacity-40"
          disabled={busy || !active}
          onClick={() => {
            void takeScreenshot();
          }}
        >
          Screenshot
        </button>
        <button
          type="button"
          className="rounded px-2 py-1 text-[11px] hover:bg-white/10 disabled:opacity-40"
          disabled={!active}
          onClick={() => {
            void openExternal();
          }}
        >
          Open
        </button>
        <button
          type="button"
          aria-pressed={consoleOpen}
          className="rounded px-2 py-1 text-[11px] hover:bg-white/10"
          onClick={toggleConsole}
        >
          Logs{logs.length > 0 ? ` (${logs.length})` : ''}
        </button>
      </div>

      {notice ? (
        <div className="flex items-start justify-between gap-2 border-b border-amber-500/20 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-200" role="status">
          <span className="min-w-0 break-all">{notice}</span>
          <button
            type="button"
            className="shrink-0 rounded px-1 text-amber-300 hover:bg-white/10"
            onClick={() => setNotice(null)}
          >
            Dismiss
          </button>
        </div>
      ) : null}

      {active?.error ? (
        <div className="border-b border-red-500/20 bg-red-500/10 px-2 py-1 text-[11px] text-red-200" role="alert">
          Load failed ({active.error.code}): {active.error.description}
        </div>
      ) : null}
      {active?.crashed ? (
        <div className="border-b border-red-500/20 bg-red-500/10 px-2 py-1 text-[11px] text-red-200" role="alert">
          The preview renderer crashed. Reload to recover.
        </div>
      ) : null}

      {/* The native WebContentsView is positioned exactly over this element. */}
      <div
        ref={viewportRef}
        id="preview-viewport"
        role="tabpanel"
        aria-label="Preview viewport"
        className="relative min-h-[120px] flex-1 bg-neutral-900"
      >
        {!active ? (
          <div className="flex h-full items-center justify-center text-[12px] text-neutral-500">
            Open a tab to preview a local artifact or an allowlisted site.
          </div>
        ) : null}
      </div>

      {capture ? (
        <aside className="flex items-center gap-3 border-t border-white/10 bg-black/40 px-2 py-1.5" aria-label="Screenshot result">
          <img
            src={capture.dataUrl}
            alt="Preview screenshot"
            className="h-14 w-auto max-w-[160px] rounded border border-white/10 object-contain"
          />
          <span className="text-[10px] text-neutral-400">
            {capture.width}x{capture.height} PNG, {Math.round(capture.byteLength / 1024)} KiB
          </span>
          <a
            className="rounded px-2 py-1 text-[11px] text-sky-300 hover:bg-white/10"
            href={capture.dataUrl}
            download={`preview-${capture.capturedAt}.png`}
          >
            Save PNG
          </a>
          <button
            type="button"
            className="rounded px-2 py-1 text-[11px] text-neutral-400 hover:bg-white/10"
            onClick={() => setCapture(null)}
          >
            Dismiss
          </button>
        </aside>
      ) : null}

      {consoleOpen ? (
        <div className="max-h-48 overflow-auto border-t border-white/10 bg-black/50 px-2 py-1 font-mono text-[10px]" aria-label="Preview console">
          {logs.length === 0 ? (
            <p className="py-2 text-neutral-500">No console messages.</p>
          ) : (
            logs.map((entry, index) => (
              <div
                key={`${entry.timestamp}:${index}`}
                className={
                  entry.level === 'error'
                    ? 'text-red-300'
                    : entry.level === 'warning'
                      ? 'text-amber-300'
                      : 'text-neutral-400'
                }
              >
                <span className="text-neutral-600">{entry.level}</span>{' '}
                <span className="break-all">{entry.message}</span>{' '}
                <span className="text-neutral-600">
                  {entry.sourceId}:{entry.lineNumber}
                </span>
              </div>
            ))
          )}
        </div>
      ) : null}
    </section>
  );
}
