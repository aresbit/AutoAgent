import { execFile, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import http from 'node:http'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { redactSecrets, type Logger } from './logging.js'
import { resolveInstallPaths } from './paths.js'

const execFileAsync = promisify(execFile)

function nonEmpty(value: string | undefined): string | undefined {
  return value && value.trim().length > 0 ? value : undefined
}

/** Architecture §3.3: scan 8787..8802. */
export const BASE_PORT = 8787
export const PORT_SCAN_COUNT = 16
/** Architecture §3.2: 10 retries x 1.5 s for the single-instance lock. */
export const SINGLE_INSTANCE_RETRIES = 10
export const SINGLE_INSTANCE_RETRY_DELAY_MS = 1500
export const DEFAULT_STARTUP_TIMEOUT_MS = 12_000
export const DEFAULT_HEALTH_POLL_MS = 250
export const DEFAULT_HEALTH_PROBE_TIMEOUT_MS = 800
export const DEFAULT_SHUTDOWN_GRACE_MS = 5_000
export const HEARTBEAT_INTERVAL_MS = 2_000
export const WATCHDOG_INTERVAL_MS = 2_000

export interface HealthPayload {
  ok?: boolean
  app?: string
  apiVersion?: string
  version?: string
  bootId?: string
  uptimeMs?: number
  db?: string
  engine?: string
}

export interface HealthProbe {
  reachable: boolean
  statusCode?: number
  body?: HealthPayload
  error?: string
}

export interface BackendPidRecord {
  pid: number
  port: number
  bootId: string
  startedAt?: string
  argvHash?: string
}

export interface BackendSpawnSpec {
  command: string
  args: string[]
  env: NodeJS.ProcessEnv
  cwd: string
}

export interface BackendHandle {
  pid: number
  port: number
  bootId: string
}

export interface BackendExitInfo {
  code: number | null
  signal: NodeJS.Signals | null
  reason: 'exit' | 'watchdog' | 'spawn-error'
  error?: Error
}

export interface BackendManagerOptions {
  dataDir: string
  stateDir: string
  logDir: string
  heartbeatFile: string
  backendPidFile: string
  alternateBackendPidFiles?: string[]
  backendLogFile: string
  logger: Logger
  repoRoot: string
  bootId?: string
  token?: string
  portBase?: number
  portCount?: number
  startupTimeoutMs?: number
  healthPollMs?: number
  healthProbeTimeoutMs?: number
  shutdownGraceMs?: number
  heartbeatIntervalMs?: number
  watchdogIntervalMs?: number
  /** Overrides the default `uv run ...` command (whitespace/quotes, no shell). */
  backendCommand?: string
  onExit?: (info: BackendExitInfo) => void
  spawnFn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess
}

export function generateToken(): string {
  return randomBytes(32).toString('hex')
}

export function generateBootId(): string {
  return randomUUID()
}

/** The SPA receives the token as a query parameter (M3 contract). */
export function buildAppUrl(port: number, token: string): string {
  return `http://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`
}

export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Split an override command into argv without invoking a shell.
 * Supports single/double quotes and backslash escapes. Backslashes that are
 * part of a Windows path are preserved (`"C:\Program Files\app.exe"`).
 */
export function splitCommandLine(input: string): string[] {
  const argv: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let hasValue = false

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index] as string
    if (char === '\\' && quote !== "'") {
      const next = input[index + 1]
      if (quote === '"') {
        // Inside double quotes only \" and \\ are escapes; keep path separators.
        if (next === '"' || next === '\\') {
          current += next
          index += 1
        } else {
          current += '\\'
        }
      } else if (next !== undefined && (/\s/.test(next) || next === '"' || next === "'")) {
        // Outside quotes: escape whitespace/quotes; otherwise keep the backslash.
        current += next
        index += 1
      } else {
        current += '\\'
      }
      hasValue = true
      continue
    }
    if (char === '"' || char === "'") {
      if (quote === char) {
        quote = null
      } else if (quote === null) {
        quote = char
      } else {
        current += char
      }
      hasValue = true
      continue
    }
    if (quote === null && /\s/.test(char)) {
      if (hasValue) {
        argv.push(current)
        current = ''
        hasValue = false
      }
      continue
    }
    current += char
    hasValue = true
  }

  if (quote) throw new Error('AUTOAGENT_BACKEND_CMD has an unterminated quote')
  if (hasValue) argv.push(current)
  if (argv.length === 0) throw new Error('AUTOAGENT_BACKEND_CMD is empty')
  return argv
}

/**
 * Build the backend argv/env. No shell, no string interpolation: argv is an
 * array and the token is passed through the environment only. The port appears
 * both as argv (for the real backend) and env (for test stubs).
 */
export function buildBackendSpawnSpec(params: {
  repoRoot: string
  dataDir: string
  stateDir: string
  logDir: string
  heartbeatFile: string
  port: number
  token: string
  bootId: string
  backendCommand?: string
  baseEnv?: NodeJS.ProcessEnv
}): BackendSpawnSpec {
  const baseEnv = params.baseEnv ?? process.env
  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    AUTOAGENT_PORT: String(params.port),
    AUTOAGENT_BIND: '127.0.0.1',
    AUTOAGENT_TOKEN: params.token,
    AUTOAGENT_API_TOKEN: params.token,
    AUTOAGENT_BOOT_ID: params.bootId,
    AUTOAGENT_PARENT_PID: String(process.pid),
    AUTOAGENT_DESKTOP_PID: String(process.pid),
    AUTOAGENT_DATA_DIR: params.dataDir,
    AUTOAGENT_STATE_DIR: params.stateDir,
    AUTOAGENT_LOG_DIR: params.logDir,
    AUTOAGENT_DESKTOP_HEARTBEAT: params.heartbeatFile,
    AUTOAGENT_ENGINE: baseEnv.AUTOAGENT_ENGINE ?? 'matebot',
    AUTOAGENT_CONFIG_DIR:
      nonEmpty(baseEnv.AUTOAGENT_CONFIG_DIR) ?? join(homedir(), '.autoagent'),
    PYTHONUNBUFFERED: '1',
    PYTHONIOENCODING: 'utf-8',
  }

  const matebotVendorOverride = nonEmpty(baseEnv.AUTOAGENT_MATEBOT_VENDOR_DIR)

  if (params.backendCommand && params.backendCommand.trim().length > 0) {
    const [command, ...args] = splitCommandLine(params.backendCommand)
    if (!command) throw new Error('AUTOAGENT_BACKEND_CMD is empty')
    return { command, args, env, cwd: params.repoRoot }
  }

  // Packaged mode: one fixed executable under /opt/autoagent. Never a shell,
  // never `uv`, and the engine/frontend locations are explicit so the backend
  // does not have to guess from its own install layout.
  const install = resolveInstallPaths(baseEnv)
  if (install.packaged) {
    return {
      command: install.backendBinary,
      args: [
        '--host',
        '127.0.0.1',
        '--port',
        String(params.port),
        '--data-dir',
        params.stateDir,
      ],
      env: {
        ...env,
        AUTOAGENT_APP_DIR: install.appDir,
        AUTOAGENT_PACKAGED: '1',
        AUTOAGENT_ENGINE_DIR: install.engineDir,
        AUTOAGENT_FRONTEND_DIST: install.frontendDist,
        AUTOAGENT_BUN_PATH: install.bunPath,
        AUTOAGENT_OPENCC_CLI_PATH: install.openccCliPath,
        AUTOAGENT_MATEBOT_VENDOR_DIR: resolve(
          matebotVendorOverride ?? join(install.appDir, 'vendor', 'matebot'),
        ),
      },
      cwd: install.appDir,
    }
  }

  // The frozen M3 argv passes the state root as `--data-dir`; the backend
  // keeps SQLite and `.claude` there, while AUTOAGENT_STATE_DIR still selects
  // the runtime/log root. This mirrors the packaged launcher layout.
  return {
    command: 'uv',
    args: [
      'run',
      '--directory', join(params.repoRoot, 'backend'),
      'python', '-m', 'autoagent_backend',
      '--host', '127.0.0.1',
      '--port', String(params.port),
      '--data-dir', params.stateDir,
    ],
    env: {
      ...env,
      AUTOAGENT_MATEBOT_VENDOR_DIR: resolve(
        matebotVendorOverride ?? join(params.repoRoot, 'vendor', 'matebot'),
      ),
    },
    cwd: params.repoRoot,
  }
}

export function requestHealth(
  port: number,
  timeoutMs = DEFAULT_HEALTH_PROBE_TIMEOUT_MS,
): Promise<HealthProbe> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (probe: HealthProbe): void => {
      if (settled) return
      settled = true
      resolve(probe)
    }

    const request = http.get(
      { host: '127.0.0.1', port, path: '/api/health', timeout: timeoutMs },
      (response) => {
        let body = ''
        response.setEncoding('utf8')
        response.on('data', (chunk: string) => {
          if (body.length < 65_536) body += chunk
        })
        response.on('end', () => {
          let parsed: HealthPayload | undefined
          try {
            parsed = JSON.parse(body) as HealthPayload
          } catch {
            parsed = undefined
          }
          finish({ reachable: true, statusCode: response.statusCode, body: parsed })
        })
        response.on('error', (error) => finish({ reachable: false, error: error.message }))
      },
    )

    request.on('timeout', () => {
      request.destroy()
      finish({ reachable: false, error: 'timeout' })
    })
    request.on('error', (error) => finish({ reachable: false, error: error.message }))
  })
}

export interface WaitForHealthOptions {
  port: number
  bootId: string
  timeoutMs?: number
  initialDelayMs?: number
  maxDelayMs?: number
  logger?: Logger
  probe?: (port: number, timeoutMs: number) => Promise<HealthProbe>
  isAlive?: () => boolean
}

/** Poll /api/health with bounded exponential backoff. */
export async function waitForHealth(options: WaitForHealthOptions): Promise<HealthPayload> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS
  const probeTimeoutMs = Math.min(DEFAULT_HEALTH_PROBE_TIMEOUT_MS, timeoutMs)
  const probe = options.probe ?? requestHealth
  const deadline = Date.now() + timeoutMs
  const maxDelay = options.maxDelayMs ?? 1_000
  let delay = options.initialDelayMs ?? DEFAULT_HEALTH_POLL_MS
  let attempt = 0
  let lastError = 'no response'

  while (Date.now() < deadline) {
    if (options.isAlive && !options.isAlive()) {
      throw new Error(`backend exited before becoming healthy (last probe: ${lastError})`)
    }
    attempt += 1
    const result = await probe(options.port, probeTimeoutMs)
    const body = result.body
    if (
      result.reachable
      && result.statusCode === 200
      && body?.ok === true
      && body.app === 'autoagent'
      && body.bootId === options.bootId
      && body.db === 'ok'
    ) {
      options.logger?.info('backend.health.ok', { port: options.port, attempts: attempt })
      return body
    }

    if (result.reachable && body?.bootId && body.bootId !== options.bootId) {
      lastError = `bootId mismatch (got ${String(body.bootId).slice(0, 8)}…)`
    } else if (result.reachable) {
      lastError = `status=${String(result.statusCode)} db=${String(body?.db)}`
    } else {
      lastError = result.error ?? 'unreachable'
    }
    options.logger?.debug('backend.health.wait', { attempt, error: lastError })

    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    await new Promise((resolve) => setTimeout(resolve, Math.min(delay, remaining)))
    delay = Math.min(Math.round(delay * 1.5), maxDelay)
  }

  throw new Error(
    `backend did not become healthy within ${timeoutMs} ms on port ${options.port}: ${lastError}`,
  )
}

async function commandLineOf(pid: number): Promise<string | null> {
  try {
    if (process.platform === 'linux') {
      const raw = await readFile(`/proc/${pid}/cmdline`, 'utf8')
      return raw.replace(/\0/g, ' ').trim()
    }
    if (process.platform === 'darwin') {
      const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'command='])
      return stdout.trim()
    }
    if (process.platform === 'win32') {
      const { stdout } = await execFileAsync('tasklist', [
        '/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH',
      ])
      return stdout.trim()
    }
  } catch {
    return null
  }
  return null
}

/**
 * Never kill an unverified process. On platforms where the command line cannot
 * be inspected we fail closed and skip the port.
 */
export async function verifyAutoAgentBackend(pid: number): Promise<boolean> {
  const command = await commandLineOf(pid)
  if (!command) return false
  const lower = command.toLowerCase()
  if (lower.includes('autoagent_backend') || lower.includes('autoagent-backend')) {
    return true
  }
  if (process.platform === 'win32') {
    const image = lower.split(',')[0]?.replace(/"/g, '') ?? ''
    return image.includes('python') || image.includes('uv.exe') || image.includes('uv')
  }
  return false
}

export async function readBackendPidFile(file: string): Promise<BackendPidRecord | null> {
  try {
    const raw = (await readFile(file, 'utf8')).trim()
    if (!raw) return null

    // The frozen runtime contract is JSON, but early backend builds wrote a bare
    // PID. Accept both so PID verification works during the M3 transition.
    if (/^[1-9][0-9]*$/.test(raw)) {
      const pid = Number(raw)
      return Number.isSafeInteger(pid) ? { pid, port: 0, bootId: '' } : null
    }

    const parsed = JSON.parse(raw) as Partial<BackendPidRecord>
    if (
      typeof parsed.pid === 'number'
      && Number.isInteger(parsed.pid)
      && parsed.pid > 0
    ) {
      return {
        pid: parsed.pid,
        port: typeof parsed.port === 'number' ? parsed.port : 0,
        bootId: typeof parsed.bootId === 'string' ? parsed.bootId : '',
        startedAt: parsed.startedAt,
        argvHash: parsed.argvHash,
      }
    }
    return null
  } catch {
    return null
  }
}

function signalProcessTree(pid: number, signal: NodeJS.Signals): void {
  if (process.platform === 'win32') {
    try {
      process.kill(pid, signal)
    } catch {
      // already gone
    }
    return
  }
  try {
    process.kill(-pid, signal)
  } catch {
    try {
      process.kill(pid, signal)
    } catch {
      // already gone
    }
  }
}

async function waitForPidExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return true
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return !isPidAlive(pid)
}

/** TERM → grace → KILL. Idempotent and safe to call on a dead pid. */
export async function terminateProcessTree(
  pid: number,
  graceMs = DEFAULT_SHUTDOWN_GRACE_MS,
  logger?: Logger,
): Promise<boolean> {
  if (!isPidAlive(pid)) return true
  logger?.warn('backend.terminate', { pid, signal: 'SIGTERM', graceMs })
  signalProcessTree(pid, 'SIGTERM')
  if (await waitForPidExit(pid, graceMs)) return true

  logger?.warn('backend.terminate', { pid, signal: 'SIGKILL' })
  signalProcessTree(pid, 'SIGKILL')
  if (!(await waitForPidExit(pid, 2_000)) && process.platform === 'win32') {
    try {
      await execFileAsync('taskkill', ['/PID', String(pid), '/T', '/F'])
    } catch {
      // best effort
    }
  }
  return !isPidAlive(pid)
}

export interface ChoosePortOptions {
  portBase?: number
  portCount?: number
  pidFile: string
  /** Older layouts wrote the pid file under <data>/runtime. */
  alternatePidFiles?: string[]
  logger?: Logger
  probe?: (port: number, timeoutMs: number) => Promise<HealthProbe>
  graceMs?: number
}

export interface ChoosePortResult {
  port: number
  reused: boolean
}

/**
 * Pick a loopback port. A port occupied by a *verified* AutoAgent backend is
 * reclaimed (SIGTERM → SIGKILL) rather than skipped: two backends writing the
 * same SQLite file is worse than a short restart. An unverified responder is
 * never killed.
 */
export async function choosePort(options: ChoosePortOptions): Promise<ChoosePortResult> {
  const portBase = options.portBase ?? BASE_PORT
  const portCount = options.portCount ?? PORT_SCAN_COUNT
  const probe = options.probe ?? requestHealth

  for (let offset = 0; offset < portCount; offset += 1) {
    const port = portBase + offset
    const result = await probe(port, DEFAULT_HEALTH_PROBE_TIMEOUT_MS)
    if (!result.reachable) {
      options.logger?.info('backend.port.selected', { port, reused: false })
      return { port, reused: false }
    }

    const body = result.body
    if (body?.ok === true && body.app === 'autoagent') {
      let record = await readBackendPidFile(options.pidFile)
      for (const alternate of options.alternatePidFiles ?? []) {
        if (record) break
        record = await readBackendPidFile(alternate)
      }
      if (!record) {
        options.logger?.warn('backend.port.foreign', { port, reason: 'no pid file' })
        continue
      }
      if (body.bootId && record.bootId && record.bootId !== body.bootId) {
        options.logger?.warn('backend.port.foreign', { port, reason: 'bootId mismatch' })
        continue
      }
      if (!isPidAlive(record.pid) || record.pid === process.pid) {
        options.logger?.warn('backend.port.foreign', { port, reason: 'pid not alive' })
        continue
      }
      if (!(await verifyAutoAgentBackend(record.pid))) {
        options.logger?.warn('backend.port.foreign', { port, reason: 'process not verified' })
        continue
      }

      options.logger?.warn('backend.port.reclaim', { port, pid: record.pid })
      const stopped = await terminateProcessTree(
        record.pid,
        options.graceMs ?? 3_000,
        options.logger,
      )
      if (!stopped) {
        options.logger?.warn('backend.port.reclaim-failed', { port, pid: record.pid })
        continue
      }
      const deadline = Date.now() + 3_000
      while (Date.now() < deadline) {
        const after = await probe(port, DEFAULT_HEALTH_PROBE_TIMEOUT_MS)
        if (!after.reachable) break
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      options.logger?.info('backend.port.selected', { port, reused: true })
      return { port, reused: true }
    }

    options.logger?.warn('backend.port.foreign', { port, reason: 'not an AutoAgent backend' })
  }

  throw new Error(
    `all ports ${portBase}-${portBase + portCount - 1} are occupied; `
    + 'stop the process holding them and retry',
  )
}

/**
 * Retry the Electron single-instance lock. After an update the old instance may
 * still be shutting down; giving up immediately makes the app appear to vanish.
 */
export async function acquireSingleInstanceLock(
  requestLock: () => boolean,
  options: {
    retries?: number
    retryDelayMs?: number
    logger?: Logger
  } = {},
): Promise<boolean> {
  const retries = options.retries ?? SINGLE_INSTANCE_RETRIES
  const retryDelayMs = options.retryDelayMs ?? SINGLE_INSTANCE_RETRY_DELAY_MS

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    if (requestLock()) return true
    if (attempt === 1) {
      options.logger?.warn('single-instance.wait', { reason: 'lock held' })
    }
    if (attempt < retries) {
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs))
    }
  }
  options.logger?.error('single-instance.failed', { retries })
  return false
}

export class BackendManager {
  readonly bootId: string
  readonly token: string
  readonly pidFile: string
  private readonly options: BackendManagerOptions
  private readonly logger: Logger
  private child: ChildProcess | null = null
  private childPid: number | null = null
  private selectedPort = 0
  private startPromise: Promise<BackendHandle> | null = null
  private shutdownPromise: Promise<void> | null = null
  private stopping = false
  private heartbeatTimer: NodeJS.Timeout | null = null
  private watchdogTimer: NodeJS.Timeout | null = null
  private logStream: ReturnType<typeof createWriteStream> | null = null
  private exitNotified = false
  /** Once healthy, an exit means the running app must shut down. Before that,
   *  start() reports the failure to the caller instead. */
  private ready = false

  constructor(options: BackendManagerOptions) {
    this.options = options
    this.logger = options.logger
    this.bootId = options.bootId ?? generateBootId()
    this.token = options.token ?? generateToken()
    this.pidFile = options.backendPidFile
    this.logger.registerSecret(this.token)
  }

  get port(): number {
    return this.selectedPort
  }

  get pid(): number | null {
    return this.childPid
  }

  isRunning(): boolean {
    return !this.stopping && this.childPid !== null && isPidAlive(this.childPid)
  }

  start(): Promise<BackendHandle> {
    if (this.startPromise) return this.startPromise
    this.startPromise = this.startInternal().catch((error: unknown) => {
      this.startPromise = null
      throw error
    })
    return this.startPromise
  }

  private async startInternal(): Promise<BackendHandle> {
    const { dataDir, stateDir, logDir, heartbeatFile } = this.options
    await Promise.all([
      mkdir(dataDir, { recursive: true }),
      mkdir(stateDir, { recursive: true }),
      mkdir(logDir, { recursive: true }),
      mkdir(dirname(heartbeatFile), { recursive: true }),
      mkdir(dirname(this.options.backendPidFile), { recursive: true }),
    ])

    this.logger.info('backend.start', {
      bootId: this.bootId,
      dataDir,
      stateDir,
      logFile: this.options.backendLogFile,
    })

    const chosen = await choosePort({
      portBase: this.options.portBase,
      portCount: this.options.portCount,
      pidFile: this.options.backendPidFile,
      alternatePidFiles: this.options.alternateBackendPidFiles,
      logger: this.logger,
    })
    this.selectedPort = chosen.port

    this.writeHeartbeat()
    this.heartbeatTimer = setInterval(
      () => this.writeHeartbeat(),
      this.options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS,
    )
    this.heartbeatTimer.unref()

    const spec = buildBackendSpawnSpec({
      repoRoot: this.options.repoRoot,
      dataDir,
      stateDir,
      logDir,
      heartbeatFile,
      port: this.selectedPort,
      token: this.token,
      bootId: this.bootId,
      backendCommand: this.options.backendCommand,
    })

    this.logStream = createWriteStream(this.options.backendLogFile, { flags: 'a' })
    this.logStream.on('error', () => {
      // Losing the log must never take the app down.
    })

    this.logger.info('backend.spawn', {
      command: spec.command,
      args: spec.args,
      port: this.selectedPort,
      bootId: this.bootId,
    })

    const spawnFn = this.options.spawnFn ?? spawn
    const child = spawnFn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    })
    this.child = child
    this.childPid = child.pid ?? null

    child.stdout?.pipe(this.logStream, { end: false })
    child.stderr?.pipe(this.logStream, { end: false })

    child.on('error', (error) => {
      this.logger.error('backend.spawn-error', { message: error.message })
      this.handleChildExit(null, null, 'spawn-error', error)
    })
    child.on('exit', (code, signal) => {
      this.handleChildExit(code, signal, 'exit')
    })

    if (this.childPid === null) {
      await this.shutdown('spawn failed without pid')
      throw new Error(`failed to spawn backend: ${spec.command}`)
    }

    try {
      await waitForHealth({
        port: this.selectedPort,
        bootId: this.bootId,
        timeoutMs: this.options.startupTimeoutMs,
        initialDelayMs: this.options.healthPollMs,
        logger: this.logger,
        isAlive: () => this.childPid !== null && isPidAlive(this.childPid),
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const redacted = redactSecrets(message)
      this.logger.error('backend.health.timeout', {
        port: this.selectedPort,
        message: redacted,
        logFile: this.options.backendLogFile,
      })
      await this.shutdown('startup health failure')
      throw new Error(
        `backend failed to start on port ${this.selectedPort}: ${redacted}. `
        + `See ${this.options.backendLogFile}`,
      )
    }

    this.watchdogTimer = setInterval(() => {
      if (this.stopping || this.childPid === null) return
      if (!isPidAlive(this.childPid)) {
        this.logger.error('backend.watchdog.dead', { pid: this.childPid })
        this.handleChildExit(null, null, 'watchdog')
      }
    }, this.options.watchdogIntervalMs ?? WATCHDOG_INTERVAL_MS)
    this.watchdogTimer.unref()

    this.logger.info('backend.ready', {
      port: this.selectedPort,
      pid: this.childPid,
      bootId: this.bootId,
      reusedPort: chosen.reused,
    })
    this.ready = true

    return { pid: this.childPid, port: this.selectedPort, bootId: this.bootId }
  }

  private writeHeartbeat(): void {
    const payload = JSON.stringify({
      pid: process.pid,
      bootId: this.bootId,
      timestamp: new Date().toISOString(),
    })
    void writeFile(this.options.heartbeatFile, payload, 'utf8').catch(() => undefined)
  }

  private handleChildExit(
    code: number | null,
    signal: NodeJS.Signals | null,
    reason: BackendExitInfo['reason'],
    error?: Error,
  ): void {
    const pid = this.childPid
    this.childPid = null
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer)
      this.watchdogTimer = null
    }
    if (this.stopping || this.exitNotified) return
    this.exitNotified = true

    this.logger.warn('backend.exit', { pid, code, signal, reason })
    if (!this.ready) return
    this.options.onExit?.({ code, signal, reason, error })
  }

  private async removeOwnRuntimeFiles(): Promise<void> {
    try {
      const record = await readBackendPidFile(this.options.backendPidFile)
      if (record && record.bootId === this.bootId) {
        await unlink(this.options.backendPidFile)
      }
    } catch {
      // best effort
    }
    try {
      await unlink(this.options.heartbeatFile)
    } catch {
      // best effort
    }
  }

  /** One idempotent shutdown path. */
  shutdown(reason = ''): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise
    this.shutdownPromise = this.doShutdown(reason)
    return this.shutdownPromise
  }

  private async doShutdown(reason: string): Promise<void> {
    this.stopping = true
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer)
      this.watchdogTimer = null
    }

    const pid = this.childPid
    this.logger.info('backend.shutdown.begin', { reason, pid })
    if (pid !== null) {
      const exited = await terminateProcessTree(
        pid,
        this.options.shutdownGraceMs ?? DEFAULT_SHUTDOWN_GRACE_MS,
        this.logger,
      )
      if (!exited) {
        this.logger.error('backend.shutdown.kill-failed', { pid })
      }
      this.childPid = null
    }

    await this.removeOwnRuntimeFiles()

    if (this.logStream) {
      await new Promise<void>((resolve) => {
        this.logStream?.end(() => resolve())
        setTimeout(resolve, 1_000).unref()
      })
      this.logStream = null
    }

    this.logger.info('backend.shutdown.done', { reason, pid })
    await this.logger.flush()
  }
}
