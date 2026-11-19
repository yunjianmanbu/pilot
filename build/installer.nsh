; Pilot installs per-user (%LOCALAPPDATA%\Programs\Pilot) on purpose.
;
; Older builds were installed machine-wide into C:\Program Files. electron-builder
; detects that HKLM entry and would normally preselect "install for all users",
; which raises UAC and writes back into Program Files. Force the per-user mode
; for manual installs as well as silent updates so an existing machine-wide copy
; is left untouched and the new version lands where the user can update it
; without a Windows authorization prompt.
!macro customInit
  StrCpy $hasPerMachineInstallation "0"
  StrCpy $hasPerUserInstallation "1"
  !insertmacro setInstallModePerUser
!macroend

!macro customInstallMode
  ; Skip the "all users / only me" page: per-user is the only supported mode.
  StrCpy $isForceCurrentInstall "1"
!macroend

!macro customInstall
  ; Assisted installers normally relaunch via the finish page, which is skipped
  ; for silent updates. Older updaters do not pass --force-run, so relaunch here
  ; as a fallback. New updaters pass --force-run and take the native path.
  ${if} ${Silent}
  ${andif} ${isUpdated}
  ${andifNot} ${isForceRun}
    ${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "--updated"
  ${endif}
!macroend
