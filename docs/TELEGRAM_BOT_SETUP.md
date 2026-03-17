# Telegram bot setup

This flow keeps your token and chat id out of the repository.

## 1. Create the bot in BotFather

1. Open Telegram and start a chat with `@BotFather`
2. Send `/newbot`
3. Choose a display name
4. Choose a bot username ending in `bot`
5. Copy the token BotFather returns

Do **not** paste that token into Git, screenshots, or public issues.

## 2. Optional BotFather settings

Useful BotFather commands:

- `/setdescription`
- `/setabouttext`
- `/setuserpic`
- `/setcommands`

If you plan to use the bot only in a private chat, no group-specific setting is required.

The injected Telegram runtime syncs the bot command list itself when it starts. You do not need to manually keep BotFather commands in sync after every code change.

## 3. Get your chat id

1. Open the new bot
2. Press `Start` or send any message such as `hello`
3. In a browser, open:

```text
https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates
```

4. Find `message.chat.id`

Private chat ids are usually a plain positive integer.

## 4. Create the local runtime config

Create:

```text
%APPDATA%\Codex\telegram-native.json
```

Start from [examples/telegram-native.example.json](../examples/telegram-native.example.json).

Minimum required fields:

- `telegramBotToken`
- `allowedChatIds`
- `workspaceRoots`

## 5. Keep secrets local only

Never commit:

- `telegram-native.json`
- `chat_bindings.json`
- `chat_settings.json`
- `telegram-native-inbox/`
- `telegram-native-state/`
- `work/`

This repository's `.gitignore` already blocks those paths. Keep it that way.

## 6. Telegram Desktop note

If command buttons or slash-command suggestions show up on mobile but not on Telegram Desktop, restart Telegram Desktop once. The Bot API state can already be correct while the Desktop client UI is still stale.
