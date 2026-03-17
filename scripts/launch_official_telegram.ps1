param(
  [string]$WorkspaceRoot,
  [string]$ConfigPath,
  [switch]$PrepareStage
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $WorkspaceRoot) {
  $WorkspaceRoot = Join-Path $repoRoot 'work\official_app'
}

$stagedPackageRoot = Join-Path $WorkspaceRoot 'staging\package_root_telegram'
$exe = Join-Path $stagedPackageRoot 'app\Codex.exe'
$wrapperDir = Join-Path $WorkspaceRoot 'launch'
$officialRoamingDir = Join-Path $env:APPDATA 'Codex'
$exampleConfigPath = Join-Path $repoRoot 'examples\telegram-native.example.json'

function Convert-LegacySandboxToPermissionMode {
  param([string]$Sandbox)

  $normalized = if ($null -eq $Sandbox) { '' } else { [string]$Sandbox }
  switch ($normalized.Trim().ToLowerInvariant()) {
    'danger-full-access' { return 'full-access' }
    'full-access' { return 'full-access' }
    'default' { return $null }
    'custom' { return 'custom' }
    default { return $null }
  }
}

function New-OfficialTelegramConfig {
  param(
    [string]$TargetPath,
    [string]$SeedPath,
    [string]$RepoRoot
  )

  if (-not (Test-Path $SeedPath)) {
    throw "Seed Telegram config not found: $SeedPath"
  }

  $seed = Get-Content -Raw $SeedPath | ConvertFrom-Json
  $permissionMode = $seed.defaultSettings.permissionMode
  if (-not $permissionMode) {
    $permissionMode = Convert-LegacySandboxToPermissionMode $seed.defaultSettings.sandbox
  }

  $config = [ordered]@{
    telegramBotToken = $seed.telegramBotToken
    allowedChatIds = @($seed.allowedChatIds)
    stateDir = '.\telegram-native-state'
    bindingsPath = '.\telegram-native-state\chat_bindings.json'
    telegramInboxDir = '.\telegram-native-inbox'
    logPath = '.\telegram-native.log'
    pollTimeoutSec = if ($seed.pollTimeoutSec) { [int]$seed.pollTimeoutSec } else { 30 }
    maxReplyChars = if ($seed.maxReplyChars) { [int]$seed.maxReplyChars } else { 3500 }
    defaultLanguage = if ($seed.defaultLanguage) { [string]$seed.defaultLanguage } else { 'ko' }
    codexIpcPipe = if ($seed.codexIpcPipe) { [string]$seed.codexIpcPipe } else { '\\.\pipe\codex-ipc' }
    workspaceRoots = if ($seed.workspaceRoots) { @($seed.workspaceRoots) } else { @($RepoRoot) }
    defaultSettings = [ordered]@{
      model = if ($seed.defaultSettings.model) { [string]$seed.defaultSettings.model } else { $null }
      serviceTier = if ($seed.defaultSettings.serviceTier) { [string]$seed.defaultSettings.serviceTier } else { $null }
      effort = if ($seed.defaultSettings.effort) { [string]$seed.defaultSettings.effort } else { $null }
      permissionMode = if ($permissionMode) { [string]$permissionMode } else { $null }
    }
  }

  New-Item -ItemType Directory -Force (Split-Path -Parent $TargetPath) | Out-Null
  $json = $config | ConvertTo-Json -Depth 6
  $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
  [System.IO.File]::WriteAllText($TargetPath, $json, $utf8NoBom)
}

$officialWindowsApps = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
  Where-Object {
    $_.ExecutablePath -like '*\WindowsApps\OpenAI.Codex_*\app\Codex.exe'
  }

if ($officialWindowsApps) {
  throw 'The installed official Codex app is already running. Close it before launching the Telegram-enabled official-stage runtime.'
}

if ($PrepareStage -or -not (Test-Path $exe)) {
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'apply_official_stage_bundle.ps1') -WorkspaceRoot $WorkspaceRoot -PrepareWorkspace:$PrepareStage
  if ($LASTEXITCODE -ne 0) {
    throw "apply_official_stage_bundle.ps1 failed with exit code $LASTEXITCODE"
  }
}

if (-not (Test-Path $exe)) {
  throw "Official staged executable not found: $exe"
}

$officialPackage = Get-AppxPackage -Name 'OpenAI.Codex' | Sort-Object Version -Descending | Select-Object -First 1
if ($null -eq $officialPackage) {
  throw 'The official OpenAI.Codex package is not installed.'
}

New-Item -ItemType Directory -Force $officialRoamingDir | Out-Null
New-Item -ItemType Directory -Force $wrapperDir | Out-Null

if (-not $ConfigPath) {
  $ConfigPath = Join-Path $officialRoamingDir 'telegram-native.json'
}

if (-not (Test-Path $ConfigPath)) {
  New-OfficialTelegramConfig -TargetPath $ConfigPath -SeedPath $exampleConfigPath -RepoRoot $repoRoot
}

$wrapperPath = Join-Path $wrapperDir 'launch_official_telegram.vbs'
$escapedExe = $exe.Replace("""", """""")
$escapedConfigPath = $ConfigPath.Replace("""", """""")
$wrapperLines = @(
  'Option Explicit',
  'Dim shell',
  'Set shell = CreateObject("WScript.Shell")',
  ('shell.Environment("Process")("CODEX_TELEGRAM_NATIVE_CONFIG") = "' + $escapedConfigPath + '"'),
  ('shell.Run """" & "' + $escapedExe + '" & """", 1, False')
)
Set-Content -Path $wrapperPath -Value $wrapperLines -Encoding ASCII

$wscriptArgs = '"' + $wrapperPath + '"'
Invoke-CommandInDesktopPackage `
  -PackageFamilyName $officialPackage.PackageFamilyName `
  -AppId 'App' `
  -Command 'wscript.exe' `
  -Args $wscriptArgs

Write-Output "OFFICIAL_TELEGRAM_LAUNCH_REQUESTED exe=$exe"
Write-Output "OFFICIAL_TELEGRAM_CONFIG $ConfigPath"
