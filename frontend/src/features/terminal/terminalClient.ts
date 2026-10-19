/**
 * Typed WebSocket client for AutoAgent terminals.
 *
 * Wire contract (JSON text frames):
 *   client -> server: init | input | resize | close | ping
 *   server -> client: ready | data | exit | error | pong
 *
 * The client validates every server frame at runtime.  It does not use base64:
 * PTY output is UTF-8 text, decoded incrementally by the backend.
 *
 * Reconnection policy lives in the React component so this class stays a
 * deterministic transport.  Input typed before `ready` is buffered here (the
 * reference renderer does the same) and flushed in order.
 */

export type TerminalState = "starting" | "running" | "exited";

export type TerminalConnectionState =
  | "idle"
  | "connecting"
  | "ready"
  | "reconnecting"
  | "closed"
  | "error";

export interface TerminalReadyFrame {
  type: "ready";
  tabId: string;
  sessionId: string;
  shell: string;
  cwd: string;
  cols: number;
  rows: number;
  state: TerminalState;
  exitCode: number | null;
  replayBytes: number;
  seq?: number;
}

export interface TerminalDataFrame {
  type: "data";
  data: string;
  replay?: boolean;
  seq?: number;
}

export interface TerminalExitFrame {
  type: "exit";
  code: number | null;
  signal?: number | null;
  seq?: number;
}

export interface TerminalErrorFrame {
  type: "error";
  code: string;
  message: string;
  seq?: number;
}

export interface TerminalPongFrame {
  type: "pong";
  ts: number;
  seq?: number;
}

export type ServerFrame =
  | TerminalReadyFrame
  | TerminalDataFrame
  | TerminalExitFrame
  | TerminalErrorFrame
  | TerminalPongFrame;

export type ClientFrame =
  | { type: "init"; cols: number; rows: number; replay: boolean }
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number }
  | { type: "close" }
  | { type: "ping" };

export class TerminalClientError extends Error {
  readonly code: string;
  readonly fatal: boolean;

  constructor(code: string, message: string, fatal = false) {
    super(message);
    this.name = "TerminalClientError";
    this.code = code;
    this.fatal = fatal;
  }
}

const MAX_INPUT_CHARS = 64 * 1024;
const MAX_PENDING_CHARS = 64 * 1024;
const DEFAULT_READY_TIMEOUT_MS = 10_000;
const TERMINAL_STATES: ReadonlySet<string> = new Set([
  "starting",
  "running",
  "exited",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(
  record: Record<string, unknown>,
  key: string,
): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw new TerminalClientError(
      "PROTOCOL",
      `frame field "${key}" must be a string`,
      true,
    );
  }
  return value;
}

function requireInt(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new TerminalClientError(
      "PROTOCOL",
      `frame field "${key}" must be an integer`,
      true,
    );
  }
  return value;
}

function optionalInt(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new TerminalClientError(
      "PROTOCOL",
      `frame field "${key}" must be an integer`,
      true,
    );
  }
  return value;
}

function optionalBool(
  record: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") {
    throw new TerminalClientError(
      "PROTOCOL",
      `frame field "${key}" must be a boolean`,
      true,
    );
  }
  return value;
}

function nullableInt(
  record: Record<string, unknown>,
  key: string,
): number | null {
  const value = record[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new TerminalClientError(
      "PROTOCOL",
      `frame field "${key}" must be an integer or null`,
      true,
    );
  }
  return value;
}

/**
 * Parse and validate one server frame.
 *
 * Post: returns a typed frame; returns `null` for an unknown frame type so a
 *       newer backend can add frames without breaking older renderers.
 * Raises: `TerminalClientError` (fatal) for malformed JSON or fields.
 */
export function parseServerFrame(raw: string): ServerFrame | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new TerminalClientError("PROTOCOL", "invalid JSON frame", true);
  }

  if (!isRecord(parsed)) {
    throw new TerminalClientError("PROTOCOL", "frame must be an object", true);
  }

  const type = parsed["type"];
  if (typeof type !== "string") {
    throw new TerminalClientError("PROTOCOL", "frame type is missing", true);
  }

  switch (type) {
    case "ready": {
      const state = requireString(parsed, "state");
      if (!TERMINAL_STATES.has(state)) {
        throw new TerminalClientError(
          "PROTOCOL",
          "unknown terminal state",
          true,
        );
      }
      return {
        type: "ready",
        tabId: requireString(parsed, "tabId"),
        sessionId: requireString(parsed, "sessionId"),
        shell: requireString(parsed, "shell"),
        cwd: requireString(parsed, "cwd"),
        cols: requireInt(parsed, "cols"),
        rows: requireInt(parsed, "rows"),
        state: state as TerminalState,
        exitCode: nullableInt(parsed, "exitCode"),
        replayBytes: requireInt(parsed, "replayBytes"),
        seq: optionalInt(parsed, "seq"),
      };
    }
    case "data":
      return {
        type: "data",
        data: requireString(parsed, "data"),
        replay: optionalBool(parsed, "replay"),
        seq: optionalInt(parsed, "seq"),
      };
    case "exit":
      return {
        type: "exit",
        code: nullableInt(parsed, "code"),
        signal: optionalInt(parsed, "signal") ?? null,
        seq: optionalInt(parsed, "seq"),
      };
    case "error":
      return {
        type: "error",
        code: requireString(parsed, "code"),
        message: requireString(parsed, "message"),
        seq: optionalInt(parsed, "seq"),
      };
    case "pong":
      return {
        type: "pong",
        ts: requireInt(parsed, "ts"),
        seq: optionalInt(parsed, "seq"),
      };
    default:
      return null;
  }
}

export interface TerminalClientOptions {
  sessionId: string;
  tabId: string;
  /** Launch token.  Prefer cookie auth; this is the fallback query parameter. */
  token?: string | null;
  /** Defaults to `window.location.origin` (same-origin, loopback). */
  baseUrl?: string;
  onOpen?: () => void;
  onReady?: (frame: TerminalReadyFrame) => void;
  onData?: (text: string, frame: TerminalDataFrame) => void;
  onExit?: (code: number | null, frame: TerminalExitFrame) => void;
  onError?: (error: TerminalClientError) => void;
  onClose?: (event: CloseEvent) => void;
  onState?: (state: TerminalConnectionState) => void;
  readyTimeoutMs?: number;
}

/**
 * One terminal WebSocket.  Invariants:
 *  - at most one socket per instance;
 *  - `sendInput` never throws while disconnected; it buffers up to 64 KiB;
 *  - `dispose()` never sends `close` (the backend keeps the PTY for reconnect).
 */
export class TerminalClient {
  private readonly options: TerminalClientOptions;
  private socket: WebSocket | null = null;
  private state: TerminalConnectionState = "idle";
  private closedByUser = false;
  private disposed = false;
  private initCols = 80;
  private initRows = 24;
  private initReplay = true;
  private pending: string[] = [];
  private pendingChars = 0;
  private readyTimer: number | null = null;
  private resolveReady: ((frame: TerminalReadyFrame) => void) | null = null;
  private rejectReady: ((error: Error) => void) | null = null;

  constructor(options: TerminalClientOptions) {
    this.options = options;
  }

  get connectionState(): TerminalConnectionState {
    return this.state;
  }

  /**
   * Open the socket and resolve on the server's `ready` frame.
   *
   * Pre: browser environment with `WebSocket`.
   * Post: on success the server has accepted `init`; on failure the promise
   *       rejects and `onClose` also fires (unless `dispose` was called).
   */
  connect(cols = 80, rows = 24, replay = true): Promise<TerminalReadyFrame> {
    if (this.disposed) {
      return Promise.reject(
        new TerminalClientError("DISPOSED", "client was disposed"),
      );
    }
    if (typeof WebSocket === "undefined" || typeof window === "undefined") {
      return Promise.reject(
        new TerminalClientError(
          "UNSUPPORTED",
          "WebSocket is not available in this environment",
        ),
      );
    }
    if (
      this.socket !== null &&
      (this.socket.readyState === WebSocket.OPEN ||
        this.socket.readyState === WebSocket.CONNECTING)
    ) {
      return Promise.reject(
        new TerminalClientError("ALREADY_OPEN", "socket is already open"),
      );
    }

    this.initCols = clampDimension(cols, 80);
    this.initRows = clampDimension(rows, 24);
    this.initReplay = replay;
    this.closedByUser = false;
    this.setState("connecting");

    return new Promise<TerminalReadyFrame>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;

      const socket = new WebSocket(this.url());
      this.socket = socket;

      const timeoutMs =
        this.options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
      this.readyTimer = window.setTimeout(() => {
        this.readyTimer = null;
        this.settleReady(
          new TerminalClientError(
            "READY_TIMEOUT",
            "the terminal did not become ready",
          ),
        );
        socket.close(4000, "ready timeout");
      }, timeoutMs);

      socket.addEventListener("open", () => {
        if (this.disposed) {
          socket.close(1000, "disposed");
          return;
        }
        this.options.onOpen?.();
        this.sendRaw({
          type: "init",
          cols: this.initCols,
          rows: this.initRows,
          replay: this.initReplay,
        });
      });

      socket.addEventListener("message", (event: MessageEvent) => {
        this.handleMessage(event);
      });

      socket.addEventListener("error", () => {
        this.report(
          new TerminalClientError(
            "SOCKET_ERROR",
            "the terminal connection failed",
          ),
        );
      });

      socket.addEventListener("close", (event: CloseEvent) => {
        this.handleClose(event);
      });
    });
  }

  /** Queue or send terminal input.  Returns false when the payload is too big. */
  sendInput(data: string): boolean {
    if (this.disposed || data.length === 0) return true;
    if (data.length > MAX_INPUT_CHARS) {
      this.report(
        new TerminalClientError(
          "INPUT_TOO_LARGE",
          "terminal input is limited to 64 KiB per frame",
        ),
      );
      return false;
    }

    if (this.canSend()) {
      this.sendRaw({ type: "input", data });
      return true;
    }

    this.pending.push(data);
    this.pendingChars += data.length;
    while (this.pendingChars > MAX_PENDING_CHARS && this.pending.length > 0) {
      const dropped = this.pending.shift();
      this.pendingChars -= dropped?.length ?? 0;
    }
    return true;
  }

  /** Send a resize; before `ready` it updates the pending `init` size. */
  resize(cols: number, rows: number): void {
    const safeCols = clampDimension(cols, this.initCols);
    const safeRows = clampDimension(rows, this.initRows);
    this.initCols = safeCols;
    this.initRows = safeRows;
    if (!this.canSend()) return;
    this.sendRaw({ type: "resize", cols: safeCols, rows: safeRows });
  }

  /** Application-level heartbeat; the server replies `pong`. */
  ping(): void {
    if (this.canSend()) this.sendRaw({ type: "ping" });
  }

  /** Ask the server to terminate the PTY, then close the socket. */
  close(): void {
    this.closedByUser = true;
    if (this.canSend()) {
      this.sendRaw({ type: "close" });
    }
    this.shutdownSocket(1000, "client closed");
  }

  /** Tear down the transport without terminating the PTY (tab switch/unmount). */
  dispose(): void {
    this.disposed = true;
    this.pending = [];
    this.pendingChars = 0;
    this.settleReady(
      new TerminalClientError("DISPOSED", "client was disposed"),
    );
    this.shutdownSocket(1000, "disposed");
    this.setState("closed");
  }

  private url(): string {
    const base =
      this.options.baseUrl ??
      (typeof window !== "undefined" ? window.location.origin : "");
    const path = `/api/sessions/${encodeURIComponent(
      this.options.sessionId,
    )}/terminals/${encodeURIComponent(this.options.tabId)}/ws`;
    const url = new URL(path, base);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const token = this.options.token;
    if (token) url.searchParams.set("token", token);
    return url.toString();
  }

  private canSend(): boolean {
    return (
      !this.disposed &&
      this.socket !== null &&
      this.socket.readyState === WebSocket.OPEN &&
      this.state === "ready"
    );
  }

  private sendRaw(frame: ClientFrame): void {
    const socket = this.socket;
    if (socket === null || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify(frame));
  }

  private handleMessage(event: MessageEvent): void {
    if (typeof event.data !== "string") {
      this.report(
        new TerminalClientError(
          "PROTOCOL",
          "binary server frames are not supported",
          true,
        ),
      );
      return;
    }

    let frame: ServerFrame | null;
    try {
      frame = parseServerFrame(event.data);
    } catch (error) {
      this.report(
        error instanceof TerminalClientError
          ? error
          : new TerminalClientError("PROTOCOL", "invalid server frame", true),
      );
      return;
    }
    if (frame === null) return;

    switch (frame.type) {
      case "ready": {
        this.setState("ready");
        if (this.readyTimer !== null) {
          window.clearTimeout(this.readyTimer);
          this.readyTimer = null;
        }
        this.options.onReady?.(frame);
        if (frame.cols !== this.initCols || frame.rows !== this.initRows) {
          this.sendRaw({
            type: "resize",
            cols: this.initCols,
            rows: this.initRows,
          });
        }
        this.flushPending();
        this.settleReady(frame);
        return;
      }
      case "data":
        this.options.onData?.(frame.data, frame);
        return;
      case "exit":
        this.setState("closed");
        this.options.onExit?.(frame.code, frame);
        return;
      case "error":
        this.report(
          new TerminalClientError(
            frame.code,
            frame.message,
            frame.code === "TERMINAL_CLOSED",
          ),
        );
        return;
      case "pong":
        return;
    }
  }

  private handleClose(event: CloseEvent): void {
    if (this.readyTimer !== null) {
      window.clearTimeout(this.readyTimer);
      this.readyTimer = null;
    }

    this.pending = [];
    this.pendingChars = 0;
    this.socket = null;

    if (!this.closedByUser && this.state !== "closed") {
      this.settleReady(
        new TerminalClientError(
          "CONNECTION_CLOSED",
          `the terminal connection closed (${event.code})`,
        ),
      );
      if (this.state !== "error") this.setState("closed");
    }

    if (!this.disposed) this.options.onClose?.(event);
  }

  private flushPending(): void {
    if (this.pending.length === 0) return;
    const queued = this.pending;
    this.pending = [];
    this.pendingChars = 0;
    for (const chunk of queued) {
      this.sendRaw({ type: "input", data: chunk });
    }
  }

  private settleReady(result: TerminalReadyFrame | Error): void {
    const resolve = this.resolveReady;
    const reject = this.rejectReady;
    this.resolveReady = null;
    this.rejectReady = null;

    if (result instanceof Error) {
      reject?.(result);
    } else {
      resolve?.(result);
    }
  }

  private shutdownSocket(code: number, reason: string): void {
    if (this.readyTimer !== null) {
      window.clearTimeout(this.readyTimer);
      this.readyTimer = null;
    }
    const socket = this.socket;
    this.socket = null;
    if (socket !== null) {
      try {
        socket.close(code, reason);
      } catch {
        // The socket may already be closing; nothing else to do.
      }
    }
  }

  private setState(next: TerminalConnectionState): void {
    if (this.state === next) return;
    this.state = next;
    this.options.onState?.(next);
  }

  private report(error: TerminalClientError): void {
    if (error.fatal) this.setState("error");
    this.options.onError?.(error);
  }
}

function clampDimension(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  const rounded = Math.trunc(value);
  if (rounded < 1) return 1;
  if (rounded > 1000) return 1000;
  return rounded;
}
