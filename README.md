# codex-telegram

Unofficial Telegram integration for the Windows Codex app: real-time message sync, Codex app commands, runtime approval handling, and an official-app patch/re-register workflow through a locally patched and re-registered copy.

[Features](docs/FEATURES.md) | [Release 0.2.0](docs/RELEASE_0.2.0.md) | [Windows Official Setup](docs/WINDOWS_OFFICIAL_APP_SETUP.md) | [Bot Setup](docs/TELEGRAM_BOT_SETUP.md) | [Commands](docs/TELEGRAM_COMMANDS.md) | [Security](docs/SECURITY.md)

This repository contains the patch source, workflow scripts, and setup docs for a Telegram-driven Codex workflow on Windows. It does **not** include OpenAI binaries, extracted bundles, rebuilt `app.asar`, or runtime secrets.

## Workflow summary

- install the official Microsoft Store Codex app
- confirm the official app works before patching
- extract that installed package into a local ignored workspace
- inject the Telegram runtime into the extracted bundle
- rebuild `app.asar`
- update executable integrity metadata for the local package copy
- re-register the local `OpenAI.Codex` package copy and launch it
- use Telegram for real-time Codex message sync, control commands, and approval handling

## Current maintained feature line

The active maintained line is the `v30` Telegram feature set, rebased onto newer official Codex builds.

Kept features:

- Telegram real-time message sync
- Telegram image/document staging into Codex
- Codex app native control commands
- Telegram approval handling
- session binding and replay behavior
- official Store extract/patch/re-register workflow

## Quick start

1. Read [docs/TELEGRAM_BOT_SETUP.md](docs/TELEGRAM_BOT_SETUP.md) and create your bot.
2. Create your local config from [examples/telegram-native.example.json](examples/telegram-native.example.json):

```powershell
New-Item -ItemType Directory -Force "$env:APPDATA\\Codex" | Out-Null
Copy-Item .\examples\telegram-native.example.json "$env:APPDATA\\Codex\\telegram-native.json"
```

3. Install dependencies:

```powershell
npm install
```

4. Sign into the official Codex app first and make sure a normal Codex chat works.

5. Prepare the patched official-app workspace from the currently installed Microsoft Store package:

```powershell
npm run official:update
```

6. Replace the live app with the freshly prepared local package:

```powershell
npm run official:redeploy
```

7. If the Microsoft Store update path is blocked by the currently registered local package, run the recovery flow instead:

```powershell
npm run official:recover-store
```

## Telegram behavior

- `/codex_new` opens the real native new-thread flow.
- The first Telegram message after `/codex_new` creates the real thread and auto-binds the returned session id.
- `/codex_session` binds a Telegram chat to a Codex session and submits follow-up text through the app-native path.
- `/codex_session` replays the latest 5 instruction/result groups.
- `/codex_model`, `/codex_fast`, `/codex_reasoning`, `/codex_permission`, and `/codex_current` use app-native control or state paths.
- runtime approval prompts are relayed into Telegram with approve or reject actions.
- Telegram images are staged locally and sent through the app-native local-image input path.

## What this repo includes

- [patch/telegram-native.js](patch/telegram-native.js)
- [scripts/inject_native_telegram.mjs](scripts/inject_native_telegram.mjs)
- [scripts/rebuild_patched_asar.mjs](scripts/rebuild_patched_asar.mjs)
- [scripts/update_asar_integrity.mjs](scripts/update_asar_integrity.mjs)
- [scripts/prepare_official_app_workspace.ps1](scripts/prepare_official_app_workspace.ps1)
- [scripts/run_official_telegram_update.ps1](scripts/run_official_telegram_update.ps1)
- [scripts/redeploy_updated_official_telegram.ps1](scripts/redeploy_updated_official_telegram.ps1)
- [scripts/recover_official_store_then_repatch.ps1](scripts/recover_official_store_then_repatch.ps1)
- [examples/telegram-native.example.json](examples/telegram-native.example.json)

## Repository boundary

Publishable:

- `patch/`
- `scripts/`
- `docs/`
- `examples/`
- `README.md`
- `package.json`
- `package-lock.json`
- `.gitignore`

Local-only:

- `%APPDATA%\Codex\telegram-native.json`
- runtime state such as `chat_bindings.json` and `chat_settings.json`
- `work/`
- `tasks/`

Run the publish check before every commit or push:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\prepublish_secret_check.ps1
```
