!macro NSIS_HOOK_POSTINSTALL
  SetRegView 64
  WriteRegDWORD HKLM "SYSTEM\CurrentControlSet\Control\FileSystem" "LongPathsEnabled" 1
!macroend
