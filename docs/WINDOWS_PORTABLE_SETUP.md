# Windows portable setup

This repository does not redistribute Codex binaries. It patches a portable package from your **local** Codex Desktop installation.

## Requirements

- Windows 11
- Codex Desktop installed from the Microsoft Store
- Windows Developer Mode enabled
- Node.js 24+
- PowerShell

## Preferred path: one command

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\build_portable.ps1
```

or:

```powershell
npm run build:portable
```

This one command runs the full local patch pipeline:

- install npm dependencies
- prepare `work\portable_package_root`
- extract `app.asar` into `work\full_extract`
- inject the Telegram runtime
- rebuild `work\app.patched.asar`
- copy the rebuilt `app.asar` back into the package root
- rewrite the Electron integrity metadata in `Codex.exe`

If you already installed dependencies, use:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\build_portable.ps1 -SkipNpmInstall
```

You can also register and launch in the same pass after your local config exists:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\build_portable.ps1 -Register -Launch
```

## Manual path (advanced)

## 1. Install repository dependencies

```powershell
npm install
```

## 2. Prepare the portable package root

This copies your installed Codex package into `work/portable_package_root` and patches the manifest so it can register side-by-side as `OpenAI.CodexPortable`.

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\prepare_portable_package.ps1
```

## 3. Extract the copied `app.asar`

```powershell
npx asar extract .\work\portable_package_root\app\resources\app.asar .\work\full_extract
```

## 4. Inject the Telegram runtime into the extracted app

```powershell
node .\scripts\inject_native_telegram.mjs
```

This step:

- copies [patch/telegram-native.js](../patch/telegram-native.js) into the extracted bundle
- renames the app to `Codex Portable`
- moves the app's user data into `%LOCALAPPDATA%\CodexPortableData`
- appends the Telegram bootstrap to `main.js`

## 5. Rebuild the patched `app.asar`

```powershell
node .\scripts\rebuild_patched_asar.mjs
```

## 6. Copy the rebuilt `app.asar` back into the package root

```powershell
Copy-Item .\work\app.patched.asar .\work\portable_package_root\app\resources\app.asar -Force
```

## 7. Rewrite the EXE integrity metadata

If `app.asar` changes, the Windows Electron executable must be updated too.

```powershell
node .\scripts\update_portable_asar_integrity.mjs
```

Without this step the portable app usually exits before `main.js` runs.

## 8. Create the local Telegram config

```powershell
New-Item -ItemType Directory -Force "$env:LOCALAPPDATA\CodexPortableData" | Out-Null
Copy-Item .\examples\telegram-native.example.json "$env:LOCALAPPDATA\CodexPortableData\telegram-native.json"
```

Then edit:

```text
%LOCALAPPDATA%\CodexPortableData\telegram-native.json
```

Set:

- `telegramBotToken`
- `allowedChatIds`
- `workspaceRoots`

## 9. Register the portable package

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\register_portable_package.ps1
```

## 10. Launch the portable app

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\launch_portable_codex.ps1 -InstanceName default
```

The launch script blocks startup if the official Store app is already running. Use one app at a time.

## Runtime files

Typical runtime paths:

- config: `%LOCALAPPDATA%\CodexPortableData\telegram-native.json`
- bootstrap log: `%TEMP%\codex-portable-telegram-bootstrap.log`
- runtime log: `%LOCALAPPDATA%\Packages\OpenAI.CodexPortable_2p2nqsd0c76g0\LocalCache\Local\CodexPortableData\telegram-native.log`

## Updating after a Codex release

If the Codex app updates:

1. re-run `build_portable.ps1`
2. re-register the package
