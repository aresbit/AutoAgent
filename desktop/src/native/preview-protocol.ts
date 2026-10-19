/**
 * `autoagent-preview://` custom scheme for local HTML and materialized
 * artifacts.
 *
 * Design rules:
 *   - the renderer never receives a filesystem path, and `file://` is never
 *     enabled for preview content;
 *   - a root must be registered explicitly by the main process, which returns
 *     an opaque id (never a path);
 *   - every request is resolved with `realpath` and must stay strictly inside
 *     the registered root, so symlinks cannot escape;
 *   - unknown extensions are served as `application/octet-stream` with
 *     `nosniff`; HTML gets a restrictive CSP.
 *
 * This module has no Electron import, mirroring `native/artifact-protocol.ts`,
 * so the parser and handler are unit-testable in plain Node.
 */

import { randomUUID } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, join, resolve, sep } from 'node:path';
import { PREVIEW_SCHEME } from './preview-contract.js';

const MAX_URL_LENGTH = 4096;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const ROOT_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

export const PREVIEW_SCHEME_PRIVILEGES = {
  standard: true,
  secure: true,
  supportFetchAPI: true,
  corsEnabled: true,
  stream: true,
} as const;

export interface PreviewSchemeRegistrar {
  registerSchemesAsPrivileged(
    schemes: Array<{ scheme: string; privileges: typeof PREVIEW_SCHEME_PRIVILEGES }>,
  ): void;
}

export interface PreviewRoot {
  id: string;
  rootDir: string;
  label: string;
  /** Hidden segments (`.env`, `.git`) are denied unless explicitly allowed. */
  allowHidden: boolean;
}

export interface PreviewRootOptions {
  id?: string;
  label?: string;
  allowHidden?: boolean;
}

/**
 * In-memory registry of directories the preview may serve.  The backend or a
 * native file dialog asks the main process to add a root; the renderer only
 * ever sees the opaque id embedded in a `autoagent-preview://` URL.
 */
export class PreviewRootRegistry {
  private readonly roots = new Map<string, PreviewRoot>();

  add(rootDir: string, options: PreviewRootOptions = {}): string {
    if (typeof rootDir !== 'string' || !isAbsolute(rootDir)) {
      throw new Error('preview root must be an absolute directory');
    }
    const id = options.id ?? randomUUID();
    if (!ROOT_ID.test(id)) throw new Error('invalid preview root id');
    if (this.roots.has(id)) throw new Error('preview root id already registered');
    this.roots.set(id, {
      id,
      rootDir: resolve(rootDir),
      label: (options.label ?? 'Preview').slice(0, 80),
      allowHidden: options.allowHidden === true,
    });
    return id;
  }

  get(id: string): PreviewRoot | undefined {
    return this.roots.get(id);
  }

  remove(id: string): boolean {
    return this.roots.delete(id);
  }

  clear(): void {
    this.roots.clear();
  }

  get size(): number {
    return this.roots.size;
  }
}

export interface PreviewTarget {
  rootId: string;
  /** Decoded, validated path segments; already includes a trailing index.html. */
  segments: string[];
}

export function registerPreviewScheme(protocol: PreviewSchemeRegistrar): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: PREVIEW_SCHEME, privileges: PREVIEW_SCHEME_PRIVILEGES },
  ]);
}

function isRootId(value: string): boolean {
  return ROOT_ID.test(value);
}

/**
 * Parse `autoagent-preview://<rootId>/<path>`.
 *
 * Rejects credentials, ports, malformed ids, directory traversal, encoded
 * separators, drive letters/ADS colons, NUL bytes and over-long URLs.
 */
export function parsePreviewUrl(raw: string): PreviewTarget | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_URL_LENGTH) return null;

  // The URL parser silently normalizes encoded dot segments.  Reject any
  // percent-encoded dot in the raw path before parsing so traversal attempts
  // are visible as rejections rather than being rewritten into a valid path.
  const authorityAt = raw.indexOf('://');
  const rawPathAt = authorityAt >= 0 ? raw.indexOf('/', authorityAt + 3) : -1;
  if (rawPathAt >= 0) {
    const rawPath = raw.slice(rawPathAt).split(/[?#]/, 1)[0] ?? '';
    if (/%2e/i.test(rawPath)) return null;
    // Reject literal dot segments too. The URL parser would collapse them into
    // an in-root path (safe, but silently different from what was requested);
    // rejecting keeps the accepted URL grammar exact.
    if (rawPath.split('/').some((segment) => segment === '.' || segment === '..')) {
      return null;
    }
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  if (url.protocol !== `${PREVIEW_SCHEME}:`) return null;
  if (url.username !== '' || url.password !== '') return null;
  if (url.port !== '') return null;

  const rootId = url.hostname;
  if (!isRootId(rootId)) return null;

  const pathname = url.pathname;
  if (!pathname.startsWith('/')) return null;

  const hasTrailingSlash = pathname.endsWith('/');
  const rawSegments = pathname.split('/').slice(1);
  if (hasTrailingSlash) rawSegments.pop();

  const segments: string[] = [];
  for (const rawSegment of rawSegments) {
    if (rawSegment.length === 0) return null;
    // Reject encoded separators before decoding: `a%2fb` must not silently
    // become two path segments, and `%5c` must not become a Windows separator.
    if (/%2f|%5c/i.test(rawSegment)) return null;
    let segment: string;
    try {
      segment = decodeURIComponent(rawSegment);
    } catch {
      return null;
    }
    if (segment.length === 0 || segment === '.' || segment === '..') return null;
    if (
      segment.includes('/') ||
      segment.includes('\\') ||
      segment.includes(':') ||
      segment.includes('\0')
    ) {
      return null;
    }
    if (/[\u0000-\u001f\u007f]/.test(segment)) return null;
    segments.push(segment);
  }

  // Root or a directory URL maps to index.html.
  if (segments.length === 0 || hasTrailingSlash) segments.push('index.html');

  return { rootId, segments };
}

/** Build the only URL shape the main process ever hands to a WebContentsView. */
export function previewUrl(rootId: string, relativePath: string): string {
  if (!isRootId(rootId)) throw new Error('invalid preview root id');
  if (typeof relativePath !== 'string' || relativePath.length === 0) {
    throw new Error('invalid preview path');
  }
  const normalized = relativePath.replace(/^\/+/, '');
  const segments = normalized.split('/');
  if (segments.some((segment) => segment.length === 0)) {
    throw new Error('invalid preview path');
  }
  const encoded = segments
    .map((segment) => {
      if (segment === '.' || segment === '..' || segment.includes('\\') || segment.includes(':')) {
        throw new Error('invalid preview path');
      }
      return encodeURIComponent(segment);
    })
    .join('/');
  return `${PREVIEW_SCHEME}://${rootId}/${encoded}`;
}

export interface PreviewProtocolOptions {
  registry: PreviewRootRegistry;
  /** Structured logging; never include the resolved path or file contents. */
  onError?: (event: string, detail: string) => void;
}

export type PreviewProtocolHandler = (request: Request) => Promise<Response>;

const CONTENT_TYPES: Readonly<Record<string, string>> = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.bmp': 'image/bmp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
});

const HTML_CSP =
  "default-src 'none'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; " +
  "script-src 'self' 'unsafe-inline'; font-src 'self' data:; media-src 'self' data: blob:; " +
  "connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'; " +
  "object-src 'none'; child-src 'none'";

const SVG_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox";

const ERROR_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'";

function errorResponse(status: number, message: string): Response {
  const body = [
    '<!doctype html><html><head><meta charset="utf-8">',
    '<title>Preview unavailable</title></head>',
    '<body style="font:14px system-ui;padding:24px;color:#9aa4b2;background:#0b0d10">',
    `<p>${message.replace(/[<>&"']/g, '')}</p>`,
    '</body></html>',
  ].join('');
  return new Response(body, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': ERROR_CSP,
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'cache-control': 'no-store',
      'cross-origin-resource-policy': 'same-origin',
    },
  });
}

function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

function contentTypeFor(filePath: string): string {
  return CONTENT_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

/**
 * Build the `protocol.handle` callback.
 *
 * The handler performs containment checks with `realpath` before every read,
 * so a symlink created after registration still cannot escape the root.
 */
export function createPreviewProtocolHandler(
  options: PreviewProtocolOptions,
): PreviewProtocolHandler {
  return async (request: Request): Promise<Response> => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return errorResponse(405, 'Only GET and HEAD are supported.');
    }

    const target = parsePreviewUrl(request.url);
    if (!target) {
      options.onError?.('preview.protocol.invalid-url', 'rejected malformed preview url');
      return errorResponse(400, 'This preview address is not valid.');
    }

    const root = options.registry.get(target.rootId);
    if (!root) {
      options.onError?.('preview.protocol.unknown-root', 'root is not registered');
      return errorResponse(404, 'This preview is not available.');
    }

    if (!root.allowHidden && target.segments.some((segment) => segment.startsWith('.'))) {
      options.onError?.('preview.protocol.hidden-path', 'hidden segment denied');
      return errorResponse(404, 'This preview is not available.');
    }

    let realRoot: string;
    try {
      realRoot = await realpath(root.rootDir);
    } catch {
      return errorResponse(404, 'This preview is not available.');
    }

    let realFile: string;
    try {
      realFile = await realpath(join(realRoot, ...target.segments));
    } catch {
      return errorResponse(404, 'This preview file does not exist.');
    }

    if (!isInside(realRoot, realFile) || realFile === realRoot) {
      options.onError?.('preview.protocol.escape', 'resolved path escaped its root');
      return errorResponse(403, 'This preview file is outside the allowed root.');
    }

    try {
      const initial = await stat(realFile);
      if (initial.isDirectory()) {
        try {
          realFile = await realpath(join(realFile, 'index.html'));
        } catch {
          return errorResponse(404, 'This preview file does not exist.');
        }
        if (!isInside(realRoot, realFile) || realFile === realRoot) {
          options.onError?.('preview.protocol.escape', 'index.html escaped its root');
          return errorResponse(403, 'This preview file is outside the allowed root.');
        }
      }

      const info = await stat(realFile);
      if (!info.isFile()) return errorResponse(404, 'This preview file does not exist.');
      if (info.size > MAX_FILE_BYTES) {
        options.onError?.('preview.protocol.too-large', 'file exceeds the preview size cap');
        return errorResponse(413, 'This preview file is too large.');
      }

      const body = request.method === 'HEAD' ? Buffer.alloc(0) : await readFile(realFile);
      if (body.byteLength > MAX_FILE_BYTES) {
        options.onError?.('preview.protocol.too-large', 'file grew past the preview size cap');
        return errorResponse(413, 'This preview file is too large.');
      }

      const contentType = contentTypeFor(realFile);
      const headers: Record<string, string> = {
        'content-type': contentType,
        'content-length': String(info.size),
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        'cache-control': 'no-store',
        'cross-origin-resource-policy': 'same-origin',
      };
      if (contentType.startsWith('text/html')) headers['content-security-policy'] = HTML_CSP;
      if (contentType === 'image/svg+xml') headers['content-security-policy'] = SVG_CSP;

      return new Response(body, { status: 200, headers });
    } catch (error) {
      options.onError?.(
        'preview.protocol.error',
        error instanceof Error ? error.name : 'unknown error',
      );
      return errorResponse(500, 'This preview file could not be read.');
    }
  };
}
