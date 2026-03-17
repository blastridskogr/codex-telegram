param(
  [string]$WorkspaceRoot,
  [string]$SourceRoot,
  [string]$DeploySubdir = 'package_root_registered',
  [string]$VersionOverride,
  [switch]$PrepareStage,
  [switch]$ReplaceInstalled,
  [switch]$StopRunningCodex,
  [switch]$Launch
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $WorkspaceRoot) {
  $WorkspaceRoot = Join-Path $repoRoot 'work\official_app'
}

$sourceRoot = if ($SourceRoot) {
  $resolved = if ([System.IO.Path]::IsPathRooted($SourceRoot)) { $SourceRoot } else { Join-Path $WorkspaceRoot $SourceRoot }
  [System.IO.Path]::GetFullPath($resolved)
} else {
  Join-Path $WorkspaceRoot 'staging\package_root_telegram'
}
$deployRoot = Join-Path $WorkspaceRoot ("deploy\" + $DeploySubdir)
$manifestPath = Join-Path $deployRoot 'AppxManifest.xml'
$sourceExePath = Join-Path $sourceRoot 'app\Codex.exe'
$sourceAsarPath = Join-Path $sourceRoot 'app\resources\app.asar'
$deployExePath = Join-Path $deployRoot 'app\Codex.exe'
$deployAsarPath = Join-Path $deployRoot 'app\resources\app.asar'

if ($PrepareStage -or -not (Test-Path $sourceRoot)) {
  $applyArgs = @(
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', (Join-Path $PSScriptRoot 'apply_official_stage_bundle.ps1'),
    '-WorkspaceRoot', $WorkspaceRoot
  )
  if ($PrepareStage) {
    $applyArgs += '-PrepareWorkspace'
  }
  & powershell.exe @applyArgs
  if ($LASTEXITCODE -ne 0) {
    throw "apply_official_stage_bundle.ps1 failed with exit code $LASTEXITCODE"
  }
}

if (-not (Test-Path $sourceRoot)) {
  throw "Official staged package root not found: $sourceRoot"
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

function Stop-CodexProcesses {
  foreach ($proc in @(Get-CodexProcesses)) {
    Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop
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

$running = @(Get-CodexProcesses)
if ($running) {
  if ($StopRunningCodex) {
    Stop-CodexProcesses
    if (-not (Wait-ForNoCodexProcesses)) {
      throw 'Timed out waiting for Codex desktop processes to stop before registering the official Telegram package.'
    }
  } else {
  throw 'Close all Codex desktop processes before registering the official Telegram package.'
  }
}

New-Item -ItemType Directory -Force (Split-Path -Parent $deployRoot) | Out-Null
robocopy $sourceRoot $deployRoot /MIR /R:1 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null

if (-not (Test-Path $deployExePath) -or -not (Test-Path $deployAsarPath)) {
  throw "Deploy copy is missing core app files: $deployRoot"
}

$sourceExeHash = (Get-FileHash -Algorithm SHA256 $sourceExePath).Hash
$deployExeHash = (Get-FileHash -Algorithm SHA256 $deployExePath).Hash
$sourceAsarHash = (Get-FileHash -Algorithm SHA256 $sourceAsarPath).Hash
$deployAsarHash = (Get-FileHash -Algorithm SHA256 $deployAsarPath).Hash

if ($sourceExeHash -ne $deployExeHash -or $sourceAsarHash -ne $deployAsarHash) {
  throw @(
    'Deploy copy hash mismatch after robocopy.',
    "Source exe:  $sourceExeHash",
    "Deploy exe:  $deployExeHash",
    "Source asar: $sourceAsarHash",
    "Deploy asar: $deployAsarHash"
  ) -join [Environment]::NewLine
}

if (-not (Test-Path $manifestPath)) {
  throw "Deploy manifest not found: $manifestPath"
}

foreach ($metadataPath in @(
  (Join-Path $deployRoot 'AppxSignature.p7x'),
  (Join-Path $deployRoot 'AppxBlockMap.xml'),
  (Join-Path $deployRoot 'AppxMetadata'),
  (Join-Path $deployRoot 'microsoft.system.package.metadata')
)) {
  if (Test-Path $metadataPath) {
    Remove-Item $metadataPath -Recurse -Force
  }
}

[xml]$xml = Get-Content $manifestPath
$identity = $xml.Package.Identity
$registeredVersion = if ($VersionOverride) {
  $VersionOverride
} else {
  $version = [Version]$identity.Version
  '{0}.{1}.{2}.{3}' -f $version.Major, $version.Minor, $version.Build, ($version.Revision + 1)
}
$identity.Version = $registeredVersion

$settings = New-Object System.Xml.XmlWriterSettings
$settings.Indent = $true
$settings.Encoding = [System.Text.UTF8Encoding]::new($false)
$writer = [System.Xml.XmlWriter]::Create($manifestPath, $settings)
$xml.Save($writer)
$writer.Dispose()

$existingPackage = Get-AppxPackage -Name 'OpenAI.Codex' | Sort-Object Version -Descending | Select-Object -First 1
if ($null -ne $existingPackage) {
  $isWindowsAppsInstall = [string]$existingPackage.InstallLocation -like '*\WindowsApps\*'
  if ($ReplaceInstalled) {
    Remove-AppxPackage -Package $existingPackage.PackageFullName
    if (-not (Wait-ForPackageRemoval)) {
      throw 'Timed out waiting for OpenAI.Codex removal before local registration.'
    }
  } elseif ($isWindowsAppsInstall) {
    throw 'OpenAI.Codex is still installed from WindowsApps. Re-run with -ReplaceInstalled to remove the current installed package for this user before registering the staged official Telegram package.'
  }
}

Add-AppxPackage -Register $manifestPath -ForceApplicationShutdown -ForceUpdateFromAnyVersion

$pkg = Get-AppxPackage -Name 'OpenAI.Codex' | Sort-Object Version -Descending | Select-Object -First 1
if ($null -eq $pkg) {
  throw 'OpenAI.Codex package lookup failed after registration.'
}

Write-Output "OFFICIAL_TELEGRAM_REGISTERED $($pkg.PackageFullName)"
Write-Output "OFFICIAL_TELEGRAM_INSTALL $($pkg.InstallLocation)"
Write-Output "OFFICIAL_TELEGRAM_SIGNATURE $($pkg.SignatureKind)"
Write-Output "OFFICIAL_TELEGRAM_SOURCE $sourceRoot"
Write-Output "OFFICIAL_TELEGRAM_DEPLOY $deployRoot"

if ($Launch) {
  Start-Process explorer.exe "shell:AppsFolder\$($pkg.PackageFamilyName)!App" | Out-Null
  Write-Output "OFFICIAL_TELEGRAM_LAUNCHED $($pkg.PackageFamilyName)!App"
}
