Option Explicit

Dim shell
Dim scriptDir
Dim ps1Path
Dim command

Set shell = CreateObject("WScript.Shell")
scriptDir = CreateObject("Scripting.FileSystemObject").GetParentFolderName(WScript.ScriptFullName)
ps1Path = scriptDir & "\launch_portable_codex.ps1"
command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File """ & ps1Path & """"

shell.Run command, 0, False
