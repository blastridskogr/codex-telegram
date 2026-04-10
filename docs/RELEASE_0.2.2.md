# Release 0.2.2

This patch release changes Telegram session selection to match the Codex app sidebar more closely.

## Changes

- `/codex_session` shows sessions grouped under project path headers in a single message.
- Session buttons bind directly to the selected Codex session.
- Project grouping is based on each session file's `cwd` metadata.
- The project list is built from all active local session files, not just the latest 10 sessions.
- Each project group shows up to 4 recent sessions, with up to 24 session buttons in one picker.

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
