const { existsSync, readFileSync } = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

function resolveRceditBinary(projectDir) {
  const candidates = [
    path.join(process.env.LOCALAPPDATA || '', 'electron-builder', 'Cache', 'winCodeSign', 'rcedit-x64.exe'),
    path.join(projectDir, 'node_modules', '.bun', 'electron-winstaller@5.4.0', 'node_modules', 'electron-winstaller', 'vendor', 'rcedit.exe'),
  ]

  return candidates.find(candidate => candidate && existsSync(candidate)) || null
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    shell: false,
    stdio: 'pipe',
    encoding: 'utf8',
  })

  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(
      `Command failed (${result.status ?? 1}): ${command} ${args.join(' ')}\n${result.stderr || result.stdout}`,
    )
  }

  return result.stdout || ''
}

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return

  const projectDir = context.packager.projectDir
  const pkg = JSON.parse(readFileSync(path.join(projectDir, 'package.json'), 'utf8'))
  const version = pkg.version
  const appExe = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.exe`,
  )
  const iconPath = path.join(projectDir, 'assets', 'icon.ico')
  const rcedit = resolveRceditBinary(projectDir)

  if (!rcedit || !existsSync(appExe) || !existsSync(iconPath)) {
    return
  }

  for (let attempt = 1; attempt <= 5; attempt++) {
    run(rcedit, [
      appExe,
      '--set-icon',
      iconPath,
      '--set-version-string',
      'ProductName',
      'AutoAgent',
      '--set-version-string',
      'FileDescription',
      'AutoAgent',
      '--set-version-string',
      'OriginalFilename',
      path.basename(appExe),
      '--set-version-string',
      'InternalName',
      'AutoAgent',
      '--set-file-version',
      version,
      '--set-product-version',
      version,
    ], projectDir)

    const productName = run(rcedit, [appExe, '--get-version-string', 'ProductName'], projectDir).trim()
    if (productName === 'AutoAgent') return

    await new Promise(resolve => setTimeout(resolve, 1200))
  }

  throw new Error(`afterPack rcedit verification failed for ${appExe}`)
}
