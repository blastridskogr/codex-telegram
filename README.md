# codex-telegram

Telegram control surface for a **portable patched Codex Desktop app on Windows**.

[Features](docs/FEATURES.md) | [Windows](docs/WINDOWS_PORTABLE_SETUP.md) | [Telegram Bot Setup](docs/TELEGRAM_BOT_SETUP.md) | [Commands](docs/TELEGRAM_COMMANDS.md) | [Security](docs/SECURITY.md)

This repository contains the **patching method**, **Telegram runtime source**, and **setup scripts** for driving the real Codex desktop app from Telegram. It does **not** ship OpenAI binaries.

Keywords: `codex`, `telegram`, `windows`, `portable`, `desktop`, `electron`.

## What this does

- patches your locally installed Codex Desktop package into a portable copy
- injects Telegram control **inside the Codex app process**
- binds one Telegram chat to one Codex conversation
- opens a real Codex **New Thread** draft and lets the first Telegram message create the real thread
- drives the same app-facing model, Fast, reasoning, permission, and current-state paths that the Codex UI uses
- replays only the latest 5 completed instruction/result pairs, oldest-to-newest within that latest set, when you switch sessions

## What this repo intentionally does not include

- original Codex binaries
- copied `portable_package_root` app files
- `app.asar` or any other proprietary OpenAI bundle
- your Telegram token, chat id, logs, or local state

You build the portable package from **your own local Codex installation**.

## Tested baseline

- Windows 11
- Codex Desktop Store package `26.306.996.0`
- Node.js 24+
- PowerShell 5.1+

## Repo layout

- [patch/telegram-native.js](patch/telegram-native.js): native Telegram runtime injected into Codex
- [scripts/build_portable.ps1](scripts/build_portable.ps1): one-click portable build pipeline from local Codex install to patched package
- [scripts/prepare_portable_package.ps1](scripts/prepare_portable_package.ps1): copies the installed package into a portable worktree and patches the manifest
- [scripts/inject_native_telegram.mjs](scripts/inject_native_telegram.mjs): injects the Telegram bootstrap into the extracted app bundle
- [scripts/rebuild_patched_asar.mjs](scripts/rebuild_patched_asar.mjs): rebuilds the patched `app.asar`
- [scripts/update_portable_asar_integrity.mjs](scripts/update_portable_asar_integrity.mjs): rewrites the Windows EXE integrity metadata after `app.asar` changes
- [scripts/register_portable_package.ps1](scripts/register_portable_package.ps1): registers the patched portable package
- [scripts/launch_portable_codex.ps1](scripts/launch_portable_codex.ps1): launches the portable app by borrowing the official `OpenAI.Codex` package context
- [examples/telegram-native.example.json](examples/telegram-native.example.json): safe example config
- [docs/WINDOWS_PORTABLE_SETUP.md](docs/WINDOWS_PORTABLE_SETUP.md): end-to-end Windows setup
- [docs/TELEGRAM_BOT_SETUP.md](docs/TELEGRAM_BOT_SETUP.md): BotFather and chat id setup
- [docs/TELEGRAM_COMMANDS.md](docs/TELEGRAM_COMMANDS.md): slash commands and control surface
- [docs/SECURITY.md](docs/SECURITY.md): pre-publish safety checklist

## Quick start

1. Read [docs/TELEGRAM_BOT_SETUP.md](docs/TELEGRAM_BOT_SETUP.md) and create your bot.
2. Create your local Telegram config from [examples/telegram-native.example.json](examples/telegram-native.example.json):

```powershell
New-Item -ItemType Directory -Force "$env:LOCALAPPDATA\\CodexPortableData" | Out-Null
Copy-Item .\examples\telegram-native.example.json "$env:LOCALAPPDATA\\CodexPortableData\\telegram-native.json"
```

3. Build the patched portable package from your installed Codex Desktop app:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\build_portable.ps1
```

or:

```powershell
npm run build:portable
```

This one command does the full local patch pipeline:

- installs npm dependencies
- prepares `work\\portable_package_root`
- extracts `app.asar`
- injects the Telegram runtime
- rebuilds `work\\app.patched.asar`
- copies the rebuilt `app.asar` back into the package root
- rewrites the Electron integrity metadata

4. Launch the portable package:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\launch_portable_codex.ps1 -InstanceName default
```

Registering the copied package is optional. Do it only if you specifically want a visible `OpenAI.CodexPortable` package registration:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\register_portable_package.ps1
```

If you already created the local config and want one command for build + optional register + launch:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\build_portable.ps1 -Register -Launch
```

## Important operating rules

- The launcher only **warns** if the official Codex app is already running. It sets `CODEX_ALLOW_MULTI_INSTANCE=1` and continues.
- Even though dual launch is allowed, keep only one active Telegram poller for the bot and prefer one Codex instance while debugging runtime issues.
- Rotate your Telegram bot token before publishing if it was ever pasted into a chat, terminal, or screenshot.
- Run `powershell -ExecutionPolicy Bypass -File .\scripts\prepublish_secret_check.ps1` before you commit or push.

## What belongs on GitHub

Publishable:

- `patch/`
- `scripts/`
- `docs/`
- `examples/`
- `README.md`
- `package.json` and `package-lock.json`
- `.gitignore`

Local-only:

- `telegram-native.json`
- runtime state such as `chat_bindings.json` and `chat_settings.json`
- `work/`
- `tasks/`
- `FILE_MAP.md`
- `HANDOFF.md`
- `HANDOFF_DETAILED.md`
- `PROJECT_CONTEXT.md`

## Telegram controls

General commands stay plain. Codex control commands use the `codex_*` prefix.

Examples:

- `/help`
- `/status`
- `/codex_new`
- `/codex_session`
- `/codex_model`
- `/codex_fast`
- `/codex_reasoning`
- `/codex_permission`
- `/codex_current`

Full command reference: [docs/TELEGRAM_COMMANDS.md](docs/TELEGRAM_COMMANDS.md)

## Known behavior

- `/codex_new` opens a real native Codex new-thread flow. The first Telegram message after that creates the real thread and auto-binds the returned session id.
- `/codex_current` reads the live app state through the injected renderer bridge when the app surface is available.
- Fast is exposed in Telegram as `/codex_fast` and maps to the Codex `serviceTier` setting.
- Permission is exposed in Telegram as `/codex_permission` and matches the app-facing permission picker.
- `/codex_sandbox` is kept only as a compatibility redirect to `/codex_permission`.
- mirrored assistant responses preserve common Markdown formatting in Telegram; user/app echo stays plain text on purpose
- Telegram images are currently downgraded to **text + attachment** before they enter Codex. This is intentional to avoid corrupting the Codex session payload.
- Session switching replays only the latest 5 completed instruction/result pairs, ordered chronologically within that latest set, back to Telegram as display-only chat messages. On the tested build the result side is taken from `task_complete.last_agent_message` when available. This does not spend extra model tokens.
- The current workflow is tied to the Windows Store build shape of Codex Desktop. If OpenAI changes the bundle layout, the patch scripts may need updates.

## Support

If this project is useful, you can support it here:

- [Buy Me a Coffee](https://buymeacoffee.com/skogr)
