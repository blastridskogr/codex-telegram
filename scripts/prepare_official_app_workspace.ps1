param(
  [string]$WorkspaceRoot,
  [switch]$SkipExtract
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $WorkspaceRoot) {
  $WorkspaceRoot = Join-Path $repoRoot 'work\official_app'
}

$packageRoot = Join-Path $WorkspaceRoot 'package_root'
$extractRoot = Join-Path $WorkspaceRoot 'extract'
$asarCli = Join-Path $repoRoot 'node_modules\.bin\asar.cmd'

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

$pkg = Get-AppxPackage -Name 'OpenAI.Codex' | Sort-Object Version -Descending | Select-Object -First 1
if ($null -eq $pkg) {
  throw 'OpenAI.Codex package was not found. Install Codex Desktop first.'
}

$sourceRoot = $pkg.InstallLocation
if (-not (Test-Path $sourceRoot)) {
  throw "Package install location not found: $sourceRoot"
}

New-Item -ItemType Directory -Force $WorkspaceRoot | Out-Null
robocopy $sourceRoot $packageRoot /MIR /R:1 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null

$asarCandidate = Get-ChildItem -Path $packageRoot -Recurse -Filter app.asar -File |
  Sort-Object FullName |
  Select-Object -First 1

if ($null -eq $asarCandidate) {
  throw "Could not find app.asar under $packageRoot"
}

if (-not $SkipExtract) {
  if (Test-Path $extractRoot) {
    Remove-Item $extractRoot -Recurse -Force
  }
  if (-not (Test-Path $asarCli)) {
    throw "asar CLI not found: $asarCli"
  }
  Invoke-External $asarCli @('extract', $asarCandidate.FullName, $extractRoot)
}

Write-Output "OFFICIAL_APP_WORKSPACE_READY $WorkspaceRoot"
Write-Output "PACKAGE_ROOT $packageRoot"
Write-Output "ASAR_SOURCE $($asarCandidate.FullName)"
if (-not $SkipExtract) {
  Write-Output "EXTRACT_ROOT $extractRoot"
}
