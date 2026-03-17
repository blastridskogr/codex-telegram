param(
  [string]$OutputPath
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$workspaceRoot = Join-Path $repoRoot 'work\official_app'
if (-not $OutputPath) {
  $OutputPath = Join-Path $workspaceRoot 'reports\OFFICIAL_IPC_PROBE.md'
}

New-Item -ItemType Directory -Force (Split-Path -Parent $OutputPath) | Out-Null

$pkg = Get-AppxPackage -Name 'OpenAI.Codex' | Sort-Object Version -Descending | Select-Object -First 1
if ($null -eq $pkg) {
  throw 'OpenAI.Codex package was not found. Install Codex Desktop first.'
}

$officialProcesses = Get-Process -ErrorAction SilentlyContinue |
  Where-Object {
    $_.Path -like '*\WindowsApps\OpenAI.Codex_*\app\Codex.exe' -or
    $_.Path -like '*\WindowsApps\OpenAI.Codex_*\app\resources\codex.exe'
  } |
  Sort-Object ProcessName, Id

$portableProcesses = Get-Process -ErrorAction SilentlyContinue |
  Where-Object {
    $_.Path -like (Join-Path $repoRoot 'work\portable_package_root\app*')
  } |
  Sort-Object ProcessName, Id

$pipes = Get-ChildItem -Path \\.\pipe\ -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -like '*codex*' } |
  Sort-Object Name

$workspacePackageRoot = Join-Path $workspaceRoot 'package_root'
$workspaceExtractRoot = Join-Path $workspaceRoot 'extract'
$workspaceAsar = if (Test-Path $workspacePackageRoot) {
  Get-ChildItem -Path $workspacePackageRoot -Recurse -Filter app.asar -File -ErrorAction SilentlyContinue |
    Sort-Object FullName |
    Select-Object -First 1
} else {
  $null
}

$lines = [System.Collections.Generic.List[string]]::new()
$lines.Add('# Official Codex IPC Probe')
$lines.Add('')
$lines.Add("- Generated at: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss K')")
$lines.Add("- Goal: pivot from portable-primary to official-app-primary Telegram integration.")
$lines.Add('')
$lines.Add('## Package')
$lines.Add('')
$lines.Add("- Name: $($pkg.Name)")
$lines.Add("- Version: $($pkg.Version)")
$lines.Add("- InstallLocation: $($pkg.InstallLocation)")
$lines.Add('')
$lines.Add('## Preserved portable materials')
$lines.Add('')
$lines.Add('- `work/portable_package_root`')
$lines.Add('- `work/full_extract`')
$lines.Add('- `work/app.patched.asar`')
$lines.Add('- `work/portable_userdata`')
$lines.Add('- `work/launch`')
$lines.Add('')
$lines.Add('## Official processes')
$lines.Add('')
if ($officialProcesses.Count -eq 0) {
  $lines.Add('- No official Codex processes were running during this probe.')
} else {
  foreach ($process in $officialProcesses) {
    $lines.Add(("- {0} pid={1} title={2} path={3}" -f $process.ProcessName, $process.Id, $process.MainWindowTitle, $process.Path))
  }
}
$lines.Add('')
$lines.Add('## Portable processes')
$lines.Add('')
if ($portableProcesses.Count -eq 0) {
  $lines.Add('- No portable Codex processes were running during this probe.')
} else {
  foreach ($process in $portableProcesses) {
    $lines.Add(("- {0} pid={1} title={2} path={3}" -f $process.ProcessName, $process.Id, $process.MainWindowTitle, $process.Path))
  }
}
$lines.Add('')
$lines.Add('## Named pipes')
$lines.Add('')
if ($pipes.Count -eq 0) {
  $lines.Add('- No `*codex*` named pipes were visible during this probe.')
} else {
  foreach ($pipe in $pipes) {
    $lines.Add(("- {0}" -f $pipe.Name))
  }
}
$lines.Add('')
$lines.Add('## Official-app workspace status')
$lines.Add('')
$lines.Add("- WorkspaceRoot: $workspaceRoot")
$lines.Add("- package_root exists: $([bool](Test-Path $workspacePackageRoot))")
$lines.Add("- extract exists: $([bool](Test-Path $workspaceExtractRoot))")
if ($workspaceAsar) {
  $lines.Add("- staged app.asar: $($workspaceAsar.FullName)")
}
$lines.Add('')
$lines.Add('## Initial conclusion')
$lines.Add('')
if ($officialProcesses.Count -gt 0 -and ($pipes | Where-Object { $_.Name -eq 'codex-ipc' })) {
  $lines.Add('- The official Store app is currently participating in the shared `codex-ipc` runtime surface.')
  $lines.Add('- That makes an official-app-single-runtime design technically plausible for eliminating the current official+portable dual-runtime tangle class.')
} else {
  $lines.Add('- This probe did not capture enough live evidence to prove the official app currently owns the shared runtime surface.')
}
$lines.Add('- The next proof to gather is a staged official bundle workspace plus an injection path that targets the official app flow instead of the portable copy.')
$lines.Add('- Full Telegram parity still requires an in-app bridge path; an untouched external bot alone is not equivalent to the current portable design.')

Set-Content -Path $OutputPath -Value $lines -Encoding UTF8
Write-Output "OFFICIAL_IPC_PROBE_WRITTEN $OutputPath"
