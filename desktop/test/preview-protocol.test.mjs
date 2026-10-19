/**
 * Unit tests for the Electron-free preview protocol.
 *
 * Run after `node build.mjs`.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, realpath, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  PREVIEW_SCHEME_PRIVILEGES,
  PreviewRootRegistry,
  createPreviewProtocolHandler,
  parsePreviewUrl,
  previewUrl,
  registerPreviewScheme,
} from '../dist/preview-protocol.js'

test('registers the scheme as standard and secure', () => {
  const calls = []
  registerPreviewScheme({
    registerSchemesAsPrivileged: (schemes) => calls.push(schemes),
  })
  assert.deepEqual(calls, [
    [{ scheme: 'autoagent-preview', privileges: PREVIEW_SCHEME_PRIVILEGES }],
  ])
  assert.equal(PREVIEW_SCHEME_PRIVILEGES.secure, true)
})

test('parses only the exact autoagent-preview shape', () => {
  assert.deepEqual(parsePreviewUrl('autoagent-preview://demo/index.html'), {
    rootId: 'demo',
    segments: ['index.html'],
  })
  assert.deepEqual(parsePreviewUrl('autoagent-preview://demo/'), {
    rootId: 'demo',
    segments: ['index.html'],
  })
  assert.deepEqual(parsePreviewUrl('autoagent-preview://demo/a/b.css'), {
    rootId: 'demo',
    segments: ['a', 'b.css'],
  })

  for (const bad of [
    '',
    'https://example.com/index.html',
    'autoagent-preview:///index.html',
    'autoagent-preview://Demo/index.html',
    'autoagent-preview://demo:8080/index.html',
    'autoagent-preview://user:pass@demo/index.html',
    'autoagent-preview://demo/../secret.txt',
    'autoagent-preview://demo/%2e%2e/secret.txt',
    'autoagent-preview://demo/a%2fb.txt',
    'autoagent-preview://demo/a%5cb.txt',
    'autoagent-preview://demo/C:/Windows/x.txt',
    'autoagent-preview://demo//x.txt',
  ]) {
    assert.equal(parsePreviewUrl(bad), null, bad)
  }
})

test('builds encoded preview URLs', () => {
  assert.equal(previewUrl('demo', 'a b/c.html'), 'autoagent-preview://demo/a%20b/c.html')
  assert.throws(() => previewUrl('Bad Id', 'index.html'))
  assert.throws(() => previewUrl('demo', ''))
})

async function fixture() {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'preview-test-')))
  const root = join(base, 'root')
  const outside = join(base, 'outside')
  await mkdir(root)
  await mkdir(join(root, 'sub'))
  await mkdir(outside)
  await writeFile(join(root, 'index.html'), '<!doctype html><title>ok</title>')
  await writeFile(join(root, 'sub', 'app.js'), 'console.log(1)')
  await writeFile(join(root, '.env'), 'SECRET=1')
  await writeFile(join(outside, 'secret.txt'), 'secret')
  await symlink(join(outside, 'secret.txt'), join(root, 'escape.txt'))
  const registry = new PreviewRootRegistry()
  const id = registry.add(root, { id: 'demo' })
  const handler = createPreviewProtocolHandler({ registry })
  return { base, root, registry, id, handler }
}

test('serves files inside the registered root with security headers', async () => {
  const { handler } = await fixture()

  const html = await handler(new Request('autoagent-preview://demo/'))
  assert.equal(html.status, 200)
  assert.match(html.headers.get('content-type') ?? '', /^text\/html/)
  assert.match(html.headers.get('content-security-policy') ?? '', /default-src 'none'/)
  assert.equal(html.headers.get('x-content-type-options'), 'nosniff')
  assert.match(await html.text(), /<title>ok<\/title>/)

  const js = await handler(new Request('autoagent-preview://demo/sub/app.js'))
  assert.equal(js.status, 200)
  assert.match(js.headers.get('content-type') ?? '', /^text\/javascript/)
  assert.equal(js.headers.get('content-security-policy'), null)
})

test('rejects traversal, symlink escape, hidden files and unknown roots', async () => {
  const { handler } = await fixture()

  const escape = await handler(new Request('autoagent-preview://demo/escape.txt'))
  assert.equal(escape.status, 403)

  const hidden = await handler(new Request('autoagent-preview://demo/.env'))
  assert.equal(hidden.status, 404)

  const unknown = await handler(new Request('autoagent-preview://other/index.html'))
  assert.equal(unknown.status, 404)

  // Chromium normalizes dot segments before the handler sees the request, so a
  // literal `..` arrives as an in-root path and fails as a missing file.
  const malformed = await handler(new Request('autoagent-preview://demo/../x'))
  assert.equal(malformed.status, 404)

  const missing = await handler(new Request('autoagent-preview://demo/nope.txt'))
  assert.equal(missing.status, 404)

  const post = await handler(
    new Request('autoagent-preview://demo/index.html', { method: 'POST' }),
  )
  assert.equal(post.status, 405)
})

test('HEAD returns headers without a body', async () => {
  const { handler } = await fixture()
  const response = await handler(
    new Request('autoagent-preview://demo/index.html', { method: 'HEAD' }),
  )
  assert.equal(response.status, 200)
  assert.equal((await response.text()).length, 0)
})
