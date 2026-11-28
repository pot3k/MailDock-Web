; Extra installer steps, read by electron-builder into both the installer and the uninstaller (see
; package.json > build.nsis.include).

; Removes the email-app registration that the app adds for the current Windows user (see main.js,
; "default mail client" and the mailto handler), so uninstalling leaves no dead mail entries behind.
!macro customUnInstall
  ; An update or a reinstall runs this uninstaller too, with --updated, and the new version registers
  ; itself again when it starts. Only a real uninstall should remove the registration.
  ${ifNot} ${isUpdated}
    DeleteRegKey HKCU "Software\Classes\MailDockWeb.mailto"
    DeleteRegKey HKCU "Software\MailDock Web"
    DeleteRegValue HKCU "Software\RegisteredApplications" "MailDock Web"

    ; Electron points mailto at this exe on every start. Remove it only while it still names this
    ; copy, so another app's registration is left alone.
    ReadRegStr $0 HKCU "Software\Classes\mailto\shell\open\command" ""
    StrCmp $0 '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"' 0 +2
      DeleteRegKey HKCU "Software\Classes\mailto"
  ${endIf}
!macroend
