# Features

This project turns a **portable patched Codex Desktop app** into a Telegram-controlled Codex surface on Windows.

It does **not** replace Codex with a separate bot backend. Telegram drives the same patched Codex app process and the same Codex conversations.

## Core model

- **App-side integration**
  - Telegram support is injected into the patched Codex Desktop app process.
  - The project does not ship a separate long-running bridge server as the primary runtime.

- **Session binding**
  - One Telegram chat can bind to one active Codex session at a time.
  - You can switch the active binding from Telegram with session picker commands.

- **Native New Thread**
  - Telegram can open a real Codex **New Thread** flow.
  - The first Telegram message after `/codex_new` creates the real Codex thread and auto-binds the returned session id.

- **App-native controls**
  - `/codex_model`, `/codex_fast`, `/codex_reasoning`, `/codex_permission`, and `/codex_current` use injected app-native paths instead of Telegram-only shadow state.
  - Compatibility aliases such as `/codex_sandbox` redirect to the app wording instead of exposing a second control surface.

## Telegram control surface

You can control the patched app from Telegram with plain general commands and `codex_*` Codex control commands.

Main controls:

- Session selection
- New thread
- Model selection
- Fast mode selection
- Reasoning effort selection
- Permission selection
- Current status / current binding view

See [TELEGRAM_COMMANDS.md](TELEGRAM_COMMANDS.md) for the full command list.

## Session behavior

- **Session replay on switch**
- When you switch sessions, Telegram shows the **latest 5 completed instruction/result pairs** from that session.
- Replay order is **chronological within that latest set**: oldest pair first, newest pair last.

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
- Launch the copied portable app through the official `OpenAI.Codex` desktop-package context
- Optionally register the copied package as `OpenAI.CodexPortable`

See [WINDOWS_PORTABLE_SETUP.md](WINDOWS_PORTABLE_SETUP.md) for the full setup flow.

## Safety model

- Telegram control is restricted by `allowedChatIds`
- Bot token, bindings, logs, runtime state, and repo-local operator notes stay local and are excluded from git
- The repository does **not** include OpenAI binaries or rebuilt proprietary bundles

See [SECURITY.md](SECURITY.md) for publishing and token-handling rules.

## Current limitations

- Tested against Codex Desktop Store build `26.306.996.0`
- The patcher still depends on the current bundle shape of Codex Desktop
- If OpenAI changes minified renderer/main bundle anchors, patch scripts may need updates
- The integrity rewrite step requires the portable `Codex.exe` to be closed while rebuilding
- Permission control now follows the app-facing permission picker

## Practical use cases

- Drive Codex from Telegram while away from the desktop UI
- Switch between existing Codex sessions from Telegram
- Start a new Codex thread from Telegram and continue in the app
- Mirror recent session context into Telegram without spending extra model tokens
- Adjust model, Fast mode, reasoning, and permission settings without opening menus in the app
