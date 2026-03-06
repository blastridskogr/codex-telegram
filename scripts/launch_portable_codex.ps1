param(
  [string]$InstanceName = 'default',
  [string]$ConfigPath
)

$repoRoot = Split-Path -Parent $PSScriptRoot
$packageRoot = Join-Path $repoRoot 'work\\portable_package_root_v2'
$exe = Join-Path $packageRoot 'app\\Codex.exe'
$userDataDir = Join-Path $repoRoot "work\\portable_userdata\\$InstanceName"

if (-not (Test-Path $exe)) {
  throw "Patched portable package executable not found: $exe"
}

$official = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object {
    $_.ExecutablePath -like '*\\WindowsApps\\OpenAI.Codex_*\\app\\Codex.exe'
  }

if ($official) {
  throw 'The official Codex app is running. Close it before launching the portable package.'
}

if (-not $ConfigPath) {
  $ConfigPath = Join-Path $env:LOCALAPPDATA 'CodexPortableData\\telegram-native.json'
}

New-Item -ItemType Directory -Force $userDataDir | Out-Null

$command = @"
`$env:CODEX_ALLOW_MULTI_INSTANCE='1'
`$env:CODEX_TELEGRAM_NATIVE_CONFIG='$ConfigPath'
& '$exe' '--user-data-dir=$userDataDir'
"@

Start-Process -FilePath powershell.exe -ArgumentList '-NoProfile', '-Command', $command

