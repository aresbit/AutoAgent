/**
 * Typed client for the AutoAgent safe-file API.
 *
 * Reference mapping: copy to ``frontend/src/features/files/fileClient.ts``.
 * Reuse the launch-token plumbing from ``@/api/client`` by exporting the token
 * (or by calling ``setFileAuthToken`` immediately after ``initLaunchToken``).
 * The backend also accepts the launch cookie, so ``credentials: "include"`` is
 * sufficient for the normal desktop flow.
 */

export type EntryKind = "file" | "directory" | "symlink";
export type ContentMode = "text" | "bytes";

export interface FileEntryView {
  name: string;
  path: string;
  kind: EntryKind;
  size: number;
  mtimeMs: number;
  hidden: boolean;
  isSymlink: boolean;
}

export interface FileListResponse {
  root: string;
  path: string;
  entries: FileEntryView[];
  nextCursor: string | null;
  total: number;
  hidden: boolean;
}

export interface FileStatView {
  root: string;
  path: string;
  name: string;
  kind: EntryKind;
  size: number;
  mtimeMs: number;
  mode: number;
  hidden: boolean;
  isSymlink: boolean;
}

export interface FileTextView {
  root: string;
  path: string;
  text: string | null;
  binary: boolean;
  encoding: string | null;
  size: number;
  lineCount: number;
  truncated: boolean;
  mtimeMs: number;
  mime: string;
  sha256: string | null;
}

export interface WriteFileResponse {
  root: string;
  path: string;
  size: number;
  sha256: string;
  mtimeMs: number;
  created: boolean;
}

export interface DeleteResponse {
  deleted: boolean;
}

export interface RevealResponse {
  revealed: boolean;
  root: string;
  path: string;
}

export interface ListQuery {
  root: string;
  path?: string;
  hidden?: boolean;
  cursor?: string | null;
  limit?: number;
}

export interface StatQuery {
  root: string;
  path: string;
}

export interface ContentQuery {
  root: string;
  path: string;
  maxLines?: number;
}

export interface WriteTextInput {
  root: string;
  path: string;
  text: string;
  /** Hash of the version the editor loaded; the server returns 409 on drift. */
  expectedSha256?: string;
}

export interface CreateFileInput {
  root: string;
  path: string;
  text?: string;
  overwrite?: boolean;
}

export interface MkdirInput {
  root: string;
  path: string;
  parents?: boolean;
}

export interface RenameInput {
  root: string;
  fromPath: string;
  toPath: string;
  overwrite?: boolean;
}

export interface DeleteInput {
  root: string;
  path: string;
}

export interface CopyMoveInput {
  root: string;
  fromPath: string;
  toPath: string;
  overwrite?: boolean;
}

export interface UploadInput {
  root: string;
  path: string;
  file: File;
  overwrite?: boolean;
  onProgress?: (loaded: number, total: number) => void;
}

export interface DownloadInput {
  root: string;
  path: string;
}

export class FileApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;

  constructor(status: number, code: string, message: string, retryable = false) {
    super(message);
    this.name = "FileApiError";
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

let sharedToken: string | null = null;

/** Set once from the launch-token bootstrap; never persisted. */
export function setFileAuthToken(token: string | null): void {
  sharedToken = token;
}

export function getFileAuthToken(): string | null {
  return sharedToken;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function abortError(): DOMException {
  return new DOMException("The request was aborted.", "AbortError");
}

function queryString(params: Record<string, string | number | boolean | null | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    search.set(key, String(value));
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}

async function errorFromResponse(response: Response): Promise<FileApiError> {
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  const record = isRecord(body) ? body : {};
  const nested = isRecord(record.error) ? record.error : record;
  const message =
    typeof nested.message === "string"
      ? nested.message
      : typeof nested.detail === "string"
        ? nested.detail
        : typeof nested.error === "string"
          ? nested.error
          : response.statusText || "The request failed.";
  const code = typeof nested.code === "string" ? nested.code : `HTTP_${response.status}`;
  const retryable =
    typeof nested.retryable === "boolean"
      ? nested.retryable
      : response.status === 429 || response.status >= 500;
  return new FileApiError(response.status, code, message, retryable);
}

function networkError(error: unknown): FileApiError {
  if (error instanceof DOMException && error.name === "AbortError") {
    throw error;
  }
  const message =
    error instanceof Error && error.message ? error.message : "The local service could not be reached.";
  return new FileApiError(0, "NETWORK_ERROR", message, true);
}

export interface FileClientOptions {
  baseUrl?: string;
  token?: () => string | null;
  fetchImpl?: typeof fetch;
}

export class FileClient {
  private readonly baseUrl: string;
  private readonly token: () => string | null;
  private readonly fetchImpl: typeof fetch;

  constructor(options: FileClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? "").replace(/\/$/, "");
    this.token = options.token ?? getFileAuthToken;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  private headers(json: boolean): Headers {
    const headers = new Headers();
    headers.set("accept", "application/json");
    if (json) headers.set("content-type", "application/json");
    const token = this.token();
    if (token) headers.set("authorization", `Bearer ${token}`);
    return headers;
  }

  private async request<T>(
    path: string,
    init: RequestInit = {},
    signal?: AbortSignal,
  ): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        headers: this.headers(init.body !== undefined),
        credentials: "include",
        signal,
      });
    } catch (error) {
      throw networkError(error);
    }
    if (!response.ok) throw await errorFromResponse(response);
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  list(input: ListQuery, signal?: AbortSignal): Promise<FileListResponse> {
    return this.request<FileListResponse>(
      `/api/files${queryString({
        root: input.root,
        path: input.path ?? "",
        hidden: input.hidden ?? false,
        cursor: input.cursor ?? undefined,
        limit: input.limit ?? 200,
      })}`,
      {},
      signal,
    );
  }

  stat(input: StatQuery, signal?: AbortSignal): Promise<FileStatView> {
    return this.request<FileStatView>(
      `/api/files/stat${queryString({ root: input.root, path: input.path })}`,
      {},
      signal,
    );
  }

  readText(input: ContentQuery, signal?: AbortSignal): Promise<FileTextView> {
    return this.request<FileTextView>(
      `/api/files/content${queryString({
        root: input.root,
        path: input.path,
        mode: "text",
        maxLines: input.maxLines ?? 20_000,
      })}`,
      {},
      signal,
    );
  }

  /** Raw bytes capped by the server; useful for image previews. */
  async readBytes(input: ContentQuery, signal?: AbortSignal): Promise<ArrayBuffer> {
    let response: Response;
    try {
      response = await this.fetchImpl(
        `${this.baseUrl}/api/files/content${queryString({
          root: input.root,
          path: input.path,
          mode: "bytes",
        })}`,
        {
          headers: this.headers(false),
          credentials: "include",
          signal,
        },
      );
    } catch (error) {
      throw networkError(error);
    }
    if (!response.ok) throw await errorFromResponse(response);
    return response.arrayBuffer();
  }

  writeText(input: WriteTextInput, signal?: AbortSignal): Promise<WriteFileResponse> {
    return this.request<WriteFileResponse>(
      "/api/files/content",
      {
        method: "PUT",
        body: JSON.stringify({
          root: input.root,
          path: input.path,
          text: input.text,
          expectedSha256: input.expectedSha256,
        }),
      },
      signal,
    );
  }

  createFile(input: CreateFileInput, signal?: AbortSignal): Promise<WriteFileResponse> {
    return this.request<WriteFileResponse>(
      "/api/files/create",
      {
        method: "POST",
        body: JSON.stringify({
          root: input.root,
          path: input.path,
          text: input.text ?? "",
          overwrite: input.overwrite ?? false,
        }),
      },
      signal,
    );
  }

  mkdir(input: MkdirInput, signal?: AbortSignal): Promise<FileStatView> {
    return this.request<FileStatView>(
      "/api/files/mkdir",
      {
        method: "POST",
        body: JSON.stringify({
          root: input.root,
          path: input.path,
          parents: input.parents ?? false,
        }),
      },
      signal,
    );
  }

  rename(input: RenameInput, signal?: AbortSignal): Promise<FileStatView> {
    return this.request<FileStatView>(
      "/api/files/rename",
      {
        method: "POST",
        body: JSON.stringify({
          root: input.root,
          fromPath: input.fromPath,
          toPath: input.toPath,
          overwrite: input.overwrite ?? false,
        }),
      },
      signal,
    );
  }

  deleteEntry(input: DeleteInput, signal?: AbortSignal): Promise<DeleteResponse> {
    return this.request<DeleteResponse>(
      "/api/files/delete",
      {
        method: "POST",
        body: JSON.stringify({ root: input.root, path: input.path }),
      },
      signal,
    );
  }

  copy(input: CopyMoveInput, signal?: AbortSignal): Promise<FileStatView> {
    return this.request<FileStatView>(
      "/api/files/copy",
      {
        method: "POST",
        body: JSON.stringify({
          root: input.root,
          fromPath: input.fromPath,
          toPath: input.toPath,
          overwrite: input.overwrite ?? false,
        }),
      },
      signal,
    );
  }

  move(input: CopyMoveInput, signal?: AbortSignal): Promise<FileStatView> {
    return this.request<FileStatView>(
      "/api/files/move",
      {
        method: "POST",
        body: JSON.stringify({
          root: input.root,
          fromPath: input.fromPath,
          toPath: input.toPath,
          overwrite: input.overwrite ?? false,
        }),
      },
      signal,
    );
  }

  async download(input: DownloadInput, signal?: AbortSignal): Promise<Blob> {
    let response: Response;
    try {
      response = await this.fetchImpl(
        `${this.baseUrl}/api/files/download${queryString({
          root: input.root,
          path: input.path,
        })}`,
        { headers: this.headers(false), credentials: "include", signal },
      );
    } catch (error) {
      throw networkError(error);
    }
    if (!response.ok) throw await errorFromResponse(response);
    return response.blob();
  }

  async thumbnail(input: DownloadInput, signal?: AbortSignal): Promise<Blob> {
    let response: Response;
    try {
      response = await this.fetchImpl(
        `${this.baseUrl}/api/files/thumbnail${queryString({
          root: input.root,
          path: input.path,
        })}`,
        { headers: this.headers(false), credentials: "include", signal },
      );
    } catch (error) {
      throw networkError(error);
    }
    if (!response.ok) throw await errorFromResponse(response);
    return response.blob();
  }

  /** Upload a raw body through XHR so progress is observable. */
  upload(input: UploadInput, signal?: AbortSignal): Promise<WriteFileResponse> {
    return new Promise<WriteFileResponse>((resolve, reject) => {
      if (signal?.aborted) {
        reject(abortError());
        return;
      }
      const request = new XMLHttpRequest();

      const onAbort = (): void => request.abort();
      signal?.addEventListener("abort", onAbort, { once: true });

      const cleanup = (): void => {
        signal?.removeEventListener("abort", onAbort);
      };

      request.open(
        "POST",
        `${this.baseUrl}/api/files/upload${queryString({
          root: input.root,
          path: input.path,
          overwrite: input.overwrite ?? false,
        })}`,
      );
      request.withCredentials = true;
      const token = this.token();
      if (token) request.setRequestHeader("authorization", `Bearer ${token}`);
      request.setRequestHeader("accept", "application/json");
      request.setRequestHeader(
        "content-type",
        input.file.type || "application/octet-stream",
      );

      request.upload.onprogress = (event) => {
        if (event.lengthComputable) input.onProgress?.(event.loaded, event.total);
      };
      request.onerror = () => {
        cleanup();
        reject(networkError(new Error("Upload failed.")));
      };
      request.onabort = () => {
        cleanup();
        reject(abortError());
      };
      request.onload = () => {
        cleanup();
        if (request.status >= 200 && request.status < 300) {
          try {
            resolve(JSON.parse(request.responseText) as WriteFileResponse);
          } catch {
            reject(new FileApiError(0, "INVALID_RESPONSE", "The upload response was invalid."));
          }
          return;
        }
        let body: unknown = null;
        try {
          body = JSON.parse(request.responseText) as unknown;
        } catch {
          body = null;
        }
        const record = isRecord(body) ? body : {};
        const nested = isRecord(record.error) ? record.error : record;
        const message =
          typeof nested.message === "string"
            ? nested.message
            : typeof nested.detail === "string"
              ? nested.detail
              : typeof nested.error === "string"
                ? nested.error
                : "The upload failed.";
        const code = typeof nested.code === "string" ? nested.code : `HTTP_${request.status}`;
        reject(new FileApiError(request.status, code, message));
      };
      request.send(input.file);
    });
  }

  reveal(input: DownloadInput, signal?: AbortSignal): Promise<RevealResponse> {
    return this.request<RevealResponse>(
      "/api/files/reveal",
      {
        method: "POST",
        body: JSON.stringify({ root: input.root, path: input.path }),
      },
      signal,
    );
  }
}

/** SHA-256 used for display and for the server-side compare-and-swap guard. */
export async function sha256Hex(data: string | ArrayBuffer | Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("Web Crypto is unavailable.");
  const source =
    typeof data === "string"
      ? new TextEncoder().encode(data)
      : data instanceof Uint8Array
        ? data
        : new Uint8Array(data);
  // Copy into an ArrayBuffer-backed view: TS 5.9's BufferSource excludes
  // SharedArrayBuffer-backed views.
  const bytes = Uint8Array.from(source);
  const digest = await subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Convenience: read a text document and remember its hash for a guarded save. */
export async function readTextDocument(
  client: FileClient,
  input: ContentQuery,
  signal?: AbortSignal,
): Promise<{ document: FileTextView; sha256: string | null }> {
  const document = await client.readText(input, signal);
  return { document, sha256: document.sha256 };
}
