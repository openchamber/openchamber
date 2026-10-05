---
title: Initialize Git and keep your picked model
---

## App

### New
- **Git:** a folder without Git shows an Initialize Git button in the Git tab, the pull request view and Changes on mobile. One click creates the repository and the tab opens on it.
- **Models:** a new session starts on the model you last picked in a chat, also after a restart. A project or Settings default still comes first (thanks to @yulia-ivashko).
- Mobile: an Archive button in the sessions list footer opens your archived sessions, with search and restore (thanks to @yulia-ivashko).

### Improvements
- Switching sessions and picking a model or agent stay quick with many projects and providers connected (thanks to chaostheory on Discord).
- Issue and PR picker: an open PR turns orange when its checks fail or it has a conflict, the same as in the sidebar. Going back to an item you already looked at shows it at once.
- Startup: when the app takes more than 10 seconds to start, a line under the logo says so (thanks to @yulia-ivashko).
- Sidebar: Shift+click deletes a worktree that was never pushed without asking, when it has no changes and all its commits are already in main (thanks to @yulia-ivashko).
- Extensions: installing a private repository you have no access to says so and points you to its SSH address.
- Issue and PR picker: titles stand out from ids, authors and labels, and search sits next to the tabs.

### Fixes
- Chat: on a phone or a remote browser whose clock runs ahead of the server, a sent message no longer stays stuck on "OpenCode did not start a reply" until you reload.
- Models: a model you hid in the picker is never chosen for a new session (thanks to @yulia-ivashko).
- Settings: Small Model on "Use default" uses the small model set in your OpenCode config for titles, commit messages and goals (thanks to @yulia-ivashko).
- Commit messages, PR descriptions, walkthroughs and session assist stay on the provider and model you picked.
- Settings: the interface language stays after browser storage is cleared and carries over to your other devices (thanks to @yulia-ivashko).
- Sidebar: sessions you marked done stay out of "In work" (thanks to @yulia-ivashko).
- Usage: xAI Grok with a SuperGrok subscription stays signed in overnight (thanks to @DeryFerd).
- Login: on a server with a UI password, the first message after logging in from a new browser sends (thanks to @yulia-ivashko).
- Sidebar: on a fresh install, the chats group shows the first chat without a "Could not initialize workspace" error (thanks to @yulia-ivashko).
- Usage: configured providers load their quota again on setups where every one of them showed "UnexpectedStatus: 500" (thanks to @bashrusakh).
- Chat: `/btw` answers when an old model from a renamed provider was still remembered (thanks to @DeryFerd).
- Chat: on Windows, file links written as `/C:/...` open the file (thanks to @DeryFerd).
- iPad: in the Home Screen app, the composer rises above the keyboard as soon as you tap it (thanks to @yulia-ivashko).
- Mobile: swiping a wide table or code block sideways scrolls it, and the side drawer opens only once it reaches the end (thanks to @yulia-ivashko).
- Mobile: Mermaid diagrams show their zoom buttons on touch screens and zoom with a pinch (thanks to @yulia-ivashko).
- Server: with a UI password, an expired login shows the Log in banner and the app stops retrying in the background (thanks to @yulia-ivashko).
- Git: adding a remote the repository is not bound to no longer asks you to review the repository's account.
- Git: the history section of a repository with no commits yet says there are no commits and stays in the Git tab.
- Files: Find in the editor leaves the first lines of the file visible (thanks to @hdp01).
- Files: code in Markdown files shows search matches and selections on top of its background (thanks to @theshasha).
- Chat: numbered lists with ten or more items show both digits on mobile, and checklist boxes in numbered lists line up (thanks to @gaojunran and @yulia-ivashko).
- Chat: bold and italic text in a quote keeps the quote's colour (thanks to @gaojunran).
- Chat: links to `http://[::1]:port` get the preview button, like `localhost` (thanks to @cestercian).
- Server: `OPENCODE_HOST` accepts an address with its default port written out, such as `https://host:443`.
- Server: stopping the systemd user service counts as a clean exit.

### SDK
- Shells: with the new `shells` capability an extension can follow the commands running in a session, a project or every session (`onRunningShells`), read their output (`readShellOutput`) and stop them (`stopShell`) (thanks to @28Pollux28).

### Misc
- Bundled OpenCode updated to 2.0.23.

## VS Code

### New
- **Models:** a new session starts on the model you last picked in a chat, also after a restart. A project or Settings default still comes first (thanks to @yulia-ivashko).

### Fixes
- OpenChamber no longer turns grey in every VS Code window at once when several windows are open (thanks to chaostheory on Discord).
- The interface language stays when VS Code restores the panel without its storage (thanks to @yulia-ivashko).
- A model you hid in the picker is never chosen for a new session (thanks to @yulia-ivashko).
- Chat: numbered lists with ten or more items show both digits, and checklist boxes in numbered lists line up (thanks to @gaojunran and @yulia-ivashko).
- Chat: bold and italic text in a quote keeps the quote's colour (thanks to @gaojunran).
