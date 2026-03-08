param(
  [string]$OutputRoot
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $OutputRoot) {
$OutputRoot = Join-Path $repoRoot 'work\\portable_package_root'
}

$pkg = Get-AppxPackage -Name 'OpenAI.Codex' | Sort-Object Version -Descending | Select-Object -First 1
if ($null -eq $pkg) {
  throw 'OpenAI.Codex package was not found. Install Codex Desktop first.'
}

$sourceRoot = $pkg.InstallLocation
if (-not (Test-Path $sourceRoot)) {
  throw "Package install location not found: $sourceRoot"
}

New-Item -ItemType Directory -Force (Split-Path -Parent $OutputRoot) | Out-Null
robocopy $sourceRoot $OutputRoot /MIR /R:1 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null

$manifestPath = Join-Path $OutputRoot 'AppxManifest.xml'
if (-not (Test-Path $manifestPath)) {
  throw "Manifest not found after copy: $manifestPath"
}

[xml]$xml = Get-Content $manifestPath
$identity = $xml.Package.Identity
$version = [Version]$identity.Version
$portableVersion = '{0}.{1}.{2}.{3}' -f $version.Major, $version.Minor, $version.Build, ($version.Revision + 1)
$phoneProductId = [string]([guid]::NewGuid().Guid)

$identity.Name = 'OpenAI.CodexPortable'
$identity.Version = $portableVersion
$xml.Package.Properties.DisplayName = 'Codex Portable'
$xml.Package.Properties.PublisherDisplayName = 'OpenAI'
$xml.Package.Applications.Application.VisualElements.DisplayName = 'Codex Portable'
$xml.Package.Applications.Application.VisualElements.Description = 'Codex Portable'

$settings = New-Object System.Xml.XmlWriterSettings
$settings.Indent = $true
$settings.Encoding = [System.Text.UTF8Encoding]::new($false)
$writer = [System.Xml.XmlWriter]::Create($manifestPath, $settings)
$xml.Save($writer)
$writer.Dispose()

$raw = Get-Content $manifestPath -Raw
$raw = $raw -replace 'PhoneProductId="[^"]+"', "PhoneProductId=""$phoneProductId"""
Set-Content -Path $manifestPath -Value $raw -Encoding UTF8

Write-Output "PREPARED $OutputRoot"
