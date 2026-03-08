# Security notes

## Never publish these files

- `telegram-native.json`
- `chat_bindings.json`
- `chat_settings.json`
- `telegram-inbox/`
- `logs/`
- `work/portable_package_root/`
- `work/full_extract/`
- `work/app.patched.asar`

## Never publish these values

- Telegram bot token
- personal `chat_id`
- your Windows username
- absolute local workspace paths
- screenshots that show the token or your personal chat id

## Before you push

Run:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\prepublish_secret_check.ps1
```

Then manually confirm:

- no token is present in any JSON, Markdown, PowerShell, or log file
- no bare `123456789:token...` value is present in config or docs, even without a `bot` URL prefix
- no user-specific `C:\\Users\\<name>` path is committed
- no live chat id is committed

## If the token was ever exposed

Rotate it immediately in `@BotFather`:

1. open `@BotFather`
2. use `/revoke`
3. generate a new token
4. update only your local `telegram-native.json`
