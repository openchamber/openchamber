---
title: Reliable project actions
---

## App

### New
- **VS Code: comments on code.** Select lines, click the `+` in the gutter or right-click → OpenChamber → Add Comment, and write your note. It stays pinned to the code and goes out with your next message as a context card. Works in diffs too (thanks to @felipegenef).
- Project actions in worktrees: a session in a worktree can use the parent project's saved actions (thanks to @mattv8).
- VS Code: the extension is available in Turkish (thanks to @fitzgpt).

### Improvements
- **Project actions:** the running state of a saved action is reliable now. It shows as running only while the command is really running, every device sees the same state, and the sidebar shows which project has something running (thanks to @mattv8).
- Chat: Markdown tables are readable again, columns take the width their content needs (thanks to @ChangeHow).
- Mobile: with a draft typed, the collapsed composer always has a send button. While the agent is working, that button queues the message (thanks to @ChangeHow).
- Server: OpenCode config paths respect `XDG_CONFIG_HOME` (thanks to @travisdoherty).
- VS Code: a fresh install uses VS Code's language until you choose one in Settings.
- Updates: the update dialog shows each new release with its title and its New, Improvements, and Fixes groups.

### Fixes
- **Settings/Providers:** editing a custom provider keeps all of its model settings, and VS Code saves the protocol you chose (thanks to @hehuaiyu).
- Chat: huge patches in tool cards open without freezing the page (thanks to @karimodm).
- Chat: pressing Enter to confirm text on a Japanese, Chinese, or Korean keyboard no longer sends a comment by accident (thanks to @ChangeHow).
- Chat: a queued slash command with attached context is delivered correctly, and the "Queued messages" card disappears after the last message goes out.
- Goal Mode: when a reply is cut off by the length limit, the goal continues, and Resume gives it another try (thanks to @bashrusakh).
- Sessions: subagent sessions are found in projects with more than 200 sessions (thanks to @bashrusakh).
- Server: the terminal works in the Docker image, and non-Latin text renders correctly there (thanks to @yulia-ivashko).
- CLI: on Windows, `openchamber` starts the server under Bun when Bun is installed.
- VS Code: on Windows, the status command and adding a folder to the workspace handle drive-letter case correctly (thanks to @pttydou).
- VS Code: permission auto-accept works again with the stable OpenCode (thanks to @bashrusakh).

## VS Code

### New
- **Comments on code.** Select lines, click the `+` in the gutter or right-click → OpenChamber → Add Comment, and write your note. It stays pinned to the code and goes out with your next message as a context card. Works in diffs too (thanks to @felipegenef).
- The extension is available in Turkish (thanks to @fitzgpt).

### Improvements
- Chat: Markdown tables are readable again, columns take the width their content needs (thanks to @ChangeHow).
- A fresh install uses VS Code's display language until you choose one in Settings.

### Fixes
- Settings/Providers: editing a custom provider keeps all of its model settings, and the protocol you chose is saved (thanks to @hehuaiyu).
- Chat: huge patches in tool cards open without freezing the page (thanks to @karimodm).
- Chat: pressing Enter to confirm text on a Japanese, Chinese, or Korean keyboard no longer sends a comment by accident (thanks to @ChangeHow).
- Goal Mode: when a reply is cut off by the length limit, the goal continues, and Resume gives it another try (thanks to @bashrusakh).
- Sessions: subagent sessions are found in projects with more than 200 sessions (thanks to @bashrusakh).
- Permission auto-accept works again with the stable OpenCode (thanks to @bashrusakh).
- On Windows, the status command and adding a folder to the workspace handle drive-letter case correctly (thanks to @pttydou).
