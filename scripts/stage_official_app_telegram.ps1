param(
  [string]$WorkspaceRoot,
  [switch]$PrepareWorkspace
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $WorkspaceRoot) {
  $WorkspaceRoot = Join-Path $repoRoot 'work\official_app'
}

$sourceExtract = Join-Path $WorkspaceRoot 'extract'
$stagingExtract = Join-Path $WorkspaceRoot 'staging\telegram_extract'

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

if ($PrepareWorkspace -or -not (Test-Path $sourceExtract)) {
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'prepare_official_app_workspace.ps1') -WorkspaceRoot $WorkspaceRoot
  if ($LASTEXITCODE -ne 0) {
    throw "prepare_official_app_workspace.ps1 failed with exit code $LASTEXITCODE"
  }
}

if (-not (Test-Path $sourceExtract)) {
  throw "Official extract root not found: $sourceExtract"
}

New-Item -ItemType Directory -Force (Split-Path -Parent $stagingExtract) | Out-Null
robocopy $sourceExtract $stagingExtract /MIR /R:1 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null

Push-Location $repoRoot
try {
  Invoke-External 'node.exe' @('.\scripts\inject_native_telegram.mjs', '--extract-dir', $stagingExtract)
  $buildJsFiles = Get-ChildItem -Path (Join-Path $stagingExtract '.vite\build') -Filter *.js -File | Sort-Object Name
  foreach ($buildJsFile in $buildJsFiles) {
    Invoke-External 'node.exe' @('--check', $buildJsFile.FullName)
  }
}
finally {
  Pop-Location
}

Write-Output "OFFICIAL_TELEGRAM_STAGING_READY $stagingExtract"
Write-Output "OFFICIAL_TELEGRAM_BUILD_DIR $(Join-Path $stagingExtract '.vite\build')"
