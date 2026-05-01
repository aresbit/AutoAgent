!macro customInstall
  Delete "$SMPROGRAMS\\AutoAgent.lnk"
  CreateShortCut "$SMPROGRAMS\\AutoAgent.lnk" "$INSTDIR\\AutoAgent.exe" "" "$INSTDIR\\resources\\icon.ico" 0

  Delete "$DESKTOP\\AutoAgent.lnk"
  CreateShortCut "$DESKTOP\\AutoAgent.lnk" "$INSTDIR\\AutoAgent.exe" "" "$INSTDIR\\resources\\icon.ico" 0
!macroend
