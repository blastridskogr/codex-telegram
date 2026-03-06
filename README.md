# codex-telegram

Telegram control surface for a **portable patched Codex Desktop app on Windows**.

[Windows](docs/WINDOWS_PORTABLE_SETUP.md) · [Telegram Bot Setup](docs/TELEGRAM_BOT_SETUP.md) · [Commands](docs/TELEGRAM_COMMANDS.md) · [Security](docs/SECURITY.md)

This repository documents and packages the **patching method**, **Telegram runtime source**, and **setup scripts**. It does **not** ship OpenAI's application binaries.

Keywords: `codex`, `telegram`, `windows`, `portable`, `desktop`, `electron`.

## What this does

- patches a locally installed Codex Desktop package into a side-by-side portable package
- injects Telegram control **inside the app process**
- binds a Telegram chat to a Codex session
- lets Telegram switch session, model, speed, reasoning, and sandbox
- mirrors full session history into Telegram when you switch sessions

## What this repo intentionally does not include

- original Codex binaries
- copied `portable_package_root_v2` app files
- `app.asar` or any other proprietary OpenAI bundle
- your Telegram token, chat id, logs, or local state

You build the portable package from **your own local Codex installation**.

## Tested baseline

- Windows 11
- Codex Desktop Store package `26.304.1528.x`
- Node.js 24+
- PowerShell 5.1+

## Repo layout

- [patch/telegram-native.js](patch/telegram-native.js): native Telegram runtime injected into Codex
- [scripts/prepare_portable_package.ps1](scripts/prepare_portable_package.ps1): copies the installed package into a portable worktree and patches the manifest
- [scripts/inject_native_telegram.mjs](scripts/inject_native_telegram.mjs): injects the Telegram bootstrap into the extracted app bundle
- [scripts/rebuild_patched_asar.mjs](scripts/rebuild_patched_asar.mjs): rebuilds the patched `app.asar`
- [scripts/update_portable_asar_integrity.mjs](scripts/update_portable_asar_integrity.mjs): rewrites the Windows EXE integrity metadata after `app.asar` changes
- [scripts/register_portable_package.ps1](scripts/register_portable_package.ps1): registers the patched portable package
- [scripts/launch_portable_codex.ps1](scripts/launch_portable_codex.ps1): launches the portable app
- [examples/telegram-native.example.json](examples/telegram-native.example.json): safe example config
- [docs/WINDOWS_PORTABLE_SETUP.md](docs/WINDOWS_PORTABLE_SETUP.md): end-to-end Windows setup
- [docs/TELEGRAM_BOT_SETUP.md](docs/TELEGRAM_BOT_SETUP.md): BotFather and chat id setup
- [docs/TELEGRAM_COMMANDS.md](docs/TELEGRAM_COMMANDS.md): slash commands and control surface
- [docs/SECURITY.md](docs/SECURITY.md): pre-publish safety checklist

## Quick start

1. Read [docs/TELEGRAM_BOT_SETUP.md](docs/TELEGRAM_BOT_SETUP.md) and create your bot.
2. Install dependencies:

```powershell
npm install
```

3. Prepare a portable package from your installed Codex Desktop app:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\prepare_portable_package.ps1
```

4. Extract the copied `app.asar`:

```powershell
npx asar extract .\work\portable_package_root_v2\app\resources\app.asar .\work\full_extract
```

5. Inject the Telegram runtime and rebuild:

```powershell
node .\scripts\inject_native_telegram.mjs
node .\scripts\rebuild_patched_asar.mjs
node .\scripts\update_portable_asar_integrity.mjs
```

6. Create your local config from [examples/telegram-native.example.json](examples/telegram-native.example.json):

```powershell
New-Item -ItemType Directory -Force "$env:LOCALAPPDATA\\CodexPortableData" | Out-Null
Copy-Item .\examples\telegram-native.example.json "$env:LOCALAPPDATA\\CodexPortableData\\telegram-native.json"
```

7. Register and launch the portable package:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\register_portable_package.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\launch_portable_codex.ps1 -InstanceName default
```

## Important operating rules

- Run **either** the official Codex app **or** the portable app, not both. Running both can cause duplicated input and follower/session conflicts.
- Rotate your Telegram bot token before publishing if it was ever pasted into a chat, terminal, or screenshot.
- Do not commit `telegram-native.json`, chat bindings, logs, or any `work/` output.

## Telegram controls

Short aliases and `codex_*` prefixed commands are both supported.

Examples:

- `/session` or `/codex_session`
- `/model` or `/codex_model`
- `/speed` or `/codex_speed`
- `/reasoning` or `/codex_reasoning`
- `/sandbox` or `/codex_sandbox`
- `/current` or `/codex_current`

Full command reference: [docs/TELEGRAM_COMMANDS.md](docs/TELEGRAM_COMMANDS.md)

## Known behavior

- Telegram images are currently downgraded to **text + attachment** before they enter Codex. This is intentional to avoid corrupting the Codex session payload.
- Session switching mirrors the session history back to Telegram as display-only chat messages. This does not spend extra model tokens.
- The current workflow is tied to the Windows Store build shape of Codex Desktop. If OpenAI changes the bundle layout, the patch scripts may need updates.

## Support

If this project is useful, you can support it here:

- [Buy Me a Coffee](https://buymeacoffee.com/skogr)
