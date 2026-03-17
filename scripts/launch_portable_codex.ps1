param(
  [string]$InstanceName = 'default',
  [string]$ConfigPath,
  [string]$CodexHomeDir,
  [switch]$AllowOfficialConcurrent
)

$repoRoot = Split-Path -Parent $PSScriptRoot
$packageRoot = Join-Path $repoRoot 'work\\portable_package_root'
$exe = Join-Path $packageRoot 'app\\Codex.exe'
$defaultUserDataDir = Join-Path $env:LOCALAPPDATA 'CodexPortableData'
$defaultCodexHome = Join-Path $HOME '.codex'
$wrapperDir = Join-Path $repoRoot 'work\\launch'
$userDataDir = if ($InstanceName -eq 'default') {
  $defaultUserDataDir
} else {
  Join-Path $repoRoot "work\\portable_userdata\\$InstanceName"
}

if (-not (Test-Path $exe)) {
  throw "Patched portable package executable not found: $exe"
}

$official = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object {
    $_.ExecutablePath -like '*\\WindowsApps\\OpenAI.Codex_*\\app\\Codex.exe'
  }

if ($official) {
  if (-not $AllowOfficialConcurrent) {
    throw 'The official Codex app is already running. Portable Telegram currently shares the global codex-ipc router, so official + portable concurrent use is blocked by default to prevent session tangling. Close the official app or re-run with -AllowOfficialConcurrent to bypass this guard.'
  }
  Write-Warning 'The official Codex app is already running. Continuing only because -AllowOfficialConcurrent was set; Telegram session tangling is still possible in shared codex-ipc mode.'
}

if (-not $ConfigPath) {
  $ConfigPath = Join-Path $userDataDir 'telegram-native.json'
}

if (-not $CodexHomeDir) {
  $CodexHomeDir = Join-Path $userDataDir 'codex-home'
}

$officialPackage = Get-AppxPackage -Name 'OpenAI.Codex' | Sort-Object Version -Descending | Select-Object -First 1
if ($null -eq $officialPackage) {
  throw 'The official OpenAI.Codex package is not installed.'
}

New-Item -ItemType Directory -Force $userDataDir | Out-Null
New-Item -ItemType Directory -Force $CodexHomeDir | Out-Null
New-Item -ItemType Directory -Force $wrapperDir | Out-Null

$seedFiles = @(
  'auth.json',
  'cap_sid',
  'config.toml',
  'models_cache.json',
  'version.json'
)

foreach ($relativePath in $seedFiles) {
  $sourcePath = Join-Path $defaultCodexHome $relativePath
  $targetPath = Join-Path $CodexHomeDir $relativePath
  if ((Test-Path $sourcePath) -and -not (Test-Path $targetPath)) {
    Copy-Item -Path $sourcePath -Destination $targetPath -Force
  }
}

$wrapperPath = Join-Path $wrapperDir ("launch_portable_{0}.vbs" -f $InstanceName)
$escapedExe = $exe.Replace("""", """""")
$escapedUserDataDir = $userDataDir.Replace("""", """""")
$escapedConfigPath = $ConfigPath.Replace("""", """""")
$escapedCodexHomeDir = $CodexHomeDir.Replace("""", """""")
$wrapperLines = @(
  'Option Explicit',
  'Dim shell',
  'Set shell = CreateObject("WScript.Shell")',
  'shell.Environment("Process")("CODEX_ALLOW_MULTI_INSTANCE") = "1"',
  ('shell.Environment("Process")("CODEX_PORTABLE_USER_DATA_DIR") = "' + $escapedUserDataDir + '"'),
  ('shell.Environment("Process")("CODEX_HOME") = "' + $escapedCodexHomeDir + '"'),
  ('shell.Environment("Process")("CODEX_TELEGRAM_NATIVE_CONFIG") = "' + $escapedConfigPath + '"'),
  ('shell.Run """" & "' + $escapedExe + '" & """ --user-data-dir=""" & "' + $escapedUserDataDir + '" & """", 1, False')
)
Set-Content -Path $wrapperPath -Value $wrapperLines -Encoding ASCII

$args = '"' + $wrapperPath + '"'
Invoke-CommandInDesktopPackage `
  -PackageFamilyName $officialPackage.PackageFamilyName `
  -AppId 'App' `
  -Command 'wscript.exe' `
  -Args $args
