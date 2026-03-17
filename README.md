# codex-telegram

Unofficial Telegram integration for the Windows Codex app: real-time message sync and Codex app commands from Telegram through a locally patched and re-registered copy.

[Features](docs/FEATURES.md) | [Windows Official Setup](docs/WINDOWS_OFFICIAL_APP_SETUP.md) | [Bot Setup](docs/TELEGRAM_BOT_SETUP.md) | [Commands](docs/TELEGRAM_COMMANDS.md) | [Security](docs/SECURITY.md)

This repository contains the patch source, workflow scripts, and setup docs for the Telegram-driven Codex workflow I actually run on Windows. It does **not** include OpenAI binaries, extracted bundles, rebuilt `app.asar`, or your runtime secrets.

## Disclaimer

- Unofficial project. It is **not** affiliated with, endorsed by, or published by OpenAI.
- This repository documents a local patch and re-registration workflow. It does **not** redistribute Codex binaries or patched app bundles.
- You are responsible for reviewing the current OpenAI terms and your local legal/compliance requirements before using, modifying, or publishing anything based on this workflow.

## How I use it

This repository is built around the way I actually use Codex:

- install the official Microsoft Store Codex app
- confirm the official app works on its own before patching anything
- patch and re-register a local copy of that official app so Telegram can drive the same app session
- use Telegram for real-time message sync with the Codex app
- use Telegram to trigger Codex app commands such as session, model, fast mode, reasoning, and permission controls

Official web Pro note:

- if you use ChatGPT Pro on chatgpt.com, sign into the Codex app with the same account before patching
- on the official website, ChatGPT Pro also includes Codex and ChatGPT agent
- to use that official website flow, open ChatGPT, choose `agent mode` from the tools menu or type `/agent`, then describe the task you want done; ChatGPT agent can use a browser and terminal during the task

Optional local Chrome CLI example:

- my local Chrome CLI lives outside this repo at `C:\skogr_project\game_analysis\tools\chrome_chatgpt_cli\chrome_chatgpt_cli.js`
- launch the dedicated Chrome session:

```powershell
node C:\skogr_project\game_analysis\tools\chrome_chatgpt_cli\chrome_chatgpt_cli.js launch
```

- verify that the logged-in official site is open:

```powershell
node C:\skogr_project\game_analysis\tools\chrome_chatgpt_cli\chrome_chatgpt_cli.js status --json
```

- once `https://chatgpt.com/` is open in that Chrome session, switch the page to `agent mode` or type `/agent`, then use the official website agent there

The important boundary is:

- Telegram does **not** replace Codex auth with a separate backend
- Telegram drives that same locally running Codex app
- that app keeps using its own signed-in account, plan limits, and conversation state

## Current workflow

The current supported path is:

- start from the official Microsoft Store Codex installation on the same machine
- extract that installed package into a local ignored workspace
- inject the Telegram runtime into the extracted main and renderer bundle
- rebuild `app.asar`
- update the executable integrity metadata for the local package copy
- re-register a local `OpenAI.Codex` package copy and launch it
- if the Store update path is blocked by the local dev registration, recover by reinstalling the official Store package first and then reapplying the Telegram patch

Verified baseline on 2026-03-17:

- Windows 11
- Microsoft Store Codex source package `26.313.5234.0`
- Telegram-patched registered package `26.313.5234.4`
- Node.js 24+
- PowerShell 5.1+

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

If you use ChatGPT Pro on chatgpt.com, sign into the Codex app with that same account before patching.

5. Prepare the patched official-app workspace from the currently installed Microsoft Store package:

```powershell
npm run official:update
```

6. Replace the live app with the freshly prepared local package:

```powershell
npm run official:redeploy
```

7. If the Microsoft Store update path is blocked by the currently registered local package, run the full recovery flow instead:

```powershell
npm run official:recover-store
```

The recovery flow removes the local `OpenAI.Codex` dev registration, installs the latest available Microsoft Store package for this user, rebuilds the Telegram-patched local package from that fresh official source, and launches it again.

## What this repo includes

- [patch/telegram-native.js](patch/telegram-native.js): injected Telegram runtime
- [scripts/inject_native_telegram.mjs](scripts/inject_native_telegram.mjs): main and renderer bundle patcher
- [scripts/rebuild_patched_asar.mjs](scripts/rebuild_patched_asar.mjs): rebuilds the patched `app.asar`
- [scripts/update_asar_integrity.mjs](scripts/update_asar_integrity.mjs): rewrites executable integrity metadata after `app.asar` changes
- [scripts/prepare_official_app_workspace.ps1](scripts/prepare_official_app_workspace.ps1): extracts the currently installed official package into `work\official_app_update`
- [scripts/run_official_telegram_update.ps1](scripts/run_official_telegram_update.ps1): stage/build/apply wrapper for the official workflow
- [scripts/redeploy_updated_official_telegram.ps1](scripts/redeploy_updated_official_telegram.ps1): detached re-registration of the patched local package
- [scripts/recover_official_store_then_repatch.ps1](scripts/recover_official_store_then_repatch.ps1): full Store reinstall + Telegram re-registration recovery path
- [examples/telegram-native.example.json](examples/telegram-native.example.json): safe local config template
- [docs/](docs): setup, command, and security docs

## Archived portable scripts

Portable-specific helpers still exist in `scripts/` as archived reference. The supported public workflow is the official-app path above.

## Telegram behavior

- `/codex_new` opens the real native new-thread flow. The first Telegram message after that creates the real thread and auto-binds the returned session id.
- `/codex_bind` and `/codex_session` submit follow-up text into the bound thread through the app-native path.
- `/codex_model`, `/codex_fast`, `/codex_reasoning`, `/codex_permission`, and `/codex_current` use app-native control or state paths.
- `/codex_sandbox` is no longer advertised. It only redirects to `/codex_permission` for compatibility.
- mirrored assistant responses preserve common Markdown formatting in Telegram
- mirrored user/app echo stays plain text on purpose
- Telegram images are still downgraded to **text + attachment** before injection for payload safety

That means the Telegram side is using the same signed-in Codex app you already use, not a separate Codex account path.

Full command reference: [docs/TELEGRAM_COMMANDS.md](docs/TELEGRAM_COMMANDS.md)

## What this repo intentionally does not include

- original Codex binaries
- extracted official package roots
- rebuilt `app.asar`
- locally registered deploy roots
- Telegram bot token
- personal chat id
- logs, bindings, inbox files, or runtime state

That separation is intentional. The publishable repo is meant to explain the workflow and carry the patch source, not to ship OpenAI software.

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

- `%APPDATA%\Codex\telegram-native.json`
- runtime state such as `chat_bindings.json` and `chat_settings.json`
- `work/`
- `tasks/`
- `FILE_MAP.md`
- `HANDOFF.md`
- `HANDOFF_DETAILED.md`
- `PROJECT_CONTEXT.md`
- `OFFICIAL_APP_AGENT_RUNBOOK.md`

Run the publish check before every commit or push:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\prepublish_secret_check.ps1
```

## Operating notes

- The normal live replace step intentionally stops the running Codex app. Run the detached redeploy or recovery flow from an external PowerShell session if you are currently using the app.
- Telegram Desktop may need a full restart before newly synced bot commands or menu buttons appear.
- Rotate your Telegram bot token before publishing if it was ever exposed in chat, shell history, or screenshots.
- If you publish a fork, keep the same boundary: your own source and docs are one thing; OpenAI binaries, extracted bundles, and patched outputs are another.
