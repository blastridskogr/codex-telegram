# Security

## Compliance note

- This is an unofficial workflow repository, not an OpenAI distribution channel.
- Keep the repository limited to your own patch source, scripts, and documentation.
- Do not publish OpenAI binaries, extracted proprietary bundles, rebuilt `app.asar` files, or registered deploy roots.
- Before using or publishing the workflow, review the current OpenAI terms yourself and make your own compliance decision.

## Publishable vs local-only

Publishable:

- `README.md`
- `docs/`
- `examples/`
- `patch/`
- `scripts/`
- `package.json`
- `package-lock.json`
- `.gitignore`

Local-only:

- `%APPDATA%\Codex\telegram-native.json`
- `%APPDATA%\Codex\telegram-native.log`
- `%APPDATA%\Codex\telegram-native-state\`
- `%APPDATA%\Codex\telegram-native-inbox\`
- `tasks/`
- `FILE_MAP.md`
- `HANDOFF.md`
- `HANDOFF_DETAILED.md`
- `PROJECT_CONTEXT.md`
- `OFFICIAL_APP_AGENT_RUNBOOK.md`
- `work/`
- repo-local logs, inbox dumps, and verification artifacts

## Never publish

- Telegram bot token
- personal `chat_id`
- your Windows username
- absolute user-profile paths
- extracted official package roots
- staged or registered `package_root_telegram_registered_v*` directories
- screenshots that expose the token or your private chat id

## Before every commit or push

Run:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\prepublish_secret_check.ps1
```

The script now does two checks:

- scans tracked and non-ignored files for likely Telegram tokens, live chat ids, and user-specific paths
- fails if known local-only files are tracked in git at all

Then manually confirm:

- no token appears in Markdown, JSON, PowerShell, or JavaScript
- no real chat id appears in docs, examples, or config
- no local-only operator notes or task files are tracked
- no runtime artifact from `work/` is staged for commit

## If the token was ever exposed

Rotate it immediately in `@BotFather`:

1. open `@BotFather`
2. use `/revoke`
3. generate a new token
4. update only your local `telegram-native.json`
