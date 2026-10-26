# electron-builder inserts this file at the top of the NSIS installer and
# uninstaller scripts. The build.nsis.include option in package.json points
# here.
#
# An executable that declares no DPI awareness is scaled by Windows as a
# bitmap, so the installer and the uninstaller look blurred at a display scale
# factor above 100 percent. NSIS scales its own dialogs when the manifest
# declares DPI awareness.
!macro customHeader
  ManifestDPIAware true
!macroend
