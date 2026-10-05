---
title: Initialize Git from the app
---

## App

### New
- **Git:** a folder without Git shows an Initialize Git button in the Git tab, the pull request view and Changes on mobile. One click creates the repository and the tab opens on it.

### Improvements
- Switching sessions and picking a model or agent stay quick with many projects and providers connected (thanks to chaostheory on Discord).

### Fixes
- Chat: on a phone or a remote browser whose clock runs ahead of the server, a sent message no longer stays stuck on "OpenCode did not start a reply" until you reload.
- Git: the history section of a repository with no commits yet says there are no commits and stays in the Git tab.
- Server: `OPENCODE_HOST` accepts an address with its default port written out, such as `https://host:443`.

### Misc
- Bundled OpenCode updated to 2.0.23.

## VS Code

### Fixes
- OpenChamber no longer turns grey in every VS Code window at once when several windows are open (thanks to chaostheory on Discord).
