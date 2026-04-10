# Telegram commands

The runtime separates general bot commands from Codex control commands.

- General bot commands stay plain.
- Codex control commands use the `codex_*` prefix.

## Core commands

| Command | Purpose |
| --- | --- |
| `/start` | show the startup message |
| `/help` | show the general command groups |
| `/status` | show runtime health, pipe, bindings path, inbox path, workspace roots |
| `/codex_help` | show the Codex control commands |
| `/codex_controls` | open the main Codex control keyboard |
| `/codex_current` | show current session, model, Fast mode, reasoning, permission |
| `/codex_new [prompt]` | open a real native Codex new-thread flow |
| `/codex_session` | open the project picker, then a project-specific recent-session picker |
| `/codex_unbind` | remove the current chat binding |

Compatibility redirects:

- `/codex_sandbox` -> `/codex_permission`
- `/sandbox` -> `/codex_permission`
- `/codex_sessions` -> `/codex_session`

## Session commands

- `/codex_new`
- `/codex_session`

Behavior:

- `/codex_new` does **not** synthesize a fake session. It opens the real Codex new-thread draft in the app.
- the first Telegram message after `/codex_new` creates the real thread through Codex and auto-binds the returned `conversationId`
- after `/codex_session`, plain Telegram follow-up text is submitted through the app-native bound-thread follow-up path
- bind/switch actions open the real Codex conversation in the app before Telegram treats the binding as live
- the first picker groups recent sessions by project path
- the project-specific picker shows `session title + session id + last activity`
- when you switch sessions, the latest 5 instruction/result groups are mirrored back into Telegram as display-only chat output, oldest-to-newest within that latest set
- completed results stay preferred, but a newer assistant progress/commentary block can replay as a partial group when no final summary has been stored yet
- the history replay does **not** cost extra model tokens

## Model controls

- `/codex_model`

The model list is loaded from the local Codex model cache, not hardcoded. The picker reflects the app's selectable model list rather than a Telegram-only default row.

## Fast controls

- `/codex_fast`

Official labels:

- `Standard`
- `Fast`

Internally this maps to the Codex `serviceTier` field.

## Reasoning controls

- `/codex_reasoning`

Reasoning levels are model-dependent. Supported labels may include:

- `Minimal`
- `Low`
- `Medium`
- `High`
- `Extra High`

The picker reflects the app's reasoning options for the currently selected model.

## Permission controls

- `/codex_permission`

These match the app-facing permission surface.

Supported values:

- `Default permissions`
- `Full access`
- `Custom (config.toml)`

## Runtime approvals

- if a Telegram-driven task triggers a Codex runtime approval prompt, Telegram mirrors that prompt with inline buttons
- execution approvals can offer `Approve once`, `Allow session`, or `Reject`, depending on what the app asks for
- file-change approvals offer `Approve` or `Reject`
- these buttons answer the real Codex app approval request; they are not a Telegram-only shadow state

## Current-state view

- `/codex_current`

This reads the live injected app state when the renderer bridge is available, including the current route, conversation id, model, Fast mode, reasoning, and permission mode.

## Desktop command visibility

- the runtime syncs the bot command list and the private-chat menu button automatically
- Telegram Desktop can still lag behind Bot API state; if commands do not appear, fully restart Telegram Desktop once

## Media behavior

- text messages: injected into the bound Codex session
- bound text messages are serialized; if Codex is still processing the prior turn, the new Telegram message waits and is then submitted as the next Codex input
- duplicate Telegram delivery is suppressed with persisted `update_id` and `chat_id:message_id` state
- documents: injected as attachments
- images: staged locally and injected through the app-native local-image input path
- image turns follow the same serialized queue as text turns and are not retried after a visible Codex handoff timeout
- Codex `data:image/...` outputs are materialized locally and sent back to Telegram as images
- mirrored assistant responses preserve common Markdown features such as headings, bold text, inline code, fenced code blocks, links, and blockquotes in Telegram
- mirrored user/app echo stays plain text on purpose so only Codex output is reformatted
