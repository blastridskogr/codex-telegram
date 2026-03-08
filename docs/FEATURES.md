# Features

This project turns a **portable patched Codex Desktop app** into a Telegram-controlled Codex surface on Windows.

It does **not** replace Codex with a separate bot backend. Telegram controls the same patched Codex app process and the same Codex sessions.

## Core model

- **App-side integration**
  - Telegram support is injected into the patched Codex Desktop app process.
  - The project does not ship a separate long-running bridge server as the primary runtime.

- **Session binding**
  - One Telegram chat can bind to one active Codex session at a time.
  - You can switch the active binding from Telegram with session picker commands.

- **Native New Thread**
  - Telegram can open a real Codex **New Thread** flow.
  - The first Telegram message after `/new` creates the real Codex thread and auto-binds the returned session id.

## Telegram control surface

You can control the patched app from Telegram with both short commands and `codex_*` aliases.

Main controls:

- Session selection
- New thread
- Model selection
- Speed selection
- Reasoning effort selection
- Permission / sandbox selection
- Current status / current binding view

See [TELEGRAM_COMMANDS.md](TELEGRAM_COMMANDS.md) for the full command list.

## Session behavior

- **Session replay on switch**
  - When you switch sessions, Telegram shows only the last **2 hours** of that session's history.
  - The replay window is anchored to the **latest message in the selected session**, not the time when you switched.

- **Assistant formatting**
  - Replayed and live **assistant** responses preserve common Markdown-style formatting in Telegram.
  - **User/app echo stays plain text** on purpose.

- **Same-session usage**
  - Telegram messages are injected into the bound Codex session.
  - Codex responses are mirrored back into Telegram.

## File and image handling

- **Text messages**
  - Plain Telegram text is injected as a Codex user turn.

- **Documents**
  - Telegram documents are staged locally and passed into the Codex workflow as attachments.

- **Images**
  - Telegram images are intentionally downgraded to **text + attachment** before injection.
  - This avoids corrupting the Codex session payload on the tested build.

## Portable app workflow

- Build a portable package from your **own local Codex Desktop installation**
- Inject the Telegram runtime into the extracted bundle
- Rebuild `app.asar`
- Rewrite Electron integrity metadata so the patched package still launches
- Register and launch the portable app side-by-side

See [WINDOWS_PORTABLE_SETUP.md](WINDOWS_PORTABLE_SETUP.md) for the full setup flow.

## Safety model

- Telegram control is restricted by `allowedChatIds`
- Bot token, bindings, logs, and runtime state stay local and are excluded from git
- The repository does **not** include OpenAI binaries or rebuilt proprietary bundles

See [SECURITY.md](SECURITY.md) for publishing and token-handling rules.

## Current limitations

- Tested against Codex Desktop Store build `26.304.1528.x`
- The patcher still depends on the current bundle shape of Codex Desktop
- If OpenAI changes minified renderer/main bundle anchors, patch scripts may need updates
- The first native `/new` turn does not expose a separately documented `serviceTier` field on the tested build
- Sandbox labels reflect Codex write-policy behavior, not full OS isolation

## Practical use cases

- Drive Codex from Telegram while away from the desktop UI
- Switch between existing Codex sessions from Telegram
- Start a new Codex thread from Telegram and continue in the app
- Mirror recent session context into Telegram without spending extra model tokens
- Adjust model, speed, reasoning, and permission settings without opening menus in the app
