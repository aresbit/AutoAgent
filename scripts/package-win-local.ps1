$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$rootDir = Split-Path -Parent $scriptDir

Push-Location $rootDir
try {
  node .\scripts\package-win-local.mjs @Args
} finally {
  Pop-Location
}
