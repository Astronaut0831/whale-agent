' Run a .bat hidden and detached.
' Usage: wscript.exe hidden-run.vbs "D:\path\to\run.bat"
' Keep this file ASCII-only: wscript reads ANSI.
Dim sh, fso, bat
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
If WScript.Arguments.Count = 0 Then WScript.Quit 1
bat = WScript.Arguments(0)
sh.CurrentDirectory = fso.GetParentFolderName(bat)
sh.Run "cmd /c """ & bat & """", 0, False
