import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const rootDir = process.cwd()
const pkg = JSON.parse(readFileSync(path.join(rootDir, 'package.json'), 'utf8'))
const outputDir = pkg.build?.directories?.output ?? 'release'
const argv = process.argv.slice(2)

function resolveBunBinary() {
  const candidates = [
    process.env.BUN_BIN,
    path.join(rootDir, 'build-resources', 'bun_runtime.exe'),
    path.join(rootDir, 'node_modules', '.bin', process.platform === 'win32' ? 'bun.exe' : 'bun'),
    process.platform === 'win32' ? 'bun.exe' : 'bun',
    'bun',
  ].filter(Boolean)

  for (const candidate of candidates) {
    if (candidate === 'bun' || candidate === 'bun.exe') {
      return candidate
    }
    if (existsSync(candidate)) return candidate
  }

  return null
}

function resolveElectronBuilderCli() {
  const candidates = [path.join(rootDir, 'node_modules', 'electron-builder', 'cli.js')]

  const bunStoreDir = path.join(rootDir, 'node_modules', '.bun')
  if (existsSync(bunStoreDir)) {
    for (const entry of readdirSync(bunStoreDir)) {
      if (!entry.startsWith('electron-builder@')) continue
      candidates.push(
        path.join(
          bunStoreDir,
          entry,
          'node_modules',
          'electron-builder',
          'cli.js',
        ),
      )
    }
  }

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }

  return null
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    shell: false,
    stdio: 'inherit',
    ...options,
  })

  if (result.error) {
    throw result.error
  }
  if (result.status !== 0) {
    throw new Error(`Command failed with exit code ${result.status ?? 1}`)
  }
  return result
}

function runNoThrow(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: rootDir,
    shell: false,
    stdio: 'pipe',
    encoding: 'utf8',
    ...options,
  })
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function printUsage() {
  console.log(`Usage:
  node scripts/package-win-local.mjs
  node scripts/package-win-local.mjs --dir
  node scripts/package-win-local.mjs -- portable
  node scripts/package-win-local.mjs -- nsis

Behavior:
  1. Runs the desktop build with Bun
  2. Runs electron-builder for Windows x64 with local-safe defaults

Defaults:
  --win --x64 --config.win.signAndEditExecutable=false --config.npmRebuild=false
`)
}

function normalizedBuilderArgs(extraArgs) {
  const baseArgs = [
    '--win',
    '--x64',
    '--config.win.signAndEditExecutable=false',
    '--config.npmRebuild=false',
  ]

  if (extraArgs.length === 0) return baseArgs

  // Separate targets and extra flags from extraArgs
  const restArgs = extraArgs[0] === '--' ? extraArgs.slice(1) : extraArgs
  const targets = restArgs.filter(a => !a.startsWith('--'))
  const flags = restArgs.filter(a => a.startsWith('--'))

  // Insert targets right after --win
  const winIdx = baseArgs.indexOf('--win')
  const result = [...baseArgs]
  if (winIdx >= 0 && targets.length > 0) {
    result.splice(winIdx + 1, 0, ...targets)
  }

  return [...result, ...flags]
}

function isWindowsLockError(message) {
  const normalized = message.toLowerCase()
  return (
    normalized.includes('being used by another process') ||
    normalized.includes('cannot access the file') ||
    normalized.includes('app.asar') ||
    normalized.includes('ensureemptydir')
  )
}

async function stopLikelyLockingProcesses() {
  if (process.platform !== 'win32') return

  const releaseExe = path.join(rootDir, outputDir, 'win-unpacked', 'AutoAgent.exe')
  const taskkillArgs = ['/F', '/T', '/IM', 'AutoAgent.exe', '/IM', 'electron.exe']
  runNoThrow('taskkill.exe', taskkillArgs)

  if (existsSync(releaseExe)) {
    runNoThrow('taskkill.exe', ['/F', '/T', '/FI', `IMAGENAME eq ${path.basename(releaseExe)}`])
  }

  await sleep(1200)
}

async function cleanPackagingOutputs() {
  const dirs = [
    path.join(rootDir, outputDir, 'win-unpacked'),
    path.join(rootDir, outputDir, 'builder-effective-config.yaml'),
  ]

  for (const target of dirs) {
    if (!existsSync(target)) continue
    await rm(target, {
      recursive: true,
      force: true,
      maxRetries: 8,
      retryDelay: 500,
    })
  }
}

async function prepareForPackaging() {
  console.log('[package] Cleaning previous Windows packaging outputs...')
  await stopLikelyLockingProcesses()
  await cleanPackagingOutputs()
}

async function runElectronBuilder(builderCli, builderArgs) {
  console.log('[package] Starting electron-builder...')
  run(process.execPath, [builderCli, ...builderArgs], {
    env: {
      ...process.env,
      CSC_IDENTITY_AUTO_DISCOVERY: 'false',
    },
  })
}

try {
  if (argv.includes('--help') || argv.includes('-h')) {
    printUsage()
    process.exit(0)
  }

  const bunBin = resolveBunBinary()
  if (!bunBin) {
    console.error('Unable to find Bun. Set BUN_BIN or build build-resources/bun_runtime.exe first.')
    process.exit(1)
  }

  const builderCli = resolveElectronBuilderCli()
  if (!builderCli) {
    console.error('Unable to find electron-builder CLI in local node_modules.')
    process.exit(1)
  }

  await prepareForPackaging()
  console.log('[package] Building desktop app assets...')
  run(bunBin, [path.join('scripts', 'build-desktop.mjs')])

  await runElectronBuilder(builderCli, normalizedBuilderArgs(argv))
  console.log('[package] Windows packaging completed.')
} catch (error) {
  const message = error instanceof Error ? error.message : String(error)
  if (message.includes('app-builder.exe') && message.includes('EPERM')) {
    console.error('\nLocal packaging was blocked while spawning app-builder.exe.')
    console.error('Try launching the terminal as Administrator, or move the repo out of a restricted directory.')
  } else if (isWindowsLockError(message)) {
    console.error('\nPackaging failed because a previous output file is still locked.')
    console.error('Close any running AutoAgent window, Explorer preview, or antivirus scan on release\\win-unpacked, then retry.')
  } else {
    console.error(`\nPackaging failed: ${message}`)
  }
  process.exit(1)
}
