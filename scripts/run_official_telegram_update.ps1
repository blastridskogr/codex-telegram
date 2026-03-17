param(
  [string]$WorkspaceRoot,
  [string]$DeploySubdir,
  [switch]$RedeployDetached
)

$ErrorActionPreference = 'Stop'

if (-not $WorkspaceRoot) {
  throw 'Pass -WorkspaceRoot explicitly. Use work\official_app_update for a Store-update rebase, or work\official_app only when reproducing the older baseline.'
}

$repoRoot = Split-Path -Parent $PSScriptRoot
$resolvedWorkspaceRoot = if ([System.IO.Path]::IsPathRooted($WorkspaceRoot)) {
  [System.IO.Path]::GetFullPath($WorkspaceRoot)
} else {
  [System.IO.Path]::GetFullPath((Join-Path $repoRoot $WorkspaceRoot))
}

function Get-NextDeploySubdir {
  param([string]$Root)

  $deployRoot = Join-Path $Root 'deploy'
  if (-not (Test-Path $deployRoot)) {
    return 'package_root_telegram_registered_v1'
  }

  $maxVersion = 0
  foreach ($dir in Get-ChildItem $deployRoot -Directory -ErrorAction SilentlyContinue) {
    if ($dir.Name -match '^package_root_telegram_registered_v(\d+)$') {
      $version = [int]$Matches[1]
      if ($version -gt $maxVersion) {
        $maxVersion = $version
      }
    }
  }

  return ('package_root_telegram_registered_v{0}' -f ($maxVersion + 1))
}

if (-not $DeploySubdir) {
  $DeploySubdir = Get-NextDeploySubdir -Root $resolvedWorkspaceRoot
}

function Invoke-Step {
  param(
    [string]$Label,
    [string]$FileName,
    [string[]]$Arguments
  )

  Write-Output "[RUN] $Label"
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot $FileName) @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "[FAIL] $Label exited with code $LASTEXITCODE"
  }
  Write-Output "[OK] $Label"
}

Write-Output "[INFO] WorkspaceRoot=$resolvedWorkspaceRoot"
Write-Output "[INFO] DeploySubdir=$DeploySubdir"

Invoke-Step -Label '1/4 prepare_official_app_workspace' -FileName 'prepare_official_app_workspace.ps1' -Arguments @(
  '-WorkspaceRoot', $resolvedWorkspaceRoot
)

Invoke-Step -Label '2/4 stage_official_app_telegram' -FileName 'stage_official_app_telegram.ps1' -Arguments @(
  '-WorkspaceRoot', $resolvedWorkspaceRoot
)

Invoke-Step -Label '3/4 build_official_stage_bundle' -FileName 'build_official_stage_bundle.ps1' -Arguments @(
  '-WorkspaceRoot', $resolvedWorkspaceRoot
)

Invoke-Step -Label '4/4 apply_official_stage_bundle' -FileName 'apply_official_stage_bundle.ps1' -Arguments @(
  '-WorkspaceRoot', $resolvedWorkspaceRoot
)

if ($RedeployDetached) {
  $logPath = Join-Path $resolvedWorkspaceRoot ("deploy\redeploy_" + $DeploySubdir + ".log")
  Write-Output "[RUN] detached redeploy -> $DeploySubdir"
  Write-Output "[INFO] The detached redeploy will terminate the current Codex app, so this process cannot report the final outcome directly."
  Start-Process powershell.exe -WindowStyle Hidden -ArgumentList @(
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', (Join-Path $PSScriptRoot 'redeploy_updated_official_telegram.ps1'),
    '-WorkspaceRoot', $resolvedWorkspaceRoot,
    '-DeploySubdir', $DeploySubdir,
    '-LogPath', $logPath
  ) | Out-Null
  Write-Output "[OK] detached redeploy launched"
  Write-Output "[INFO] RedeployLog=$logPath"
  Write-Output "[INFO] After the app relaunches, verify that the log ends with redeploy-success."
} else {
  Write-Output "[INFO] Stage/build/apply complete. For live replacement from an active Codex session, run:"
  Write-Output "powershell -NoProfile -ExecutionPolicy Bypass -File $PSScriptRoot\\redeploy_updated_official_telegram.ps1 -WorkspaceRoot $resolvedWorkspaceRoot -DeploySubdir $DeploySubdir"
}
