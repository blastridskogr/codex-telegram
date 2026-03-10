Option Explicit

Dim shell
Dim repoRoot
Dim ps1Path
Dim command

Set shell = CreateObject("WScript.Shell")
repoRoot = "C:\skogr_project\codex_telegram"
ps1Path = repoRoot & "\scripts\launch_portable_codex.ps1"
command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & ps1Path & """"

shell.Run command, 0, False
