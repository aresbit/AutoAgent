#!/usr/bin/env node
/**
 * Build the thin Electron shell with Bun.
 *
 * Outputs (all under desktop/dist):
 *   entry.js            - AUTOAGENT_LEGACY switch (transpiled, imports kept intact)
 *   main.js             - modern lifecycle (bundled ESM)
 *   preload.cjs         - native-only preload (bundled CommonJS)
 *   artifact-preload.cjs - minimal preload for the artifact child window
 *   artifact-protocol.js - Electron-free protocol parser/handler for tests
 *   backend-manager.js  - standalone build so Node smoke tests can import it
 *   logging.js, paths.js - standalone helpers used by the smoke test
 *
 * `entry.ts` is intentionally built with --no-bundle: its legacy import must stay
 * a runtime dynamic import so that `AUTOAGENT_LEGACY=1` loads the untouched
 * `dist/main.js` produced by the root build, not a bundled copy of it.
 */
import { existsSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const src = join(here, 'src')
const dist = join(here, 'dist')
const bun = process.env.BUN || 'bun'

function run(args) {
  const result = spawnSync(bun, args, { cwd: here, stdio: 'inherit', env: process.env })
  if (result.error) {
    throw result.error
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}

function buildMain() {
  run([
    'build',
    join(src, 'main.ts'),
    '--outdir', dist,
    '--target', 'node',
    '--format', 'esm',
    '--external', 'electron',
  ])
}

function buildPreload() {
  run([
    'build',
    join(src, 'preload.ts'),
    '--outfile', join(dist, 'preload.cjs'),
    '--target', 'node',
    '--format', 'cjs',
    '--external', 'electron',
  ])
}

function buildArtifactPreload() {
  run([
    'build',
    join(src, 'artifact-preload.ts'),
    '--outfile', join(dist, 'artifact-preload.cjs'),
    '--target', 'node',
    '--format', 'cjs',
    '--external', 'electron',
  ])
}

function buildArtifactProtocolForTests() {
  run([
    'build',
    join(src, 'native', 'artifact-protocol.ts'),
    '--outfile', join(dist, 'artifact-protocol.js'),
    '--target', 'node',
    '--format', 'esm',
  ])
}

function buildPolicyAndMonitorForTests() {
  run([
    'build',
    join(src, 'native', 'preview-policy.ts'),
    '--outfile', join(dist, 'preview-policy.js'),
    '--target', 'node',
    '--format', 'esm',
  ])
  run([
    'build',
    join(src, 'stall-monitor.ts'),
    '--outfile', join(dist, 'stall-monitor.js'),
    '--target', 'node',
    '--format', 'esm',
  ])
}

function buildPreviewProtocolForTests() {
  run([
    'build',
    join(src, 'native', 'preview-protocol.ts'),
    '--outfile', join(dist, 'preview-protocol.js'),
    '--target', 'node',
    '--format', 'esm',
  ])
}

function buildEntry() {
  run([
    'build',
    join(src, 'entry.ts'),
    '--outfile', join(dist, 'entry.js'),
    '--target', 'node',
    '--format', 'esm',
    '--no-bundle',
  ])
}

function buildBackendManagerForTests() {
  run([
    'build',
    join(src, 'backend-manager.ts'),
    '--outfile', join(dist, 'backend-manager.js'),
    '--target', 'node',
    '--format', 'esm',
  ])
  run([
    'build',
    join(src, 'logging.ts'),
    '--outfile', join(dist, 'logging.js'),
    '--target', 'node',
    '--format', 'esm',
  ])
  run([
    'build',
    join(src, 'paths.ts'),
    '--outfile', join(dist, 'paths.js'),
    '--target', 'node',
    '--format', 'esm',
  ])
  run([
    'build',
    join(src, 'observability.ts'),
    '--outfile', join(dist, 'observability.js'),
    '--target', 'node',
    '--format', 'esm',
  ])
}

function verify() {
  for (const name of [
    'entry.js',
    'main.js',
    'preload.cjs',
    'artifact-preload.cjs',
    'artifact-protocol.js',
    'preview-policy.js',
    'stall-monitor.js',
    'preview-protocol.js',
    'backend-manager.js',
    'logging.js',
    'observability.js',
    'paths.js',
  ]) {
    const file = join(dist, name)
    if (!existsSync(file)) {
      process.stderr.write(`build: expected ${file} to exist\n`)
      process.exit(1)
    }
  }
}

rmSync(dist, { recursive: true, force: true })
buildMain()
buildPreload()
buildArtifactPreload()
buildArtifactProtocolForTests()
buildPolicyAndMonitorForTests()
buildPreviewProtocolForTests()
buildEntry()
buildBackendManagerForTests()
verify()
process.stdout.write(`build: desktop shell written to ${resolve(dist)}\n`)
