$repoRoot = Split-Path -Parent $PSScriptRoot
$include = @('*.md', '*.json', '*.ps1', '*.mjs', '*.js', '.gitignore')
$localOnlyPatterns = @(
  'telegram-native.json',
  'chat_bindings.json',
  'chat_settings.json',
  'tasks/*',
  'FILE_MAP.md',
  'HANDOFF.md',
  'HANDOFF_DETAILED.md',
  'PROJECT_CONTEXT.md',
  'work/*',
  'state/*',
  'logs/*',
  'telegram-inbox/*'
)

Push-Location $repoRoot
try {
  $trackedRelativeFiles = git ls-files --cached
  if ($LASTEXITCODE -ne 0) {
    throw 'git ls-files --cached failed.'
  }
  $relativeFiles = git ls-files --cached --others --exclude-standard
  if ($LASTEXITCODE -ne 0) {
    throw 'git ls-files failed.'
  }
} finally {
  Pop-Location
}

$files = foreach ($relativePath in $relativeFiles) {
  $fullPath = Join-Path $repoRoot $relativePath
  if (-not (Test-Path $fullPath -PathType Leaf)) {
    continue
  }
  $file = Get-Item $fullPath
  $matchesInclude = $false
  foreach ($pattern in $include) {
    if ($file.Name -like $pattern) {
      $matchesInclude = $true
      break
    }
  }
  if ($matchesInclude) {
    $file
  }
}

$problems = @()

foreach ($relativePath in $trackedRelativeFiles) {
  foreach ($pattern in $localOnlyPatterns) {
    if ($relativePath -like $pattern) {
      $problems += "Tracked local-only path: $relativePath"
      break
    }
  }
}

foreach ($file in $files) {
  $text = Get-Content $file.FullName -Raw

  if ($file.Name -eq 'telegram-native.example.json') {
    continue
  }

  if ($text -match '\b[0-9]{6,}:[A-Za-z0-9_-]{20,}\b') {
    $problems += "Possible Telegram token: $($file.FullName)"
  }
  if ($text -match 'bot[0-9]{6,}:[A-Za-z0-9_-]{20,}') {
    $problems += "Possible Telegram bot URL token: $($file.FullName)"
  }
  if ($text -match '"telegramBotToken"\s*:\s*"[^"]+:[^"]+"') {
    $problems += "Possible Telegram token: $($file.FullName)"
  }
  if ($text -match '"allowedChatIds"\s*:\s*\[\s*"[0-9]{5,}"') {
    $problems += "Possible real chat id: $($file.FullName)"
  }
  if ($text -match 'C:\\Users\\[^\\]+') {
    $problems += "User-specific path: $($file.FullName)"
  }
}

if ($problems.Count -gt 0) {
  $problems | ForEach-Object { Write-Output $_ }
  throw 'Secret check failed.'
}

Write-Output 'SECRET_CHECK_OK'
