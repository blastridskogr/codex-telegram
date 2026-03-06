# Telegram commands

The runtime supports both the short alias form and the `codex_*` prefixed form.

## Core commands

| Short | Prefixed | Purpose |
| --- | --- | --- |
| `/help` | `/codex_help` | show the Telegram control commands |
| `/status` | `/codex_status` | show runtime health, pipe, bindings path, inbox path, workspace roots |
| `/controls` | `/codex_controls` | open the main control keyboard |
| `/current` | `/codex_current` | show current session, model, speed, reasoning, sandbox |
| `/session` | `/codex_session` | open the recent-session picker |
| `/unbind` | `/codex_unbind` | remove the current chat binding |

## Session commands

- `/session`
- `/sessions`
- `/bind <session_id>`
- `/bindindex <n>`

Behavior:

- the picker shows `session title + session id + last activity`
- when you switch sessions, the full session history is mirrored back into Telegram as display-only chat output
- the history replay does **not** cost extra model tokens

## Model controls

- `/model`
- `/codex_model`

The model list is loaded from the local Codex model cache, not hardcoded.

## Speed controls

- `/speed`
- `/codex_speed`

Official labels:

- `Standard`
- `Fast`

Internally this maps to the Codex `serviceTier` field.

## Reasoning controls

- `/reasoning`
- `/codex_reasoning`

Reasoning levels are model-dependent. Supported labels may include:

- `Minimal`
- `Low`
- `Medium`
- `High`
- `Extra High`

## Sandbox controls

- `/sandbox`
- `/codex_sandbox`

Supported values:

- `Default`
- `Full access`
- `Workspace write`
- `Read only`

## Media behavior

- text messages: injected into the bound Codex session
- documents: injected as attachments
- images: currently downgraded to `text + attachment` for safety

