#!/usr/bin/env node
/**
 * M3 smoke test: exercises backend-manager in Node with a real child process.
 *
 * Verifies:
 *  - a loopback port in 8787..8802 is chosen and reported healthy
 *  - the per-launch token and bootId cross the spawn boundary (env)
 *  - /api/health is accepted only with the expected bootId/db
 *  - stdout/stderr are captured to <state>/logs/backend.log
 *  - the token never appears in desktop.log
 *  - the window URL is constructed as http://127.0.0.1:<port>/?token=<token>
 *  - shutdown is idempotent and the child is gone
 *
 * A GUI is not required; window.ts itself is Electron-only and is not imported.
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BackendManager,
  acquireSingleInstanceLock,
  buildAppUrl,
  buildBackendSpawnSpec,
  choosePort,
  generateBootId,
  generateToken,
  isPidAlive,
  readBackendPidFile,
  requestHealth,
  splitCommandLine,
} from '../dist/backend-manager.js'
import { createLogger } from '../dist/logging.js'
import { resolveAppPaths } from '../dist/paths.js'

const here = dirname(fileURLToPath(import.meta.url))
const desktopRoot = dirname(here)
const repoRoot = dirname(desktopRoot)
const stubPath = join(here, 'stub-backend.mjs')

function quote(value) {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function main() {
  const results = []
  const check = async (name, fn) => {
    await fn()
    results.push(name)
  }

  // --- pure helpers ---------------------------------------------------------
  await check('splitCommandLine preserves quoted argv', () => {
    assert.deepEqual(
      splitCommandLine(`${quote('/usr/bin/node')} ${quote('/tmp/a b.mjs')} --flag`),
      ['/usr/bin/node', '/tmp/a b.mjs', '--flag'],
    )
  })

  await check('splitCommandLine preserves Windows path backslashes', () => {
    assert.deepEqual(
      splitCommandLine('"C:\\Program Files\\AutoAgent\\node.exe" "D:\\a b\\stub.mjs"'),
      ['C:\\Program Files\\AutoAgent\\node.exe', 'D:\\a b\\stub.mjs'],
    )
    assert.deepEqual(splitCommandLine('C:\\tools\\node.exe --flag'), ['C:\\tools\\node.exe', '--flag'])
  })

  await check('splitCommandLine rejects unterminated quotes', () => {
    assert.throws(() => splitCommandLine('node "unterminated'))
  })

  await check('Linux paths honour XDG_CONFIG_HOME/XDG_STATE_HOME', () => {
    if (process.platform !== 'linux') return
    const paths = resolveAppPaths({
      XDG_CONFIG_HOME: '/tmp/xdg-config',
      XDG_STATE_HOME: '/tmp/xdg-state',
    })
    assert.equal(paths.dataDir, '/tmp/xdg-config/autoagent')
    assert.equal(paths.stateDir, '/tmp/xdg-state/autoagent')
    assert.equal(paths.logDir, '/tmp/xdg-state/autoagent/logs')
    assert.equal(paths.runtimeDir, '/tmp/xdg-config/autoagent/runtime')
    assert.equal(paths.heartbeatFile, '/tmp/xdg-config/autoagent/runtime/desktop.heartbeat')
    assert.equal(paths.backendPidFile, '/tmp/xdg-state/autoagent/runtime/backend.pid')
    assert.equal(paths.backendLogFile, '/tmp/xdg-state/autoagent/logs/backend.log')
  })

  await check('default spawn argv is an array: uv run --directory backend ...', () => {
    const spec = buildBackendSpawnSpec({
      repoRoot: '/repo',
      dataDir: '/data',
      stateDir: '/state',
      logDir: '/state/logs',
      heartbeatFile: '/state/runtime/desktop.heartbeat',
      port: 8787,
      token: 'a'.repeat(64),
      bootId: 'boot',
      baseEnv: {},
    })
    assert.equal(spec.command, 'uv')
    assert.deepEqual(spec.args, [
      'run', '--directory', '/repo/backend',
      'python', '-m', 'autoagent_backend',
      '--host', '127.0.0.1', '--port', '8787',
      '--data-dir', '/state',
    ])
    assert.equal(spec.env.AUTOAGENT_TOKEN, 'a'.repeat(64))
    assert.equal(spec.env.AUTOAGENT_API_TOKEN, 'a'.repeat(64))
    assert.equal(spec.env.AUTOAGENT_BIND, '127.0.0.1')
    assert.equal(spec.env.AUTOAGENT_PARENT_PID, String(process.pid))
    assert.equal(spec.env.AUTOAGENT_DATA_DIR, '/data')
    assert.equal(spec.env.AUTOAGENT_STATE_DIR, '/state')
    assert.equal(spec.env.PYTHONUNBUFFERED, '1')
    assert.equal(spec.env.PYTHONIOENCODING, 'utf-8')
    assert.equal(spec.args.join(' ').includes('a'.repeat(64)), false)
  })

  await check('AUTOAGENT_BACKEND_CMD overrides the default without a shell', () => {
    const spec = buildBackendSpawnSpec({
      repoRoot: '/repo',
      dataDir: '/data',
      stateDir: '/state',
      logDir: '/state/logs',
      heartbeatFile: '/state/runtime/desktop.heartbeat',
      port: 8787,
      token: 'b'.repeat(64),
      bootId: 'boot',
      backendCommand: 'node "/tmp/stub backend.mjs" --flag',
      baseEnv: {},
    })
    assert.equal(spec.command, 'node')
    assert.deepEqual(spec.args, ['/tmp/stub backend.mjs', '--flag'])
  })

  await check('readBackendPidFile accepts JSON and the legacy bare PID', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'autoagent-pid-'))
    try {
      const jsonFile = join(dir, 'json.pid')
      await writeFile(jsonFile, JSON.stringify({ pid: 42, port: 8787, bootId: 'boot' }), 'utf8')
      assert.deepEqual(await readBackendPidFile(jsonFile), { pid: 42, port: 8787, bootId: 'boot', startedAt: undefined, argvHash: undefined })
      const textFile = join(dir, 'text.pid')
      await writeFile(textFile, '4242\n', 'utf8')
      assert.deepEqual(await readBackendPidFile(textFile), { pid: 4242, port: 0, bootId: '' })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  let attempts = 0
  await check('single-instance retries and then succeeds', async () => {
    const acquired = await acquireSingleInstanceLock(
      () => {
        attempts += 1
        return attempts >= 3
      },
      { retries: 5, retryDelayMs: 5 },
    )
    assert.equal(acquired, true)
    assert.equal(attempts, 3)
  })

  const phantomPidFile = join(tmpdir(), 'autoagent-no-such-backend.pid')
  await check('port scan skips a responder that is not AutoAgent', async () => {
    const selected = await choosePort({
      portBase: 9100,
      portCount: 3,
      pidFile: phantomPidFile,
      probe: async (port) => port === 9100
        ? { reachable: true, statusCode: 200, body: { ok: true, app: 'something-else' } }
        : { reachable: false },
    })
    assert.equal(selected.port, 9101)
    assert.equal(selected.reused, false)
  })

  await check('port scan fails when all candidates are occupied', async () => {
    await assert.rejects(
      choosePort({
        portBase: 9200,
        portCount: 2,
        pidFile: phantomPidFile,
        probe: async () => ({ reachable: true, statusCode: 200, body: { ok: true, app: 'other' } }),
      }),
      /all ports 9200-9201 are occupied/,
    )
  })

  // --- real child process ---------------------------------------------------
  const tmp = await mkdtemp(join(tmpdir(), 'autoagent-m3-'))
  const dataDir = join(tmp, 'data')
  const stateDir = join(tmp, 'state')
  const logDir = join(stateDir, 'logs')
  const heartbeatFile = join(dataDir, 'runtime', 'desktop.heartbeat')
  const backendPidFile = join(dataDir, 'runtime', 'backend.pid')
  const backendLogFile = join(logDir, 'backend.log')
  const desktopLogFile = join(logDir, 'desktop.log')

  process.env.AUTOAGENT_BACKEND_CMD = `${quote(process.execPath)} ${quote(stubPath)}`
  const logger = createLogger(desktopLogFile)
  const bootId = generateBootId()
  const token = generateToken()

  let unexpectedExit = null
  let exitCount = 0
  const manager = new BackendManager({
    dataDir,
    stateDir,
    logDir,
    heartbeatFile,
    backendPidFile,
    backendLogFile,
    logger,
    repoRoot,
    bootId,
    token,
    startupTimeoutMs: 10_000,
    backendCommand: process.env.AUTOAGENT_BACKEND_CMD,
    onExit: (info) => {
      exitCount += 1
      unexpectedExit = info
    },
  })

  try {
    const handle = await manager.start()

    await check('chosen port is inside 8787..8802', () => {
      assert.ok(handle.port >= 8787 && handle.port <= 8802, `port=${handle.port}`)
    })

    await check('backend pid is alive and nonzero', () => {
      assert.ok(handle.pid > 0)
      assert.equal(isPidAlive(handle.pid), true)
    })

    await check('health endpoint reports app/bootId/db ok', async () => {
      const probe = await requestHealth(handle.port)
      assert.equal(probe.reachable, true)
      assert.equal(probe.statusCode, 200)
      assert.equal(probe.body.ok, true)
      assert.equal(probe.body.app, 'autoagent')
      assert.equal(probe.body.bootId, bootId)
      assert.equal(probe.body.db, 'ok')
    })

    await check('token and bootId crossed the spawn boundary', async () => {
      const seen = JSON.parse(await readFile(join(stateDir, 'stub-seen.json'), 'utf8'))
      assert.equal(seen.token, token)
      assert.equal(seen.tokenLength, 64)
      assert.equal(seen.bootId, bootId)
      assert.equal(seen.port, handle.port)
      assert.equal(seen.dataDir, dataDir)
      assert.equal(seen.stateDir, stateDir)
      assert.equal(seen.parentPid, String(process.pid))
      assert.equal(seen.pythonUnbuffered, '1')
      assert.equal(seen.pythonIoEncoding, 'utf-8')
    })

    await check('health is token-exempt but /api/bootstrap requires the token', async () => {
      const response = await fetch(`http://127.0.0.1:${handle.port}/api/bootstrap`)
      assert.equal(response.status, 401)
      const authorized = await fetch(`http://127.0.0.1:${handle.port}/api/bootstrap`, {
        headers: { authorization: `Bearer ${token}` },
      })
      assert.equal(authorized.status, 200)
    })

    await check('window URL is http://127.0.0.1:<port>/?token=<token>', () => {
      const built = buildAppUrl(handle.port, token)
      assert.equal(built, `http://127.0.0.1:${handle.port}/?token=${token}`)
      const parsed = new URL(built)
      assert.equal(parsed.origin, `http://127.0.0.1:${handle.port}`)
      assert.equal(parsed.searchParams.get('token'), token)
    })

    await check('PID file exists with the same bootId', async () => {
      const pidFile = JSON.parse(await readFile(backendPidFile, 'utf8'))
      assert.equal(pidFile.pid, handle.pid)
      assert.equal(pidFile.bootId, bootId)
      assert.equal(pidFile.port, handle.port)
    })

    await delay(200)
    await check('backend stdout/stderr are piped to <state>/logs/backend.log', async () => {
      const backendLog = await readFile(backendLogFile, 'utf8')
      assert.match(backendLog, /stub backend listening/)
    })

    await logger.flush()
    await check('desktop.log records the lifecycle and never contains the token', async () => {
      const desktopLog = await readFile(desktopLogFile, 'utf8')
      assert.match(desktopLog, /backend\.ready/)
      assert.match(desktopLog, new RegExp(`"port":${handle.port}`))
      assert.equal(desktopLog.includes(token), false)
    })

    const pid = handle.pid

    await check('child exit is reported so the app can shut down', async () => {
      process.kill(pid, 'SIGTERM')
      const deadline = Date.now() + 5_000
      while (unexpectedExit === null && Date.now() < deadline) {
        await delay(50)
      }
      assert.ok(unexpectedExit, 'onExit was never called')
      assert.equal(unexpectedExit.reason, 'exit')
      assert.equal(unexpectedExit.code, 0)
      assert.equal(unexpectedExit.signal, null)
    })

    const startedShutdown = Date.now()
    await manager.shutdown('smoke complete')
    await manager.shutdown('second call is a no-op')
    const shutdownMs = Date.now() - startedShutdown

    await check('shutdown is idempotent and the backend is gone', async () => {
      await delay(100)
      assert.equal(isPidAlive(pid), false)
      assert.ok(shutdownMs < 6_000, `shutdown took ${shutdownMs} ms`)
    })

    await check('heartbeat and pid files are removed', async () => {
      await assert.rejects(readFile(heartbeatFile, 'utf8'))
      await assert.rejects(readFile(backendPidFile, 'utf8'))
    })

    await check('backend exit callback fired exactly once', () => {
      assert.equal(exitCount, 1)
    })

    await logger.flush()
    process.stdout.write(results.map((name) => `ok - ${name}`).join('\n') + '\n')
    process.stdout.write(`smoke: PASS (${results.length} checks, port ${handle.port}, shutdown ${shutdownMs} ms)\n`)
  } finally {
    await manager.shutdown('smoke cleanup')
    await logger.flush()
    await rm(tmp, { recursive: true, force: true })
  }
}

main().catch((error) => {
  process.stderr.write(`smoke: FAIL\n${error instanceof Error ? error.stack : String(error)}\n`)
  process.exit(1)
})
