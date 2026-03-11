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
| `/codex_session` | open the recent-session picker |
| `/codex_bind <session_id>` | bind this chat to a specific session |
| `/codex_bindindex <n>` | bind this chat to a session from the recent-session list |
| `/codex_unbind` | remove the current chat binding |

Compatibility redirects:

- `/codex_sandbox` -> `/codex_permission`
- `/sandbox` -> `/codex_permission`
- `/codex_sessions` -> `/codex_session`

## Session commands

- `/codex_new`
- `/codex_session`
- `/codex_bind <session_id>`
- `/codex_bindindex <n>`

Behavior:

- `/codex_new` does **not** synthesize a fake session. It opens the real Codex new-thread draft in the app.
- the first Telegram message after `/codex_new` creates the real thread through Codex and auto-binds the returned `conversationId`
- the picker shows `session title + session id + last activity`
- when you switch sessions, only the latest 5 completed instruction/result pairs are mirrored back into Telegram as display-only chat output, oldest-to-newest within that latest set
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

## Current-state view

- `/codex_current`

This reads the live injected app state when the renderer bridge is available, including the current route, conversation id, model, Fast mode, reasoning, and permission mode.

## Media behavior

- text messages: injected into the bound Codex session
- documents: injected as attachments
- images: currently downgraded to `text + attachment` for safety
- mirrored assistant responses preserve common Markdown features such as headings, bold text, inline code, fenced code blocks, links, and blockquotes in Telegram
- mirrored user/app echo stays plain text on purpose so only Codex output is reformatted
