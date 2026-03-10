param(
  [string]$InstanceName = 'default',
  [string]$ConfigPath
)

$repoRoot = Split-Path -Parent $PSScriptRoot
$packageRoot = Join-Path $repoRoot 'work\\portable_package_root'
$exe = Join-Path $packageRoot 'app\\Codex.exe'
$defaultUserDataDir = Join-Path $env:LOCALAPPDATA 'CodexPortableData'
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
  Write-Warning 'The official Codex app is already running. Continuing because the portable launcher enables multi-instance mode.'
}

if (-not $ConfigPath) {
  $ConfigPath = Join-Path $userDataDir 'telegram-native.json'
}

$officialPackage = Get-AppxPackage -Name 'OpenAI.Codex' | Sort-Object Version -Descending | Select-Object -First 1
if ($null -eq $officialPackage) {
  throw 'The official OpenAI.Codex package is not installed.'
}

New-Item -ItemType Directory -Force $userDataDir | Out-Null
New-Item -ItemType Directory -Force $wrapperDir | Out-Null

$wrapperPath = Join-Path $wrapperDir ("launch_portable_{0}.vbs" -f $InstanceName)
$escapedExe = $exe.Replace("""", """""")
$escapedUserDataDir = $userDataDir.Replace("""", """""")
$escapedConfigPath = $ConfigPath.Replace("""", """""")
$wrapperLines = @(
  'Option Explicit',
  'Dim shell',
  'Set shell = CreateObject("WScript.Shell")',
  'shell.Environment("Process")("CODEX_ALLOW_MULTI_INSTANCE") = "1"',
  ('shell.Environment("Process")("CODEX_PORTABLE_USER_DATA_DIR") = "' + $escapedUserDataDir + '"'),
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
