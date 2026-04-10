# Release 0.2.1

This patch release adds project-grouped session selection for Telegram.

## Changes

- `/codex_session` now opens a project-grouped session picker.
- Projects are derived from each Codex session file's `cwd` metadata, matching the workspace/project concept shown in the Codex app.
- Session buttons are listed under project headers.
- The project scan covers all active local session files, not only the latest 10 sessions.

## Existing Behavior Kept

- Text input queueing.
- Duplicate Telegram delivery suppression.
- Telegram image and document input.
- Runtime approval relay.
- Codex response mirroring.
- Official Microsoft Store app patch and re-register workflow.

## Verification

- JavaScript syntax checks for the Telegram runtime and patch scripts.
- `scripts/prepublish_secret_check.ps1`.
- `git diff --check`.
- Local project grouping scan confirmed multiple project roots from Codex session metadata.
