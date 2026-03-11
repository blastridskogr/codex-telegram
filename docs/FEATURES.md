# Features

This project turns a patched portable Codex Desktop app into a Telegram-controlled Codex surface on Windows.

It does **not** replace Codex with a separate bot backend. Telegram drives the same patched desktop app process and the same Codex conversations.

## App-native control surface

- Telegram support is injected into the patched Codex Desktop app process.
- `/codex_model`, `/codex_fast`, `/codex_reasoning`, `/codex_permission`, and `/codex_current` use app-native control or state paths instead of Telegram-only shadow state.
- `/codex_sandbox` is not a second settings surface. It is only a compatibility redirect to `/codex_permission`.

## Session lifecycle

- One Telegram chat binds to one active Codex conversation at a time.
- `/codex_new` opens the real Codex new-thread flow.
- The first Telegram message after `/codex_new` creates the real thread and auto-binds the returned conversation id.
- Follow-up text on a bound session now goes through the app-native follow-up submit path, so plain Telegram replies after `/codex_bind` or `/codex_session` reach the real thread.
- Session switching mirrors only the latest 5 completed instruction/result pairs, oldest-to-newest inside that latest set.

## Message and media behavior

- Plain Telegram text is injected as a Codex user turn.
- Telegram documents are staged locally and passed as attachments.
- Telegram images are intentionally downgraded to **text + attachment** before injection to avoid corrupting the session payload on the tested build.
- Mirrored assistant responses preserve common Markdown-style formatting in Telegram.
- Mirrored user/app echo stays plain text on purpose.

## Portable workflow

- Build a portable package from your **own** local Codex Desktop installation.
- Inject the Telegram runtime into the extracted bundle.
- Rebuild `app.asar`.
- Rewrite the Electron integrity metadata so the patched package still launches.
- Launch the copied portable app through the official `OpenAI.Codex` desktop-package context.
- Optionally register the copied package as `OpenAI.CodexPortable`.

See [WINDOWS_PORTABLE_SETUP.md](WINDOWS_PORTABLE_SETUP.md) for the full setup flow.

## Safety model

- Telegram access is restricted by `allowedChatIds`.
- Bot token, bindings, logs, runtime state, and repo-local operator notes stay local and are excluded from git.
- The repository does **not** include OpenAI binaries or rebuilt proprietary bundles.

See [SECURITY.md](SECURITY.md) for publish rules and token-handling guidance.

## Current limits

- Tested against Codex Desktop Store build `26.306.996.0`.
- The patcher depends on the current minified renderer/main bundle anchors.
- If OpenAI changes the bundle shape, the patch scripts may need updates.
- The integrity rewrite step requires the portable `Codex.exe` to be closed while rebuilding.

## Practical uses

- Drive Codex from Telegram while away from the desktop UI.
- Switch between existing Codex sessions from Telegram.
- Start a new Codex thread from Telegram and continue in the app.
- Mirror recent session context into Telegram without spending extra model tokens.
- Adjust model, Fast mode, reasoning, and permission settings without opening app menus.
