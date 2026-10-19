/**
 * Custom `autoagent-artifact://` scheme for the artifact child window.
 *
 * The child never receives the launch token and never talks to the backend
 * origin directly.  Instead the main process:
 *   1. parses `autoagent-artifact://<id>/v<N>/index.html`,
 *   2. exchanges the artifact id/version for a short-lived frame token,
 *   3. fetches the isolated HTML from the loopback backend,
 *   4. returns it (with the backend CSP) through the custom scheme.
 *
 * This module intentionally has no Electron import so the URL parser and the
 * handler can be unit tested in plain Node.
 */

export const ARTIFACT_SCHEME = 'autoagent-artifact'

export const ARTIFACT_SCHEME_PRIVILEGES = {
  standard: true,
  secure: true,
  supportFetchAPI: true,
  corsEnabled: true,
} as const

/** Artifact ids are backend slugs: lowercase alphanumerics, `-` and `_`. */
const ARTIFACT_ID = /^[a-z0-9][a-z0-9_-]{0,47}$/
/** Exactly `/v<N>/index.html`, matching the backend revision format. */
const VERSION_PATH = /^\/v([1-9][0-9]*)\/index\.html$/
const MAX_URL_LENGTH = 2048

const FRAME_CONTENT_TYPE = 'text/html; charset=utf-8'
const FALLBACK_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; " +
  "form-action 'none'; frame-ancestors 'self'"

export interface ArtifactTarget {
  artifactId: string
  /** Backend revision id, e.g. `v3`. */
  version: string
}

export interface ArtifactBackendAccess {
  /** Loopback port the backend is listening on. */
  port: number
  /** Per-launch bearer token; stays in the main process. */
  token: string
}

export interface ArtifactSchemeRegistrar {
  registerSchemesAsPrivileged(
    schemes: Array<{ scheme: string; privileges: typeof ARTIFACT_SCHEME_PRIVILEGES }>,
  ): void
}

export type ArtifactFetcher = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>

/** Shape returned by `createArtifactProtocolHandler`. */
export type ArtifactProtocolHandler = (request: Request) => Promise<Response>

export interface ArtifactProtocolOptions {
  getBackend: () => ArtifactBackendAccess | null
  fetchImpl?: ArtifactFetcher
  /** Optional structured logging hook; never pass secrets. */
  onError?: (event: string, detail: string) => void
}

/**
 * Register the scheme with the Electron protocol registry.  Must run before
 * `app.whenReady()` resolves.
 */
export function registerArtifactScheme(protocol: ArtifactSchemeRegistrar): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: ARTIFACT_SCHEME, privileges: ARTIFACT_SCHEME_PRIVILEGES },
  ])
}

export function isArtifactId(value: unknown): value is string {
  return typeof value === 'string' && ARTIFACT_ID.test(value)
}

export function isArtifactVersion(value: unknown): value is string {
  return typeof value === 'string' && /^v[1-9][0-9]*$/.test(value)
}

/** Build the only URL shape the child window is ever given. */
export function artifactProtocolUrl(artifactId: string, version: string): string {
  if (!isArtifactId(artifactId)) throw new Error('invalid artifact id')
  if (!isArtifactVersion(version)) throw new Error('invalid artifact version')
  return `${ARTIFACT_SCHEME}://${artifactId}/${version}/index.html`
}

/**
 * Parse and strictly validate a custom-scheme URL.
 *
 * Rejects other schemes, credentials, ports, queries/fragments, malformed ids,
 * non-`index.html` entries and traversal.  Returns `null` rather than throwing
 * so protocol handling can answer with a generic error document.
 */
export function parseArtifactUrl(raw: string): ArtifactTarget | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_URL_LENGTH) return null

  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }

  if (url.protocol !== `${ARTIFACT_SCHEME}:`) return null
  if (url.username !== '' || url.password !== '') return null
  if (url.port !== '') return null
  if (url.search !== '' || url.hash !== '') return null

  // For a standard scheme Chromium lowercases the host; ids are lowercase.
  const artifactId = url.hostname
  if (!isArtifactId(artifactId)) return null

  const match = VERSION_PATH.exec(url.pathname)
  if (!match?.[1]) return null

  return { artifactId, version: `v${match[1]}` }
}

function isLoopbackPort(port: number): boolean {
  return Number.isInteger(port) && port > 0 && port <= 65_535
}

function errorResponse(status: number, message: string): Response {
  const body = [
    '<!doctype html><html><head><meta charset="utf-8">',
    '<title>Artifact unavailable</title></head>',
    '<body style="font:14px system-ui;padding:24px;color:#9aa4b2;background:#0b0d10">',
    `<p>${message.replace(/[<>&"']/g, '')}</p>`,
    '</body></html>',
  ].join('')
  return new Response(body, {
    status,
    headers: {
      'content-type': FRAME_CONTENT_TYPE,
      'content-security-policy': FALLBACK_CSP,
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'cache-control': 'no-store',
    },
  })
}

/** The CSP the backend attaches; used when a proxy strips the header. */
const FRAME_CSP =
  "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; " +
  "script-src 'unsafe-inline'; font-src data:; connect-src 'none'; " +
  "form-action 'none'; base-uri 'none'; frame-ancestors 'self'"

function frameResponse(html: string, upstream: Response): Response {
  return new Response(html, {
    status: 200,
    headers: {
      'content-type': upstream.headers.get('content-type') ?? FRAME_CONTENT_TYPE,
      'content-security-policy': upstream.headers.get('content-security-policy') ?? FRAME_CSP,
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'cache-control': 'no-store',
    },
  })
}

/**
 * Build the `protocol.handle` callback.  The callback performs the token
 * exchange and backend fetch in the main process; the child only ever sees the
 * artifact HTML for a URL on the custom scheme.
 */
export function createArtifactProtocolHandler(
  options: ArtifactProtocolOptions,
): ArtifactProtocolHandler {
  const fetcher = options.fetchImpl ?? fetch

  return async (request: Request): Promise<Response> => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return errorResponse(405, 'Only GET and HEAD are supported.')
    }

    const target = parseArtifactUrl(request.url)
    if (!target) {
      options.onError?.('artifact.protocol.invalid-url', 'rejected malformed artifact url')
      return errorResponse(400, 'This artifact address is not valid.')
    }

    const backend = options.getBackend()
    if (!backend || !isLoopbackPort(backend.port) || backend.token.length === 0) {
      options.onError?.('artifact.protocol.unavailable', 'backend is not ready')
      return errorResponse(503, 'The backend is not ready.')
    }

    const origin = `http://127.0.0.1:${backend.port}`
    const authorization = `Bearer ${backend.token}`

    try {
      const tokenResponse = await fetcher(
        `${origin}/api/artifacts/${encodeURIComponent(target.artifactId)}/frame-token`,
        {
          method: 'POST',
          headers: {
            authorization,
            'content-type': 'application/json',
            accept: 'application/json',
          },
          body: JSON.stringify({ version: target.version }),
        },
      )
      if (!tokenResponse.ok) {
        options.onError?.('artifact.protocol.token-failed', `status ${tokenResponse.status}`)
        return errorResponse(502, 'The artifact frame token could not be issued.')
      }

      const payload = (await tokenResponse.json()) as { url?: unknown }
      if (typeof payload?.url !== 'string' || payload.url.length === 0) {
        options.onError?.('artifact.protocol.token-failed', 'missing frame url')
        return errorResponse(502, 'The artifact frame token response was invalid.')
      }

      // Only accept a frame URL on the same loopback origin and for the exact
      // artifact that was requested.  A compromised backend response cannot
      // redirect the main process elsewhere.
      let frameUrl: URL
      try {
        frameUrl = new URL(payload.url, origin)
      } catch {
        options.onError?.('artifact.protocol.frame-failed', 'malformed frame url')
        return errorResponse(502, 'The artifact frame address was invalid.')
      }
      const expectedPath = `/api/artifacts/${encodeURIComponent(target.artifactId)}/frame`
      if (
        frameUrl.origin !== origin ||
        frameUrl.pathname !== expectedPath ||
        frameUrl.searchParams.get('version') !== target.version
      ) {
        options.onError?.('artifact.protocol.frame-failed', 'frame url escaped the backend origin')
        return errorResponse(502, 'The artifact frame address was invalid.')
      }

      const frame = await fetcher(frameUrl, {
        method: 'GET',
        headers: { accept: 'text/html' },
        redirect: 'error',
      })
      if (!frame.ok) {
        options.onError?.('artifact.protocol.frame-failed', `status ${frame.status}`)
        return errorResponse(502, 'The artifact frame could not be loaded.')
      }

      const html = request.method === 'HEAD' ? '' : await frame.text()
      return frameResponse(html, frame)
    } catch (error) {
      options.onError?.(
        'artifact.protocol.error',
        error instanceof Error ? error.name : 'unknown error',
      )
      return errorResponse(502, 'The artifact could not be loaded.')
    }
  }
}
