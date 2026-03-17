param(
  [string]$WorkspaceRoot,
  [switch]$PrepareWorkspace
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $WorkspaceRoot) {
  $WorkspaceRoot = Join-Path $repoRoot 'work\official_app'
}

$sourcePackageRoot = Join-Path $WorkspaceRoot 'package_root'
$stagedPackageRoot = Join-Path $WorkspaceRoot 'staging\package_root_telegram'
$sourceAsar = Join-Path $WorkspaceRoot 'staging\app.telegram.official.asar'
$targetAsar = Join-Path $stagedPackageRoot 'app\resources\app.asar'
$targetExe = Join-Path $stagedPackageRoot 'app\Codex.exe'

function Invoke-External {
  param(
    [string]$FilePath,
    [string[]]$Arguments
  )

  & $FilePath @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Command failed with exit code ${LASTEXITCODE}: $FilePath $($Arguments -join ' ')"
  }
}

if ($PrepareWorkspace -or -not (Test-Path $sourceAsar)) {
  $buildArgs = @(
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', (Join-Path $PSScriptRoot 'build_official_stage_bundle.ps1'),
    '-WorkspaceRoot', $WorkspaceRoot
  )
  if ($PrepareWorkspace) {
    $buildArgs += '-PrepareWorkspace'
  }
  & powershell.exe @buildArgs
  if ($LASTEXITCODE -ne 0) {
    throw "build_official_stage_bundle.ps1 failed with exit code $LASTEXITCODE"
  }
}

if (-not (Test-Path $sourcePackageRoot)) {
  throw "Official package root not found: $sourcePackageRoot"
}
if (-not (Test-Path $sourceAsar)) {
  throw "Official staged asar not found: $sourceAsar"
}

New-Item -ItemType Directory -Force (Split-Path -Parent $stagedPackageRoot) | Out-Null
robocopy $sourcePackageRoot $stagedPackageRoot /MIR /R:1 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
Copy-Item $sourceAsar $targetAsar -Force

Push-Location $repoRoot
try {
  Invoke-External 'node.exe' @(
    '.\scripts\update_asar_integrity.mjs',
    '--exe-path',
    $targetExe,
    '--asar-path',
    $targetAsar,
    '--relative-asar-path',
    'resources\app.asar'
  )
}
finally {
  Pop-Location
}

$asarHash = Get-FileHash -Algorithm SHA256 $targetAsar
$exeHash = Get-FileHash -Algorithm SHA256 $targetExe

Write-Output "OFFICIAL_STAGE_PACKAGE_READY $stagedPackageRoot"
Write-Output "OFFICIAL_STAGE_PACKAGE_ASAR $targetAsar"
Write-Output "OFFICIAL_STAGE_PACKAGE_ASAR_SHA256 $($asarHash.Hash)"
Write-Output "OFFICIAL_STAGE_PACKAGE_EXE $targetExe"
Write-Output "OFFICIAL_STAGE_PACKAGE_EXE_SHA256 $($exeHash.Hash)"
