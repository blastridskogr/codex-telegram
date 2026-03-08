$repoRoot = Split-Path -Parent $PSScriptRoot
$include = @('*.md', '*.json', '*.ps1', '*.mjs', '*.js', '.gitignore')
$files = Get-ChildItem -Path $repoRoot -Recurse -File -Include $include |
  Where-Object {
    $_.FullName -notmatch '\\node_modules\\' -and
    $_.FullName -notmatch '\\work\\' -and
    $_.FullName -notmatch '\\.git\\'
  }

$problems = @()

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
