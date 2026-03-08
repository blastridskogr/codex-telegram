# Telegram commands

The runtime supports both the short alias form and the `codex_*` prefixed form.

## Core commands

| Short | Prefixed | Purpose |
| --- | --- | --- |
| `/help` | `/codex_help` | show the Telegram control commands |
| `/status` | `/codex_status` | show runtime health, pipe, bindings path, inbox path, workspace roots |
| `/controls` | `/codex_controls` | open the main control keyboard |
| `/current` | `/codex_current` | show current session, model, speed, reasoning, permission |
| `/new [prompt]` | `/codex_new [prompt]` | open a real native Codex new-thread flow |
| `/session` | `/codex_session` | open the recent-session picker |
| `/unbind` | `/codex_unbind` | remove the current chat binding |

## Session commands

- `/new`
- `/codex_new`
- `/session`
- `/sessions`
- `/bind <session_id>`
- `/bindindex <n>`

Behavior:

- `/new` does **not** synthesize a fake session. It opens the real Codex new-thread flow.
- the first Telegram message after `/new` creates the real thread through Codex and auto-binds the returned `conversationId`
- the picker shows `session title + session id + last activity`
- when you switch sessions, only the last 24 hours of session history are mirrored back into Telegram as display-only chat output
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

Note:

- bound-session turns receive `serviceTier`
- the very first turn of a native `/new` flow follows Codex's exposed `startConversation(...)` surface on the tested build, which exposes `model` and `reasoning` but not a separate documented `serviceTier` field

## Reasoning controls

- `/reasoning`
- `/codex_reasoning`

Reasoning levels are model-dependent. Supported labels may include:

- `Minimal`
- `Low`
- `Medium`
- `High`
- `Extra High`

## Permission controls

- `/permission`
- `/codex_permission`

These match the app-facing permission surface.

## Sandbox compatibility controls

- `/sandbox`
- `/codex_sandbox`

These remain available as compatibility aliases and open the same underlying picker.

Supported values:

- `Basic permission`
- `Full access`
- `Workspace write`
- `Read only`

Current behavior on the tested build:

- `Full access` maps to Codex `danger-full-access`
- `Workspace write` keeps network enabled and broad read access while limiting writes to the selected workspace roots
- `Read only` still keeps network enabled and broad read access; the label describes the write policy, not full OS isolation

## Media behavior

- text messages: injected into the bound Codex session
- documents: injected as attachments
- images: currently downgraded to `text + attachment` for safety
- mirrored assistant responses preserve common Markdown features such as headings, bold text, inline code, fenced code blocks, links, and blockquotes in Telegram
- mirrored user/app echo stays plain text on purpose so only Codex output is reformatted
