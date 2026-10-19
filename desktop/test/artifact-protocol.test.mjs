/**
 * Unit tests for the Electron-free artifact protocol logic, plus a static
 * smoke check that the built main process registers the privileged scheme.
 *
 * Run after `node build.mjs`.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import {
  ARTIFACT_SCHEME,
  ARTIFACT_SCHEME_PRIVILEGES,
  artifactProtocolUrl,
  createArtifactProtocolHandler,
  parseArtifactUrl,
  registerArtifactScheme,
} from '../dist/artifact-protocol.js'

const artifactUrl = 'autoagent-artifact://demo/v2/index.html'

test('parses the canonical artifact URL', () => {
  assert.deepEqual(parseArtifactUrl(artifactUrl), { artifactId: 'demo', version: 'v2' })
})

test('accepts slug ids and multi-digit versions', () => {
  assert.deepEqual(
    parseArtifactUrl('autoagent-artifact://quarterly_review-2/v120/index.html'),
    { artifactId: 'quarterly_review-2', version: 'v120' },
  )
})

test('rejects every URL outside the exact shape', () => {
  const bad = [
    '',
    'http://127.0.0.1:8787/api/artifacts/demo/frame',
    'https://demo/v2/index.html',
    'autoagent-artifact://demo/v2/index.htm',
    'autoagent-artifact://demo/v2/index.html/',
    'autoagent-artifact://demo/v2/nested/index.html',
    'autoagent-artifact://demo/index.html',
    'autoagent-artifact://demo/v0/index.html',
    'autoagent-artifact://demo/v01/index.html',
    'autoagent-artifact://demo/v-1/index.html',
    'autoagent-artifact://demo/v2/%2e%2e/index.html',
    'autoagent-artifact://demo/v2/../index.html',
    'autoagent-artifact://Demo/v2/index.html',
    'autoagent-artifact:///v2/index.html',
    'autoagent-artifact://demo.evil/v2/index.html',
    'autoagent-artifact://demo:8080/v2/index.html',
    'autoagent-artifact://user:pass@demo/v2/index.html',
    'autoagent-artifact://demo/v2/index.html?x=1',
    'autoagent-artifact://demo/v2/index.html#fragment',
    `autoagent-artifact://${'a'.repeat(49)}/v1/index.html`,
  ]
  for (const raw of bad) {
    assert.equal(parseArtifactUrl(raw), null, `should reject ${JSON.stringify(raw)}`)
  }
  assert.equal(parseArtifactUrl(undefined), null)
  assert.equal(parseArtifactUrl(null), null)
  assert.equal(parseArtifactUrl(42), null)
})

test('builds only valid protocol URLs', () => {
  assert.equal(
    artifactProtocolUrl('demo', 'v3'),
    'autoagent-artifact://demo/v3/index.html',
  )
  assert.throws(() => artifactProtocolUrl('../demo', 'v3'))
  assert.throws(() => artifactProtocolUrl('demo', '3'))
})

test('registers the scheme with the required privileges', () => {
  const calls = []
  registerArtifactScheme({ registerSchemesAsPrivileged: (schemes) => calls.push(schemes) })
  assert.deepEqual(calls, [
    [
      {
        scheme: ARTIFACT_SCHEME,
        privileges: {
          standard: true,
          secure: true,
          supportFetchAPI: true,
          corsEnabled: true,
        },
      },
    ],
  ])
  assert.equal(ARTIFACT_SCHEME_PRIVILEGES.bypassCSP, undefined)
})

function frameHandler(fetcher, backend = { port: 8787, token: 'launch-secret' }) {
  return createArtifactProtocolHandler({ getBackend: () => backend, fetchImpl: fetcher })
}

test('exchanges the artifact version for a frame token and proxies HTML', async () => {
  const calls = []
  const fetcher = async (input, init = {}) => {
    const url = String(input)
    calls.push({ url, init })
    if (url.endsWith('/frame-token')) {
      return new Response(
        JSON.stringify({
          url: '/api/artifacts/demo/frame?version=v2&exp=99&sig=abc',
          expiresAt: 99,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    return new Response('<!doctype html><p>hi</p>', {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'",
      },
    })
  }

  const response = await frameHandler(fetcher)(new Request(artifactUrl))

  assert.equal(response.status, 200)
  assert.equal(await response.text(), '<!doctype html><p>hi</p>')
  assert.equal(
    response.headers.get('content-security-policy'),
    "default-src 'none'; script-src 'unsafe-inline'",
  )
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(response.headers.get('cache-control'), 'no-store')

  assert.equal(calls.length, 2)
  assert.equal(calls[0].url, 'http://127.0.0.1:8787/api/artifacts/demo/frame-token')
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(calls[0].init.headers.authorization, 'Bearer launch-secret')
  assert.deepEqual(JSON.parse(calls[0].init.body), { version: 'v2' })

  assert.equal(calls[1].url, 'http://127.0.0.1:8787/api/artifacts/demo/frame?version=v2&exp=99&sig=abc')
  assert.equal(calls[1].init.headers.authorization, undefined)
  assert.equal(calls[1].init.redirect, 'error')
})

test('rejects malformed URLs before touching the backend', async () => {
  let called = false
  const handler = frameHandler(async () => {
    called = true
    throw new Error('must not be called')
  })
  const response = await handler(new Request('http://127.0.0.1:8787/api/artifacts/demo/frame'))
  assert.equal(response.status, 400)
  assert.equal(called, false)
})

test('returns 503 when the backend is not ready', async () => {
  let called = false
  const handler = createArtifactProtocolHandler({
    getBackend: () => null,
    fetchImpl: async () => {
      called = true
      throw new Error('must not be called')
    },
  })
  const response = await handler(new Request(artifactUrl))
  assert.equal(response.status, 503)
  assert.equal(called, false)
})

test('rejects a frame URL that escapes the loopback backend', async () => {
  for (const url of [
    'http://localhost:8787/api/artifacts/demo/frame?version=v2',
    'http://127.0.0.1:9999/api/artifacts/demo/frame?version=v2',
    'http://evil.example/api/artifacts/demo/frame?version=v2',
    'https://127.0.0.1:8787/api/artifacts/demo/frame?version=v2',
    'http://127.0.0.1:8787/api/artifacts/demo/frame?version=v3',
    '/api/artifacts/other/frame?version=v2',
    '/api/health',
  ]) {
    const fetcher = async (input) => {
      if (String(input).endsWith('/frame-token')) {
        return new Response(JSON.stringify({ url, expiresAt: 1 }), { status: 200 })
      }
      throw new Error('frame fetch must not happen')
    }
    const response = await frameHandler(fetcher)(new Request(artifactUrl))
    assert.equal(response.status, 502, `should reject ${url}`)
  }
})

test('maps upstream failures to a generic 502 without leaking the token', async () => {
  const fetcher = async () => {
    throw new Error('connect ECONNREFUSED')
  }
  const response = await frameHandler(fetcher)(new Request(artifactUrl))
  assert.equal(response.status, 502)
  const body = await response.text()
  assert.equal(body.includes('launch-secret'), false)
  assert.equal(body.includes('ECONNREFUSED'), false)
})

test('rejects non-GET/HEAD methods', async () => {
  const handler = frameHandler(async () => {
    throw new Error('must not be called')
  })
  const response = await handler(new Request(artifactUrl, { method: 'POST' }))
  assert.equal(response.status, 405)
})

test('built main registers the privileged scheme and ships a minimal preload', async () => {
  const main = await readFile(fileURLToPath(new URL('../dist/main.js', import.meta.url)), 'utf8')
  assert.match(main, /registerSchemesAsPrivileged/)
  assert.match(main, /autoagent-artifact/)
  assert.match(main, /protocol\.handle/)

  const preload = await readFile(
    fileURLToPath(new URL('../dist/artifact-preload.cjs', import.meta.url)),
    'utf8',
  )
  assert.match(preload, /autoagentArtifact/)
  assert.doesNotMatch(preload, /ipcRenderer/)
  assert.doesNotMatch(preload, /require\(['"]fs['"]\)/)
})
