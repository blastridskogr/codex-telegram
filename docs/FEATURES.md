# Features

This project documents a Telegram-driven Codex workflow on Windows: patch and re-register a local Codex app copy so Telegram can sync messages with it in real time, control Codex app commands, and answer runtime approval prompts through the same signed-in app session.

It does **not** replace Codex with a separate bot backend. Telegram drives the same patched desktop app process, the same Codex conversations, and the same signed-in app account path.

## App-native control surface

- Telegram support is injected into the official Codex app process through patched main and renderer bundles.
- `/codex_model`, `/codex_fast`, `/codex_reasoning`, `/codex_permission`, and `/codex_current` use app-native control or state paths.
- runtime approval prompts are relayed into Telegram with approve or reject actions.

## Session lifecycle

- One Telegram chat binds to one active Codex conversation at a time.
- `/codex_new` opens the real Codex new-thread flow.
- The first Telegram message after `/codex_new` creates the real thread and auto-binds the returned `conversationId`.
- Follow-up text on a bound session goes through the app-native follow-up submit path.
- Session switching mirrors the latest 5 instruction/result groups.

## Message and media behavior

- Plain Telegram text is injected as a Codex user turn.
- Bound-session Telegram text is serialized:
  - one Telegram message maps to one Codex input
  - messages sent while Codex is still processing are queued
  - queued messages are submitted to Codex one at a time
- repeated Telegram deliveries are suppressed by `update_id` and `chat_id:message_id`
- Telegram documents are staged locally and passed as attachments.
- Telegram images are staged locally and injected through the app-native local-image input path.
- Telegram image turns use the same serialized bound-session queue as text turns.
- If a media turn is visibly handed off to Codex but the bound submit completion times out, it is not retried as a duplicate input.
- Codex image echoes can be mirrored back to Telegram even when the app exposes them as `data:image/...` URLs.
- Codex app conversation output is mirrored back to Telegram in real time.
- Mirrored assistant responses preserve common Markdown-style formatting in Telegram.
- Mirrored user/app echo stays plain text.

## Official-app workflow

- Start from your own Microsoft Store Codex installation.
- Extract that installed package into `work\official_app_update`.
- Inject the Telegram runtime into the extracted bundle.
- Rebuild `app.asar`.
- Rewrite the executable integrity metadata for the local package copy.
- Re-register the local package copy under the same `OpenAI.Codex` identity and launch it.
- If a Microsoft Store update is blocked by the local dev registration, run the recovery flow that reinstalls the official Store package first and then reapplies the Telegram patch.

## Current maintained boundary

This repo now keeps the `v30` feature line only.

Included:

- Telegram sync
- native app commands
- approval relay
- session/replay behavior
- official Store patch workflow
