param(
  [switch]$Unregister,
  [string]$PackageRoot
)

$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $PackageRoot) {
  $PackageRoot = Join-Path $repoRoot 'work\\portable_package_root_v2'
}

$manifestPath = Join-Path $PackageRoot 'AppxManifest.xml'
$packageName = 'OpenAI.CodexPortable'

if (-not (Test-Path $manifestPath)) {
  throw "Portable package manifest not found: $manifestPath"
}

if ($Unregister) {
  $pkg = Get-AppxPackage -Name $packageName -ErrorAction SilentlyContinue
  if ($null -ne $pkg) {
    Remove-AppxPackage -Package $pkg.PackageFullName
    Write-Output "UNREGISTERED $($pkg.PackageFullName)"
  } else {
    Write-Output 'NOT_REGISTERED'
  }
  return
}

$devModeKey = 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\AppModelUnlock'
$devModeEnabled = $false
if (Test-Path $devModeKey) {
  try {
    $value = (Get-ItemProperty -Path $devModeKey -Name AllowDevelopmentWithoutDevLicense -ErrorAction Stop).AllowDevelopmentWithoutDevLicense
    $devModeEnabled = ($value -eq 1)
  } catch {
    $devModeEnabled = $false
  }
}

if (-not $devModeEnabled) {
  throw 'Windows Developer Mode is not enabled. Enable Developer Mode, then rerun this script.'
}

Add-AppxPackage -Register $manifestPath -ForceApplicationShutdown
$pkg = Get-AppxPackage -Name $packageName -ErrorAction SilentlyContinue
if ($null -eq $pkg) {
  throw "Registration did not produce a visible package entry for $packageName"
}

Write-Output "REGISTERED $($pkg.PackageFullName)"

