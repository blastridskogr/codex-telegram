# Features

This project documents a Telegram-driven Codex workflow on Windows: patch and re-register a local Codex app copy so Telegram can sync messages with it in real time, control Codex app commands, and answer runtime approval prompts through the same signed-in app session.

It does **not** replace Codex with a separate bot backend. Telegram drives the same patched desktop app process, the same Codex conversations, and the same signed-in app account path.

## App-native control surface

- Telegram support is injected into the official Codex app process through patched main and renderer bundles.
- `/codex_model`, `/codex_fast`, `/codex_reasoning`, `/codex_permission`, and `/codex_current` use app-native control or state paths instead of Telegram-only shadow state.
- `/codex_sandbox` is not a second settings surface. It is only a compatibility redirect to `/codex_permission`.
- runtime approval prompts are relayed into Telegram with inline approve or reject actions, so Telegram-driven work is not blocked by an approval UI that only exists inside the Codex app

## Session lifecycle

- One Telegram chat binds to one active Codex conversation at a time.
- `/codex_new` opens the real Codex new-thread flow.
- The first Telegram message after `/codex_new` creates the real thread and auto-binds the returned `conversationId`.
- Follow-up text on a bound session goes through the app-native follow-up submit path, so plain Telegram replies after `/codex_bind` or `/codex_session` reach the real thread.
- Session switching mirrors the latest 5 instruction/result groups, oldest-to-newest inside that latest set. Completed results stay preferred, and a newer commentary-only work block can replay as a partial group instead of disappearing.

## Message and media behavior

- Plain Telegram text is injected as a Codex user turn.
- Telegram documents are staged locally and passed as attachments.
- Telegram images are staged locally and injected through the app-native local-image input path.
- Codex app conversation output is mirrored back to Telegram in real time.
- Mirrored assistant responses preserve common Markdown-style formatting in Telegram.
- Mirrored user/app echo stays plain text on purpose.

## Official-app workflow

- Start from your own Microsoft Store Codex installation.
- Extract that installed package into `work\official_app_update`.
- Inject the Telegram runtime into the extracted bundle.
- Rebuild `app.asar`.
- Rewrite the executable integrity metadata for the local package copy.
- Re-register the local package copy under the same `OpenAI.Codex` identity and launch it.
- If a Microsoft Store update is blocked by the local dev registration, run the recovery flow that reinstalls the official Store package first and then reapplies the Telegram patch.

## Account behavior

- This workflow assumes you already use the official Codex app normally.
- Sign into the official app first, then patch the local copy.
- If you use ChatGPT Pro on chatgpt.com, sign into the Codex app with that same account before patching.
- On the official website, ChatGPT Pro also includes Codex and ChatGPT agent; use `agent mode` or `/agent` there if you want the official web flow.
- The Telegram-driven path continues through that same signed-in app session.
- Telegram is a control surface for that app session, not a replacement auth path.

See [WINDOWS_OFFICIAL_APP_SETUP.md](WINDOWS_OFFICIAL_APP_SETUP.md) for the full setup flow.

## Safety model

- Telegram access is restricted by `allowedChatIds`.
- Bot token, bindings, logs, runtime state, and repo-local operator notes stay local and are excluded from git.
- The repository does **not** include OpenAI binaries, extracted proprietary bundles, or rebuilt deploy roots.

See [SECURITY.md](SECURITY.md) for publish rules and token-handling guidance.

## Current limits

- Verified against the 2026-03-22 Microsoft Store source package `26.313.5234.0`, re-registered locally as package `26.313.5234.10`.
- The patcher depends on the current minified renderer and main bundle anchors.
- If OpenAI changes the bundle shape, the patch scripts may need updates.
- The live replace step intentionally stops the running Codex app and re-registers the local package copy.
- The recovery flow depends on Microsoft Store being able to reinstall the official package for the current user, with a valid Store sign-in and working network access.

## Archived reference

- Portable-specific scripts still exist in the repo as archived reference only.
- The supported public workflow is the official-app path described above.
