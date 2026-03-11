# codex-telegram

Telegram control surface for a locally patched **portable Codex Desktop app on Windows**.

[Features](docs/FEATURES.md) | [Windows Setup](docs/WINDOWS_PORTABLE_SETUP.md) | [Bot Setup](docs/TELEGRAM_BOT_SETUP.md) | [Commands](docs/TELEGRAM_COMMANDS.md) | [Security](docs/SECURITY.md)

This repository contains the patch source, build scripts, and setup docs for driving the real Codex desktop app from Telegram. It does **not** include OpenAI binaries, rebuilt `app.asar`, or your runtime secrets.

## Disclaimer

- Unofficial project. It is **not** affiliated with, endorsed by, or published by OpenAI.
- This repository documents a local patch/build workflow. It does **not** redistribute Codex binaries or patched portable outputs.
- You are responsible for reviewing the current OpenAI terms and your local legal/compliance requirements before using, modifying, or publishing anything based on this workflow.

## Current status

Verified baseline:

- Windows 11
- Codex Desktop Store package `26.306.996.0`
- Node.js 24+
- PowerShell 5.1+

Working behavior in the current version:

- build a portable copy from your **local** Codex Desktop installation
- inject Telegram support **inside the Codex app process**
- open a real native Codex new-thread draft with `/codex_new`
- let the first Telegram message create and auto-bind the real thread
- submit follow-up Telegram text on a bound session through the app-native follow-up turn path
- drive the same app-facing model, Fast, reasoning, permission, and current-state controls that the Codex UI uses
- replay only the latest 5 completed instruction/result pairs when you switch sessions

## What this repo includes

- [patch/telegram-native.js](patch/telegram-native.js): injected Telegram runtime
- [scripts/build_portable.ps1](scripts/build_portable.ps1): end-to-end portable build pipeline
- [scripts/inject_native_telegram.mjs](scripts/inject_native_telegram.mjs): bundle patcher for the extracted app
- [scripts/update_portable_asar_integrity.mjs](scripts/update_portable_asar_integrity.mjs): EXE integrity rewrite after `app.asar` changes
- [scripts/launch_portable_codex.ps1](scripts/launch_portable_codex.ps1): portable launcher
- [examples/telegram-native.example.json](examples/telegram-native.example.json): safe local config template
- [docs/](docs): setup, command, and security docs

## What this repo intentionally does not include

- original Codex binaries
- copied `portable_package_root` app files
- rebuilt `app.asar`
- Telegram bot token
- personal chat id
- logs, bindings, or runtime state

That separation is intentional. The publishable repo is meant to explain the workflow and carry the patch source, not to ship OpenAI software.

## Quick start

1. Read [docs/TELEGRAM_BOT_SETUP.md](docs/TELEGRAM_BOT_SETUP.md) and create your bot.
2. Create your local config from [examples/telegram-native.example.json](examples/telegram-native.example.json):

```powershell
New-Item -ItemType Directory -Force "$env:LOCALAPPDATA\\CodexPortableData" | Out-Null
Copy-Item .\examples\telegram-native.example.json "$env:LOCALAPPDATA\\CodexPortableData\\telegram-native.json"
```

3. Build the patched portable package:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\build_portable.ps1
```

or:

```powershell
npm run build:portable
```

4. Launch the portable app:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\launch_portable_codex.ps1 -InstanceName default
```

Optional registration is available if you want a visible `OpenAI.CodexPortable` package entry:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\register_portable_package.ps1
```

## Telegram behavior

- `/codex_new` opens the real native new-thread flow. The first Telegram message after that creates the real thread and auto-binds the returned session id.
- `/codex_bind` and `/codex_session` now lead into working follow-up message submission for the bound thread, not a Telegram-only shell path.
- `/codex_model`, `/codex_fast`, `/codex_reasoning`, `/codex_permission`, and `/codex_current` use app-native control or state paths.
- `/codex_sandbox` is no longer advertised. It only redirects to `/codex_permission` for compatibility.
- mirrored assistant responses preserve common Markdown formatting in Telegram
- mirrored user/app echo stays plain text on purpose
- Telegram images are still downgraded to **text + attachment** before injection for payload safety

Full command reference: [docs/TELEGRAM_COMMANDS.md](docs/TELEGRAM_COMMANDS.md)

## GitHub boundary

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

- `telegram-native.json`
- runtime state such as `chat_bindings.json` and `chat_settings.json`
- `work/`
- `tasks/`
- `FILE_MAP.md`
- `HANDOFF.md`
- `HANDOFF_DETAILED.md`
- `PROJECT_CONTEXT.md`

Run the publish check before every commit or push:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\prepublish_secret_check.ps1
```

## Operating notes

- Close the portable `Codex.exe` before rebuilding or the integrity rewrite step can fail with `EBUSY`.
- The launcher can run even if the official Store app is already open, but debugging is cleaner with one active Telegram poller.
- Telegram Desktop may need a full restart before newly synced bot commands or menu buttons appear.
- Rotate your Telegram bot token before publishing if it was ever exposed in chat, shell history, or screenshots.
- If you publish a fork, keep the same boundary: your own source and docs are one thing; OpenAI binaries, extracted bundles, and patched outputs are another.

## Support

- [Buy Me a Coffee](https://buymeacoffee.com/skogr)
