param(
  [string]$WorkspaceRoot,
  [switch]$PrepareWorkspace
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $WorkspaceRoot) {
  $WorkspaceRoot = Join-Path $repoRoot 'work\official_app'
}

$stagingExtract = Join-Path $WorkspaceRoot 'staging\telegram_extract'
$outputAsar = Join-Path $WorkspaceRoot 'staging\app.telegram.official.asar'

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

if ($PrepareWorkspace -or -not (Test-Path $stagingExtract)) {
  $stageArgs = @(
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', (Join-Path $PSScriptRoot 'stage_official_app_telegram.ps1'),
    '-WorkspaceRoot', $WorkspaceRoot
  )
  if ($PrepareWorkspace) {
    $stageArgs += '-PrepareWorkspace'
  }
  & powershell.exe @stageArgs
  if ($LASTEXITCODE -ne 0) {
    throw "stage_official_app_telegram.ps1 failed with exit code $LASTEXITCODE"
  }
}

if (-not (Test-Path $stagingExtract)) {
  throw "Official Telegram staging extract not found: $stagingExtract"
}

Push-Location $repoRoot
try {
  Invoke-External 'node.exe' @(
    '.\scripts\rebuild_patched_asar.mjs',
    '--source-dir',
    $stagingExtract,
    '--output-asar',
    $outputAsar
  )
}
finally {
  Pop-Location
}

$hash = Get-FileHash -Algorithm SHA256 $outputAsar

Write-Output "OFFICIAL_STAGE_ASAR_READY $outputAsar"
Write-Output "OFFICIAL_STAGE_ASAR_SHA256 $($hash.Hash)"
