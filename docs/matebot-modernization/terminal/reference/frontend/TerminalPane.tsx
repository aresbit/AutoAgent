/**
 * Integrated terminal pane.
 *
 * Place at `frontend/src/features/terminal/TerminalPane.tsx`.
 *
 * xterm.js is loaded dynamically so the initial chat bundle stays small and no
 * server-side rendering path is required.  The component owns:
 *  - Terminal + FitAddon lifecycle;
 *  - WebSocket connect/reconnect with exponential backoff;
 *  - ResizeObserver -> fit -> server resize;
 *  - status bar (connection, cwd, shell, exit code).
 *
 * The PTY deliberately survives unmount: switching tabs or remounting replays
 * scrollback from the backend.  Only the tab close action (DELETE endpoint)
 * terminates the process group.
 */

import { useEffect, useRef, useState } from "react";
import type { IDisposable, ITheme, Terminal as XTerm } from "@xterm/xterm";
import type { FitAddon as XTermFitAddon } from "@xterm/addon-fit";
import {
  TerminalClient,
  type TerminalClientError,
  type TerminalConnectionState,
  type TerminalReadyFrame,
} from "./terminalClient";

export interface TerminalPaneProps {
  readonly sessionId: string;
  readonly tabId: string;
  readonly cwd: string;
  readonly shell: string;
  /** Called once when the child exits; `null` means the code is unknown. */
  readonly onExit?: (code: number | null) => void;
  /** Launch token for the WS query fallback; prefer the HttpOnly cookie. */
  readonly token?: string | null;
  readonly baseUrl?: string;
  readonly className?: string;
  readonly autoFocus?: boolean;
  readonly label?: string;
}

const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 10_000;
const HEARTBEAT_MS = 25_000;
const MONO_FALLBACK =
  'ui-monospace, "SFMono-Regular", "JetBrains Mono", Menlo, monospace';

const STATUS_LABEL: Record<TerminalConnectionState, string> = {
  idle: "Idle",
  connecting: "Connecting",
  ready: "Connected",
  reconnecting: "Reconnecting",
  closed: "Closed",
  error: "Error",
};

const FATAL_CLOSE_MESSAGES: Readonly<Record<number, string>> = {
  4400: "The terminal sent an invalid frame.",
  4401: "The terminal connection is not authorized.",
  4403: "The terminal origin was rejected.",
  4404: "This terminal no longer exists.",
  4409: "This terminal is already open in another view.",
  4429: "The terminal input rate limit was hit.",
};

function cssValue(
  style: CSSStyleDeclaration,
  name: string,
  fallback: string,
): string {
  const value = style.getPropertyValue(name).trim();
  return value.length > 0 ? value : fallback;
}

function readTheme(element: HTMLElement): ITheme {
  const style = getComputedStyle(element);
  // Colors come from cds/theme.css where available.  ANSI slots fall back to a
  // readable dark palette; PATCH_PLAN recommends adding --term-* tokens.
  return {
    background: cssValue(style, "--code-bg", "#161615"),
    foreground: cssValue(style, "--code-ink", "#e8e6e1"),
    cursor: cssValue(style, "--accent", "#d97757"),
    cursorAccent: cssValue(style, "--code-bg", "#161615"),
    selectionBackground: cssValue(style, "--selected", "rgba(255,255,255,0.18)"),
    black: cssValue(style, "--term-black", "#1b1b19"),
    red: cssValue(style, "--term-red", "#e06c75"),
    green: cssValue(style, "--term-green", "#98c379"),
    yellow: cssValue(style, "--term-yellow", "#e5c07b"),
    blue: cssValue(style, "--term-blue", "#61afef"),
    magenta: cssValue(style, "--term-magenta", "#c678dd"),
    cyan: cssValue(style, "--term-cyan", "#56b6c2"),
    white: cssValue(style, "--term-white", "#dcdfe4"),
    brightBlack: cssValue(style, "--term-bright-black", "#5c6370"),
    brightRed: cssValue(style, "--term-bright-red", "#ef7b85"),
    brightGreen: cssValue(style, "--term-bright-green", "#b3d68f"),
    brightYellow: cssValue(style, "--term-bright-yellow", "#f0d197"),
    brightBlue: cssValue(style, "--term-bright-blue", "#82c4ff"),
    brightMagenta: cssValue(style, "--term-bright-magenta", "#d99ae8"),
    brightCyan: cssValue(style, "--term-bright-cyan", "#7fd4df"),
    brightWhite: cssValue(style, "--term-bright-white", "#ffffff"),
  };
}

function reconnectDelay(attempt: number): number {
  const exponential = Math.min(
    RECONNECT_MAX_MS,
    RECONNECT_BASE_MS * 2 ** Math.min(attempt, 6),
  );
  return exponential + Math.floor(Math.random() * 250);
}

function isFatalCloseCode(code: number): boolean {
  return code >= 4400 && code < 4500;
}

export function TerminalPane({
  sessionId,
  tabId,
  cwd,
  shell,
  onExit,
  token,
  baseUrl,
  className,
  autoFocus = false,
  label,
}: TerminalPaneProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const clientRef = useRef<TerminalClient | null>(null);
  const onExitRef = useRef(onExit);
  const [status, setStatus] = useState<TerminalConnectionState>("idle");
  const [meta, setMeta] = useState<{ cwd: string; shell: string }>({
    cwd,
    shell,
  });
  const [exitCode, setExitCode] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    onExitRef.current = onExit;
  }, [onExit]);

  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;

    let disposed = false;
    let term: XTerm | null = null;
    let fit: XTermFitAddon | null = null;
    let observer: ResizeObserver | null = null;
    let reconnectTimer: number | null = null;
    let resizeFrame: number | null = null;
    let heartbeat: number | null = null;
    let attempt = 0;
    let generation = 0;
    let exited = false;
    let intentionalDispose = false;
    const disposables: IDisposable[] = [];

    const clearReconnect = (): void => {
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
    };

    const scheduleReconnect = (): void => {
      if (disposed || exited || intentionalDispose) return;
      if (reconnectTimer !== null) return;
      const delay = reconnectDelay(attempt);
      attempt += 1;
      setStatus("reconnecting");
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, delay);
    };

    const connect = (): void => {
      const terminal = term;
      if (disposed || terminal === null) return;

      // Supersede any previous connection callbacks.
      const currentGeneration = ++generation;
      clientRef.current?.dispose();

      setStatus(attempt === 0 ? "connecting" : "reconnecting");
      const client = new TerminalClient({
        sessionId,
        tabId,
        token,
        baseUrl,
        onOpen: () => setError(null),
        onReady: (frame: TerminalReadyFrame) => {
          if (disposed || currentGeneration !== generation) return;
          attempt = 0;
          setMeta({ cwd: frame.cwd, shell: frame.shell });
          setExitCode(frame.exitCode);
          // Replay frames follow `ready`; clear before they arrive so a
          // reconnect does not duplicate the visible transcript.
          terminal.reset();
          setStatus("ready");
        },
        onData: (text: string) => {
          if (disposed || currentGeneration !== generation) return;
          terminal.write(text);
        },
        onExit: (code: number | null) => {
          if (disposed || currentGeneration !== generation) return;
          exited = true;
          clearReconnect();
          setExitCode(code);
          setStatus("closed");
          onExitRef.current?.(code);
        },
        onError: (clientError: TerminalClientError) => {
          if (disposed || currentGeneration !== generation) return;
          setError(clientError.message);
        },
        onClose: (event: CloseEvent) => {
          if (disposed || currentGeneration !== generation) return;
          if (exited || intentionalDispose) return;
          if (isFatalCloseCode(event.code)) {
            setStatus("error");
            setError(
              FATAL_CLOSE_MESSAGES[event.code] ??
                `The terminal connection closed (${event.code}).`,
            );
            return;
          }
          scheduleReconnect();
        },
        onState: (next: TerminalConnectionState) => {
          if (disposed || currentGeneration !== generation) return;
          if (next === "ready" || next === "closed" || next === "error") {
            setStatus(next);
          }
        },
      });

      clientRef.current = client;
      void client.connect(terminal.cols, terminal.rows, true).catch(() => {
        // `onClose` schedules reconnection; this catch only prevents an
        // unhandled rejection when the socket never opens.
        if (!disposed && currentGeneration === generation) scheduleReconnect();
      });
    };

    const mount = async (): Promise<void> => {
      try {
        const [, xtermModule, fitModule] = await Promise.all([
          import("@xterm/xterm/css/xterm.css"),
          import("@xterm/xterm"),
          import("@xterm/addon-fit"),
        ]);
        if (disposed) return;
        const hostElement = hostRef.current;
        if (hostElement === null) return;

        const terminal = new xtermModule.Terminal({
          convertEol: false,
          cursorBlink: true,
          cursorStyle: "bar",
          fontFamily: MONO_FALLBACK,
          fontSize: 12.5,
          lineHeight: 1.25,
          letterSpacing: 0,
          scrollback: 5000,
          allowProposedApi: false,
          screenReaderMode: true,
          macOptionIsMeta: true,
          theme: readTheme(hostElement),
        });
        term = terminal;

        const fitAddon = new fitModule.FitAddon();
        fit = fitAddon;
        terminal.loadAddon(fitAddon);
        terminal.open(hostElement);
        terminal.textarea?.setAttribute(
          "aria-label",
          label ?? `Terminal ${tabId}`,
        );
        fitAddon.fit();

        disposables.push(
          terminal.onData((data: string) => {
            clientRef.current?.sendInput(data);
          }),
        );
        disposables.push(
          terminal.onResize(({ cols, rows }) => {
            clientRef.current?.resize(cols, rows);
          }),
        );

        observer = new ResizeObserver(() => {
          if (resizeFrame !== null) window.cancelAnimationFrame(resizeFrame);
          resizeFrame = window.requestAnimationFrame(() => {
            resizeFrame = null;
            if (!disposed) fitAddon.fit();
          });
        });
        observer.observe(hostElement);

        heartbeat = window.setInterval(() => {
          clientRef.current?.ping();
        }, HEARTBEAT_MS);

        if (autoFocus) terminal.focus();
        connect();
      } catch (mountError) {
        if (disposed) return;
        setStatus("error");
        setError(
          mountError instanceof Error
            ? mountError.message
            : "The terminal renderer could not be loaded.",
        );
      }
    };

    void mount();

    return () => {
      disposed = true;
      intentionalDispose = true;
      clearReconnect();
      if (resizeFrame !== null) {
        window.cancelAnimationFrame(resizeFrame);
        resizeFrame = null;
      }
      if (heartbeat !== null) {
        window.clearInterval(heartbeat);
        heartbeat = null;
      }
      observer?.disconnect();
      observer = null;
      for (const disposable of disposables) {
        disposable.dispose();
      }
      disposables.length = 0;
      clientRef.current?.dispose();
      clientRef.current = null;
      fit?.dispose();
      fit = null;
      term?.dispose();
      term = null;
    };
  }, [sessionId, tabId, cwd, shell, token, baseUrl, autoFocus, label]);

  const accessibleLabel = label ?? `Terminal ${tabId}`;
  const statusText = STATUS_LABEL[status];

  return (
    <section
      className={className}
      aria-label={accessibleLabel}
      data-terminal-status={status}
    >
      <div
        className="flex min-h-8 flex-none items-center gap-2 border-b border-line px-2 text-[11px] text-ink-3"
        role="status"
        aria-live="polite"
      >
        <span
          aria-hidden="true"
          className={
            status === "ready"
              ? "inline-block h-1.5 w-1.5 rounded-full bg-ok"
              : status === "error"
                ? "inline-block h-1.5 w-1.5 rounded-full bg-bad"
                : "inline-block h-1.5 w-1.5 rounded-full bg-warn"
          }
        />
        <span>{statusText}</span>
        <span className="truncate" title={meta.cwd}>
          {meta.cwd}
        </span>
        <span className="ml-auto truncate" title={meta.shell}>
          {meta.shell}
        </span>
        {exitCode !== null ? (
          <span className="t-num">exit {exitCode}</span>
        ) : null}
      </div>

      <div ref={hostRef} className="min-h-0 flex-1 overflow-hidden p-1" />

      {error !== null ? (
        <div role="alert" className="border-t border-line px-2 py-1 text-[11px] text-bad">
          {error}
        </div>
      ) : null}
    </section>
  );
}
