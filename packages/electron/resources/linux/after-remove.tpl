#!/bin/bash

# electron-builder's after-remove.tpl without the /usr/bin/${executable} link,
# which after-install.tpl no longer creates. The profile goes only on a real
# removal: an rpm upgrade runs the old package's %postun ($1 = 1) after the new
# package's %post has installed the profile again.

APPARMOR_PROFILE_DEST='/etc/apparmor.d/${executable}'

case "$1" in
  0|remove|purge)
    if [ -f "$APPARMOR_PROFILE_DEST" ]; then
      rm -f "$APPARMOR_PROFILE_DEST"
    fi
    ;;
esac
