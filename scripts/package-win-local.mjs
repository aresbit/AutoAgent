import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const rootDir = process.cwd()
const packageJsonPath = path.join(rootDir, 'package.json')
const packageJsonRaw = readFileSync(packageJsonPath, 'utf8')
const pkg = JSON.parse(packageJsonRaw)
const outputDir = pkg.build?.directories?.output ?? 'release'
const argv = process.argv.slice(2)
const SEMVER_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/

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
    timeout: 8000,
    ...options,
  })
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function printUsage() {
  console.log(`Usage:
  node scripts/package-win-local.mjs
  node scripts/package-win-local.mjs 0.8.0
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

function extractVersionOverride(args) {
  const copy = [...args]
  const first = copy[0]
  if (first && !first.startsWith('-') && SEMVER_RE.test(first)) {
    return { versionOverride: first, builderArgs: copy.slice(1) }
  }
  return { versionOverride: null, builderArgs: copy }
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
  console.log('[package] Stopping likely locking AutoAgent processes...')
  runNoThrow('taskkill.exe', ['/F', '/T', '/IM', 'AutoAgent.exe'])

  if (existsSync(releaseExe)) {
    runNoThrow('taskkill.exe', ['/F', '/T', '/FI', `IMAGENAME eq ${path.basename(releaseExe)}`])
  }

  await sleep(1200)
}

async function cleanPackagingOutputs() {
  const targets = [
    path.join(rootDir, outputDir, 'win-unpacked'),
    path.join(rootDir, outputDir, 'win-ia32-unpacked'),
    path.join(rootDir, outputDir, 'win-arm64-unpacked'),
    path.join(rootDir, outputDir, 'builder-effective-config.yaml'),
  ]

  for (const target of targets) {
    if (!existsSync(target)) continue
    console.log(`[package] Removing ${path.relative(rootDir, target) || target}...`)
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

async function withTemporaryPackageVersion(versionOverride, fn) {
  if (!versionOverride) {
    return fn()
  }

  console.log(`[package] Using temporary package version ${versionOverride}...`)
  const nextPkg = { ...pkg, version: versionOverride }
  await writeFile(packageJsonPath, `${JSON.stringify(nextPkg, null, 2)}\n`, 'utf8')

  try {
    return await fn()
  } finally {
    await writeFile(packageJsonPath, packageJsonRaw, 'utf8')
  }
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

  const { versionOverride, builderArgs } = extractVersionOverride(argv)

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

  await withTemporaryPackageVersion(versionOverride, async () => {
    await prepareForPackaging()
    console.log('[package] Building desktop app assets...')
    run(bunBin, [path.join('scripts', 'build-desktop.mjs')])

    await runElectronBuilder(builderCli, normalizedBuilderArgs(builderArgs))
    console.log('[package] Windows packaging completed.')
  })
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
