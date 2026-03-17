param(
  [string]$WorkspaceRoot,
  [string]$DeploySubdir,
  [string]$LogPath
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $WorkspaceRoot) {
  $WorkspaceRoot = Join-Path $repoRoot 'work\official_app_update'
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
  $DeploySubdir = Get-NextDeploySubdir -Root $WorkspaceRoot
}
if (-not $LogPath) {
  $LogPath = Join-Path $WorkspaceRoot 'deploy\redeploy_updated_official_telegram.log'
}

New-Item -ItemType Directory -Force (Split-Path -Parent $LogPath) | Out-Null

function Write-Log {
  param([string]$Message)
  $timestamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss.fff'
  Add-Content -Path $LogPath -Value "$timestamp $Message"
}

function Stop-CodexProcesses {
  $targets = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object {
      $_.ExecutablePath -like '*\OpenAI.Codex_*\app\Codex.exe' -or
      $_.ExecutablePath -like '*\OpenAI.Codex_*\app\resources\codex.exe' -or
      $_.ExecutablePath -like '*\work\official_app*\*\Codex.exe' -or
      $_.ExecutablePath -like '*\work\official_app*\*\resources\codex.exe'
    }

  foreach ($proc in $targets) {
    try {
      Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop
      Write-Log "stopped pid=$($proc.ProcessId) path=$($proc.ExecutablePath)"
    }
    catch {
      Write-Log "stop-failed pid=$($proc.ProcessId) path=$($proc.ExecutablePath) error=$($_.Exception.Message)"
    }
  }
}

try {
  Write-Log "redeploy-start workspace=$WorkspaceRoot deploy=$DeploySubdir"
  Start-Sleep -Seconds 5
  Stop-CodexProcesses
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'register_official_telegram_package.ps1') `
    -WorkspaceRoot $WorkspaceRoot `
    -DeploySubdir $DeploySubdir `
    -ReplaceInstalled `
    -Launch *>> $LogPath
  if ($LASTEXITCODE -ne 0) {
    Write-Log "register-failed exit=$LASTEXITCODE"
    exit $LASTEXITCODE
  }
  Write-Log "redeploy-success"
}
catch {
  Write-Log "redeploy-error $($_.Exception.Message)"
  throw
}
