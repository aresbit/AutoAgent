import { cp, mkdir, rename, rm, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const rootDir = process.cwd()
const bunBin = process.execPath

function runBun(args) {
  const result = spawnSync(bunBin, args, {
    cwd: rootDir,
    stdio: 'inherit',
  })

  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}

async function safeRename(from, to) {
  if (existsSync(to)) {
    await rm(to, { force: true })
  }
  await rename(from, to)
}

async function safeCopy(from, to) {
  if (existsSync(to)) {
    await rm(to, { force: true })
  }
  await cp(from, to)
}

async function stageRuntimeBinary(from, to) {
  if (existsSync(to)) {
    try {
      const [fromStat, toStat] = await Promise.all([stat(from), stat(to)])
      if (fromStat.size === toStat.size) {
        return
      }
    } catch {}
    await rm(to, { force: true })
  }
  await cp(from, to)
}

function findBundledRipgrep() {
  if (process.platform !== 'win32') return null

  const envCandidates = [
    process.env.RG_BIN,
    process.env.RIPGREP_BIN,
  ].filter(Boolean)

  for (const candidate of envCandidates) {
    if (existsSync(candidate)) return candidate
  }

  const whereResult = spawnSync('where.exe', ['rg'], {
    cwd: rootDir,
    encoding: 'utf8',
  })

  if (whereResult.status === 0) {
    const matches = `${whereResult.stdout || ''}`
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)

    const preferred = matches.find(match => match.toLowerCase().endsWith('rg.exe'))
    if (preferred && existsSync(preferred)) return preferred
  }

  return null
}

async function main() {
  runBun([
    'build',
    'src/main.ts',
    '--outdir',
    'dist',
    '--target',
    'node',
    '--external',
    'electron',
    '--external',
    '@anthropic-ai/sdk',
  ])

  runBun([
    'build',
    'src/preload.ts',
    '--outdir',
    'dist',
    '--target',
    'node',
    '--external',
    'electron',
  ])

  await safeRename(
    path.join(rootDir, 'dist', 'preload.js'),
    path.join(rootDir, 'dist', 'preload.mjs'),
  )

  await rm(path.join(rootDir, 'dist', 'client'), {
    recursive: true,
    force: true,
  })
  await mkdir(path.join(rootDir, 'dist', 'client'), { recursive: true })

  runBun([
    'build',
    'src/renderer/app.tsx',
    '--outdir',
    'dist/client',
    '--target',
    'browser',
    '--format',
    'esm',
  ])

  await cp(
    path.join(rootDir, 'src', 'renderer', 'index.html'),
    path.join(rootDir, 'dist', 'client', 'index.html'),
  )
  await cp(
    path.join(rootDir, 'src', 'renderer', 'style.css'),
    path.join(rootDir, 'dist', 'client', 'style.css'),
  )
  await safeCopy(
    path.join(rootDir, 'assets', 'icon.png'),
    path.join(rootDir, 'dist', 'icon.png'),
  )
  await safeCopy(
    path.join(rootDir, 'assets', 'icon.ico'),
    path.join(rootDir, 'dist', 'icon.ico'),
  )

  runBun([
    'build',
    'packages/opencc/src/entrypoints/cli.tsx',
    '--outdir',
    'packages/opencc/dist',
    '--target',
    'bun',
  ])

  await mkdir(path.join(rootDir, 'build-resources'), { recursive: true })
  await stageRuntimeBinary(
    bunBin,
    path.join(rootDir, 'build-resources', 'bun_runtime.exe'),
  )

  if (process.platform === 'win32') {
    const ripgrepPath = findBundledRipgrep()
    if (!ripgrepPath) {
      throw new Error(
        'Windows packaging requires rg.exe. Install ripgrep or set RG_BIN/RIPGREP_BIN before building.',
      )
    }
    await stageRuntimeBinary(
      ripgrepPath,
      path.join(rootDir, 'build-resources', 'rg.exe'),
    )
  }
}

await main()
