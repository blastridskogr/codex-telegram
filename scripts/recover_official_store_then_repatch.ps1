param(
  [string]$WorkspaceRoot,
  [string]$StoreProductId = '9PLM9XGG6VKS',
  [string]$BackupRoot,
  [string]$LogPath,
  [string]$RestoreManifestPath
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $WorkspaceRoot) {
  $WorkspaceRoot = Join-Path $repoRoot 'work\official_app_update'
}
if (-not $BackupRoot) {
  $BackupRoot = Join-Path $repoRoot ("work\official_store_recovery\backup_" + (Get-Date -Format 'yyyy-MM-dd_HHmmss'))
}
if (-not $LogPath) {
  $LogPath = Join-Path $repoRoot 'work\official_store_recovery\recover_official_store_then_repatch.log'
}

New-Item -ItemType Directory -Force (Split-Path -Parent $LogPath) | Out-Null
New-Item -ItemType Directory -Force $BackupRoot | Out-Null

function Write-Log {
  param([string]$Message)
  $timestamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss.fff'
  Add-Content -Path $LogPath -Value "$timestamp $Message"
}

function Invoke-RobocopyMirror {
  param(
    [string]$Source,
    [string]$Destination
  )

  if (-not (Test-Path $Source)) {
    Write-Log "backup-skip missing=$Source"
    return
  }

  New-Item -ItemType Directory -Force $Destination | Out-Null
  robocopy $Source $Destination /MIR /R:1 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
  $exitCode = $LASTEXITCODE
  if ($exitCode -gt 7) {
    throw "robocopy failed source=$Source destination=$Destination exit=$exitCode"
  }
  Write-Log "backup-ok source=$Source destination=$Destination exit=$exitCode"
}

function Stop-CodexProcesses {
  $targets = Get-CodexProcesses

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

function Get-CodexProcesses {
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object {
      $_.ExecutablePath -like '*\OpenAI.Codex_*\app\Codex.exe' -or
      $_.ExecutablePath -like '*\OpenAI.Codex_*\app\resources\codex.exe' -or
      $_.ExecutablePath -like '*\work\official_app*\*\Codex.exe' -or
      $_.ExecutablePath -like '*\work\official_app*\*\resources\codex.exe'
    }
}

function Wait-ForNoCodexProcesses {
  param([int]$TimeoutSeconds = 30)

  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    $running = @(Get-CodexProcesses)
    if ($running.Count -eq 0) {
      return $true
    }
    Start-Sleep -Milliseconds 500
  } while ((Get-Date) -lt $deadline)

  return $false
}

function Wait-ForPackageRemoval {
  param([int]$TimeoutSeconds = 60)
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    $pkg = Get-AppxPackage -Name 'OpenAI.Codex' -ErrorAction SilentlyContinue
    if ($null -eq $pkg) {
      return $true
    }
    Start-Sleep -Seconds 1
  } while ((Get-Date) -lt $deadline)
  return $false
}

function Wait-ForOfficialPackageInstall {
  param([int]$TimeoutSeconds = 180)
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  do {
    $pkg = Get-AppxPackage -Name 'OpenAI.Codex' -ErrorAction SilentlyContinue | Sort-Object Version -Descending | Select-Object -First 1
    if ($null -ne $pkg) {
      $installLocation = [string]$pkg.InstallLocation
      if ($pkg.SignatureKind -ne 'None' -or $installLocation -like '*\WindowsApps\*' -or -not $pkg.IsDevelopmentMode) {
        return $pkg
      }
    }
    Start-Sleep -Seconds 2
  } while ((Get-Date) -lt $deadline)
  return $null
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

function Get-LatestRegisteredManifestPath {
  param([string]$Root)

  $deployRoot = Join-Path $Root 'deploy'
  if (-not (Test-Path $deployRoot)) {
    return $null
  }

  $candidate = Get-ChildItem $deployRoot -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match '^package_root_telegram_registered_v(\d+)$' } |
    Sort-Object { [int]([regex]::Match($_.Name, '^package_root_telegram_registered_v(\d+)$').Groups[1].Value) } -Descending |
    Select-Object -First 1

  if ($null -eq $candidate) {
    return $null
  }

  $manifestPath = Join-Path $candidate.FullName 'AppxManifest.xml'
  if (Test-Path $manifestPath) {
    return $manifestPath
  }

  return $null
}

function Restore-PreviousPatchedPackage {
  if (-not (Test-Path $RestoreManifestPath)) {
    throw "Restore manifest is unavailable: $RestoreManifestPath"
  }

  try {
    $current = Get-AppxPackage -Name 'OpenAI.Codex' -ErrorAction SilentlyContinue | Sort-Object Version -Descending | Select-Object -First 1
    if ($null -ne $current) {
      Remove-AppxPackage -Package $current.PackageFullName -ErrorAction Stop
      Write-Log "restore-removed-current package=$($current.PackageFullName)"
    }
  }
  catch {
    Write-Log "restore-remove-current-failed error=$($_.Exception.Message)"
  }

  try {
    Add-AppxPackage -Register $RestoreManifestPath -ForceApplicationShutdown -ForceUpdateFromAnyVersion -ErrorAction Stop
    Write-Log "restore-success manifest=$RestoreManifestPath"
  }
  catch {
    Write-Log "restore-failed manifest=$RestoreManifestPath error=$($_.Exception.Message)"
  }
}

if (-not $RestoreManifestPath) {
  $RestoreManifestPath = Get-LatestRegisteredManifestPath -Root $WorkspaceRoot
}

try {
  Write-Log "recover-start workspace=$WorkspaceRoot storeProduct=$StoreProductId backup=$BackupRoot"
  if (-not $RestoreManifestPath -or -not (Test-Path $RestoreManifestPath)) {
    throw "Rollback manifest unavailable before recovery start: $RestoreManifestPath"
  }
  Write-Log "restore-manifest manifest=$RestoreManifestPath"
  Start-Sleep -Seconds 5

  Stop-CodexProcesses
  if (-not (Wait-ForNoCodexProcesses)) {
    throw 'Timed out waiting for Codex desktop processes to stop before package removal.'
  }
  Write-Log 'pre-removal-process-stop-confirmed'

  Invoke-RobocopyMirror -Source "$env:APPDATA\Codex" -Destination (Join-Path $BackupRoot 'Roaming_Codex')
  Invoke-RobocopyMirror -Source "$env:LOCALAPPDATA\Packages\OpenAI.Codex_2p2nqsd0c76g0" -Destination (Join-Path $BackupRoot 'LocalPackage_OpenAI.Codex_2p2nqsd0c76g0')

  $current = Get-AppxPackage -Name 'OpenAI.Codex' -ErrorAction SilentlyContinue | Sort-Object Version -Descending | Select-Object -First 1
  if ($null -eq $current) {
    throw 'OpenAI.Codex package was not found before removal.'
  }
  Write-Log "current-package fullName=$($current.PackageFullName) signature=$($current.SignatureKind) devMode=$($current.IsDevelopmentMode) install=$($current.InstallLocation)"

  Remove-AppxPackage -Package $current.PackageFullName -ErrorAction Stop
  Write-Log "removed-package fullName=$($current.PackageFullName)"

  if (-not (Wait-ForPackageRemoval)) {
    throw 'Timed out waiting for OpenAI.Codex removal.'
  }
  Write-Log 'removal-confirmed'

  & winget install --id $StoreProductId --source msstore --accept-source-agreements --accept-package-agreements *>> $LogPath
  if ($LASTEXITCODE -ne 0) {
    throw "winget install failed exit=$LASTEXITCODE"
  }
  Write-Log "winget-install-finished product=$StoreProductId"

  $official = Wait-ForOfficialPackageInstall
  if ($null -eq $official) {
    throw 'Timed out waiting for the official Store package installation.'
  }
  Write-Log "official-installed fullName=$($official.PackageFullName) signature=$($official.SignatureKind) devMode=$($official.IsDevelopmentMode) install=$($official.InstallLocation)"

  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'run_official_telegram_update.ps1') `
    -WorkspaceRoot $WorkspaceRoot *>> $LogPath
  if ($LASTEXITCODE -ne 0) {
    throw "run_official_telegram_update.ps1 failed exit=$LASTEXITCODE"
  }
  Write-Log 'telegram-stage-build-apply-complete'

  Stop-CodexProcesses
  if (-not (Wait-ForNoCodexProcesses)) {
    throw 'Timed out waiting for Codex desktop processes to stop before package registration.'
  }
  Write-Log 'pre-registration-process-stop-confirmed'

  $deploySubdir = Get-NextDeploySubdir -Root $WorkspaceRoot
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'register_official_telegram_package.ps1') `
    -WorkspaceRoot $WorkspaceRoot `
    -DeploySubdir $deploySubdir `
    -ReplaceInstalled `
    -StopRunningCodex `
    -Launch *>> $LogPath
  if ($LASTEXITCODE -ne 0) {
    throw "register_official_telegram_package.ps1 failed exit=$LASTEXITCODE"
  }

  $final = Get-AppxPackage -Name 'OpenAI.Codex' -ErrorAction SilentlyContinue | Sort-Object Version -Descending | Select-Object -First 1
  if ($null -eq $final) {
    throw 'Final OpenAI.Codex package lookup failed.'
  }
  Write-Log "recover-success final=$($final.PackageFullName) install=$($final.InstallLocation)"
}
catch {
  Write-Log "recover-error error=$($_.Exception.Message)"
  Restore-PreviousPatchedPackage
  throw
}
