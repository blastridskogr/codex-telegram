# Windows official app setup

This repository does not redistribute Codex binaries. It documents the way I actually use Codex on Windows: sign into the Codex app first, then patch and re-register a **local copy** so Telegram can drive that same signed-in app session.

That means the working pattern is:

- use the official Windows Codex app first
- sign into that app with the same ChatGPT account I normally use
- if I want the same setup as this repo, I sign into the app with my ChatGPT Pro account first
- then patch a local copy so Telegram can drive that same app session

## Requirements

- Windows 11
- Codex Desktop installed from the Microsoft Store
- a working sign-in in the official Codex app before patching
- Node.js 24+
- PowerShell 5.1+

## 0. Sign into the official app first

Before patching anything:

- launch the Microsoft Store Codex app once
- sign in
- confirm a normal Codex chat works in the app

If you want the same setup described in this repository, sign into the official app with your ChatGPT Pro account before continuing.

## 1. Install repository dependencies

```powershell
npm install
```

## 2. Create the local Telegram config

```powershell
New-Item -ItemType Directory -Force "$env:APPDATA\Codex" | Out-Null
Copy-Item .\examples\telegram-native.example.json "$env:APPDATA\Codex\telegram-native.json"
```

Then edit:

```text
%APPDATA%\Codex\telegram-native.json
```

Set:

- `telegramBotToken`
- `allowedChatIds`
- `workspaceRoots`

## 3. Prepare the patched official-app workspace

```powershell
npm run official:update
```

This wraps the official workflow:

- copy the currently installed `OpenAI.Codex` package into `work\official_app_update\package_root`
- extract the source `app.asar` into `work\official_app_update\extract`
- inject the Telegram runtime into the extracted main and renderer bundle
- rebuild `work\official_app_update\staging\app.telegram.official.asar`
- copy the patched bundle into `work\official_app_update\staging\package_root_telegram`
- rewrite the executable integrity metadata for that local package copy

Manual entry point if you need the step-by-step flow:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\run_official_telegram_update.ps1 -WorkspaceRoot .\work\official_app_update
```

## 4. Replace the live app with the patched local package

```powershell
npm run official:redeploy
```

This step intentionally stops the running Codex app, registers the prepared local package copy, and relaunches it. Run it from an external PowerShell window if you are currently using Codex Desktop.

Detached direct command:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\redeploy_updated_official_telegram.ps1 -WorkspaceRoot .\work\official_app_update
```

## 5. Recovery path when Microsoft Store updates are blocked

If the locally registered dev package prevents Microsoft Store from replacing Codex normally, run:

```powershell
npm run official:recover-store
```

Direct command:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\recover_official_store_then_repatch.ps1 -WorkspaceRoot .\work\official_app_update
```

This recovery flow:

- stops Codex
- removes the locally registered `OpenAI.Codex` package
- installs the latest available Microsoft Store Codex package for the current user
- rebuilds the Telegram-patched local package from that fresh official source
- registers and launches the patched local package again

The recovery flow requires Microsoft Store to be signed in and able to download the official package for the current user.

## 6. Verify the result

Package status:

```powershell
Get-AppxPackage -Name OpenAI.Codex | Select-Object PackageFullName, Version, SignatureKind, InstallLocation, IsDevelopmentMode, Status
```

Expected shape after local re-registration:

- `SignatureKind` is `None`
- `IsDevelopmentMode` is `True`
- `InstallLocation` points into `work\official_app_update\deploy\package_root_telegram_registered_vN`
- `vN` increments on each redeploy so the workflow can avoid stale package-root reuse

Fresh runtime logs:

- bootstrap log: `%TEMP%\codex-telegram-bootstrap.log`
- runtime log: `%APPDATA%\Codex\telegram-native.log`

Healthy startup should include fresh lines similar to:

- `resolvedConfigPath=...telegram-native.json exists=true`
- `broadcast monitor connected pipe=\\.\pipe\codex-ipc`
- `polling started allowlist=...`

## Account and plan behavior

- Telegram does **not** create a separate Codex backend or separate account session
- the patched local package still uses the same signed-in Codex app account
- if you signed into the official app with ChatGPT Pro before patching, Telegram-driven usage is flowing through that same signed-in app path

## 7. Pre-publish check

Before you commit or push, run:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\prepublish_secret_check.ps1
```

This checks the current git-visible tree for tokens, chat ids, user-specific paths, and tracked local-only files.
