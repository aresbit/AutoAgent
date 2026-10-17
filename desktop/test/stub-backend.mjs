#!/usr/bin/env node
/**
 * Test stand-in for the M1/M2 Python backend.
 * Reads configuration from the same environment the real backend receives and
 * remains on the wire until SIGTERM, so backend-manager's lifecycle is exercised
 * for real (spawn, health poll, shutdown).
 */
import http from 'node:http'
import { mkdir, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const port = Number(process.env.AUTOAGENT_PORT || 8787)
const token = process.env.AUTOAGENT_TOKEN || ''
const bootId = process.env.AUTOAGENT_BOOT_ID || 'stub-boot'
const dataDir = process.env.AUTOAGENT_DATA_DIR || process.cwd()
const stateDir = process.env.AUTOAGENT_STATE_DIR || dataDir
const startedAt = new Date().toISOString()
const startedMs = Date.now()

async function persistRuntimeFiles() {
  const runtimeDir = join(dataDir, 'runtime')
  await mkdir(runtimeDir, { recursive: true })
  await mkdir(join(stateDir, 'logs'), { recursive: true })
  await writeFile(
    join(runtimeDir, 'backend.pid'),
    JSON.stringify({ pid: process.pid, port, bootId, startedAt }),
    'utf8',
  )
  // Test-only probe record: proves the token and bootId crossed the spawn boundary.
  await writeFile(
    join(stateDir, 'stub-seen.json'),
    JSON.stringify({
      pid: process.pid,
      port,
      bootId,
      token,
      tokenLength: token.length,
      dataDir,
      stateDir,
      heartbeat: process.env.AUTOAGENT_DESKTOP_HEARTBEAT || null,
      parentPid: process.env.AUTOAGENT_PARENT_PID || null,
      pythonUnbuffered: process.env.PYTHONUNBUFFERED || null,
      pythonIoEncoding: process.env.PYTHONIOENCODING || null,
    }),
    'utf8',
  )
}

function json(response, status, body) {
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  })
  response.end(payload)
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url || '/', `http://127.0.0.1:${port}`)

  if (url.pathname === '/api/health') {
    json(response, 200, {
      ok: true,
      app: 'autoagent',
      apiVersion: '1',
      version: 'stub-0.0.1',
      bootId,
      uptimeMs: Date.now() - startedMs,
      db: 'ok',
      engine: 'idle',
    })
    return
  }

  if (url.pathname === '/api/bootstrap') {
    const expected = `Bearer ${token}`
    if (request.headers.authorization !== expected) {
      json(response, 401, { error: 'unauthorized' })
      return
    }
    json(response, 200, { sessions: [], settings: {} })
    return
  }

  if (url.pathname === '/' || url.pathname === '/index.html') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end('<!doctype html><title>AutoAgent stub</title><main>stub backend</main>')
    return
  }

  json(response, 404, { error: 'not found' })
})

async function cleanup() {
  await new Promise((resolve) => server.close(() => resolve()))
  try {
    await unlink(join(dataDir, 'runtime', 'backend.pid'))
  } catch {
    // already gone
  }
  process.exit(0)
}

process.on('SIGTERM', cleanup)
process.on('SIGINT', cleanup)

server.on('error', (error) => {
  process.stderr.write(`stub backend error: ${error.message}\n`)
  process.exit(1)
})

server.listen(port, '127.0.0.1', async () => {
  await persistRuntimeFiles()
  process.stdout.write(`stub backend listening on http://127.0.0.1:${port} bootId=${bootId}\n`)
})
