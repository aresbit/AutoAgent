import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

export type LogFields = Record<string, unknown>

export interface Logger {
  readonly file: string
  debug(event: string, fields?: LogFields): void
  info(event: string, fields?: LogFields): void
  warn(event: string, fields?: LogFields): void
  error(event: string, fields?: LogFields): void
  /** Register a value that must never appear in any log line (e.g. the token). */
  registerSecret(secret: string | undefined): void
  flush(): Promise<void>
}

export interface LoggerOptions {
  /** Optional stderr mirror for development. Off by default. */
  console?: boolean
}

/**
 * Redact well-known secret shapes plus any explicitly registered secret.
 * Callers must still avoid logging env dumps; this is a second line of defence.
 */
export function redactSecrets(input: string, secrets: Iterable<string> = []): string {
  let output = input
  for (const secret of secrets) {
    if (secret && secret.length >= 8) {
      output = output.split(secret).join('[redacted]')
    }
  }
  return output
    .replace(/([?&]token=)[^&\s"']+/gi, '$1[redacted]')
    .replace(/(AUTOAGENT_(?:API_)?TOKEN\s*[=:]\s*)[^\s"',}]+/gi, '$1[redacted]')
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s"',}]+/gi, '$1[redacted]')
}

function formatFields(fields: LogFields | undefined): string {
  if (!fields) return ''
  try {
    const json = JSON.stringify(fields)
    return json && json !== '{}' ? ` ${json}` : ''
  } catch {
    return ' {"fields":"<unserializable>"}'
  }
}

/**
 * Append-only desktop logger. Writes are serialized and failures are swallowed:
 * logging must never block startup or shutdown. It never writes into the
 * install directory (callers pass a state-dir path).
 */
export function createLogger(file: string, options: LoggerOptions = {}): Logger {
  const secrets = new Set<string>()
  let queue: Promise<void> = mkdir(dirname(file), { recursive: true }).then(() => undefined)

  function write(level: string, event: string, fields?: LogFields): void {
    const line = `${new Date().toISOString()} ${level} ${event}${formatFields(fields)}`
    const safe = redactSecrets(line, secrets)
    queue = queue
      .then(() => appendFile(file, `${safe}\n`, 'utf8'))
      .then(() => undefined)
      .catch(() => undefined)
    if (options.console) {
      process.stderr.write(`${safe}\n`)
    }
  }

  return {
    file,
    debug: (event, fields) => write('DEBUG', event, fields),
    info: (event, fields) => write('INFO', event, fields),
    warn: (event, fields) => write('WARN', event, fields),
    error: (event, fields) => write('ERROR', event, fields),
    registerSecret(secret) {
      if (secret) secrets.add(secret)
    },
    flush() {
      // Logging is best effort: shutdown must not hang on a stalled disk.
      const timeout = new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 1_000)
        timer.unref()
      })
      return Promise.race([queue, timeout])
    },
  }
}
