# Release 0.2.0

This release is the official-app `v30` Telegram feature line, cleaned up for public use.

It keeps the Telegram integration focused on the Windows Codex desktop app. It does not ship OpenAI binaries, extracted app bundles, rebuilt `app.asar` files, local runtime state, Telegram bot tokens, or private chat ids.

## What Is Included

- Telegram text input into the active Codex conversation.
- Serialized Telegram input queue for bound Codex sessions.
- Duplicate Telegram delivery suppression using persisted `update_id` and `chat_id:message_id`.
- Telegram photo and image-document input through Codex local-image turns.
- Telegram document staging as Codex attachments.
- Codex response mirroring back to Telegram.
- Runtime approval relay from Codex to Telegram.
- Codex app controls for session, model, Fast mode, reasoning effort, and permission mode.
- Official Microsoft Store app extract, patch, rebuild, and re-register workflow.

## Command Surface

Visible Telegram commands:

- `/start`
- `/help`
- `/status`
- `/codex_help`
- `/codex_controls`
- `/codex_current`
- `/codex_new`
- `/codex_session`
- `/codex_model`
- `/codex_fast`
- `/codex_reasoning`
- `/codex_permission`
- `/codex_unbind`

Session binding is intentionally centered on `/codex_session` and its inline picker. Direct session-id binding commands are not advertised or registered as visible bot commands.

## Removed From The Public Line

- Experimental manager-lane documentation.
- Controller-managed subthread automation docs.
- Third-party automation setup references.
- Portable package workflow scripts.
- Local debug, hotpatch, restore, and runtime-only files.

## Setup Summary

1. Install the official Microsoft Store Codex app.
2. Sign into Codex and confirm a normal chat works.
3. Create a Telegram bot and keep its token local.
4. Copy `examples/telegram-native.example.json` to `%APPDATA%\Codex\telegram-native.json`.
5. Fill in `telegramBotToken` and `allowedChatIds` locally.
6. Run `npm install`.
7. Run `npm run official:update`.
8. Run `npm run official:redeploy`.

The patched app remains a local re-registered copy of your own official app install. The repository only contains patch source, scripts, docs, and a safe config template.

## Verification

Before publishing this release, the following checks passed:

- JavaScript syntax checks for the Telegram runtime and patch scripts.
- `scripts/prepublish_secret_check.ps1`.
- `git diff --check`.
- Public-tree scans for removed experimental automation terms, local user paths, live chat ids, and Telegram token patterns.

## Privacy Boundary

Keep these local only:

- `%APPDATA%\Codex\telegram-native.json`
- Telegram bot tokens
- Telegram chat ids
- `work/`
- `tasks/`
- generated `app.asar`
- extracted or re-registered Codex package roots
- runtime logs, inbox files, and state files
