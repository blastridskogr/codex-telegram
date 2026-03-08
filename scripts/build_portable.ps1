param(
  [switch]$SkipNpmInstall,
  [switch]$Register,
  [switch]$Launch,
  [switch]$DryRun,
  [string]$InstanceName = 'default'
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$workRoot = Join-Path $repoRoot 'work'
$packageRoot = Join-Path $workRoot 'portable_package_root'
$asarPath = Join-Path $packageRoot 'app\resources\app.asar'
$extractRoot = Join-Path $workRoot 'full_extract'
$patchedAsarPath = Join-Path $workRoot 'app.patched.asar'

function Invoke-Step {
  param(
    [string]$Label,
    [scriptblock]$Action
  )

  Write-Host "==> $Label"
  if ($DryRun) {
    return
  }
  & $Action
}

function Invoke-External {
  param(
    [string]$FilePath,
    [string[]]$Arguments
  )

  & $FilePath @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Command failed with exit code ${LASTEXITCODE}: $FilePath $($Arguments -join ' ')"
  }
}

Push-Location $repoRoot
try {
  if (-not $SkipNpmInstall) {
    Invoke-Step 'Install npm dependencies' {
      Invoke-External 'npm.cmd' @('install')
    }
  }

  Invoke-Step 'Prepare the portable package root from the installed Codex Desktop app' {
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'prepare_portable_package.ps1')
    if ($LASTEXITCODE -ne 0) {
      throw "prepare_portable_package.ps1 failed with exit code $LASTEXITCODE"
    }
  }

  Invoke-Step 'Extract app.asar into work/full_extract' {
    if (Test-Path $extractRoot) {
      Remove-Item $extractRoot -Recurse -Force
    }
    Invoke-External 'npx.cmd' @('asar', 'extract', $asarPath, $extractRoot)
  }

  Invoke-Step 'Inject the native Telegram runtime into the extracted bundle' {
    Invoke-External 'node.exe' @('.\scripts\inject_native_telegram.mjs')
  }

  Invoke-Step 'Rebuild the patched app.asar' {
    Invoke-External 'node.exe' @('.\scripts\rebuild_patched_asar.mjs')
  }

  Invoke-Step 'Copy the rebuilt app.asar back into the portable package root' {
    if (-not (Test-Path $patchedAsarPath)) {
      throw "Patched app.asar not found: $patchedAsarPath"
    }
    Copy-Item $patchedAsarPath $asarPath -Force
  }

  Invoke-Step 'Rewrite the Electron integrity metadata in Codex.exe' {
    Invoke-External 'node.exe' @('.\scripts\update_portable_asar_integrity.mjs')
  }

  if ($Register) {
    Invoke-Step 'Register the portable package' {
      & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'register_portable_package.ps1')
      if ($LASTEXITCODE -ne 0) {
        throw "register_portable_package.ps1 failed with exit code $LASTEXITCODE"
      }
    }
  }

  if ($Launch) {
    Invoke-Step "Launch the portable app instance '$InstanceName'" {
      & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'launch_portable_codex.ps1') -InstanceName $InstanceName
      if ($LASTEXITCODE -ne 0) {
        throw "launch_portable_codex.ps1 failed with exit code $LASTEXITCODE"
      }
    }
  }
}
finally {
  Pop-Location
}

if ($DryRun) {
  Write-Output 'BUILD_PORTABLE_DRY_RUN_OK'
} else {
  Write-Output "BUILD_PORTABLE_OK $packageRoot"
}

