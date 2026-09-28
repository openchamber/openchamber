---
title: Jev goal checks and Excalidraw extension
---

## App

### New
- **Goal: Jev checks whether the agent reached your goal.** After each turn it decides whether the work is done, whether work is left, or whether the agent is waiting for you, and a goal that needs you stops right away. Settings → Chat → Goal picks Jev or the small model for the check.
- **Settings/Integrations: a new OpenChamber extensions section installs extras from the OpenChamber team in one click.** Excalidraw is the first one: drawing in `.excalidraw` files and Obsidian drawings now comes from this extension, and opening a drawing without it offers to install it. [Read how it works](https://docs.openchamber.dev/integrations/).
- Sidebar: Timeline rows and the mobile session list show a session's goal and its waiting permission or question requests.

### Fixes
- Sessions: pinned messages and project knowledge are sent to the agent again after a conversation is compacted, and a goal keeps going after a compaction.
- Chat: forking from an answer copies the conversation up to that answer, without a compaction that came later.
- Chat: the text you type in the comment box for a selection is sharp on non-retina screens.
- Chat: grey bands no longer flicker above the message box and the agent status pill.

### SDK
- File editors: declare `contributes.fileEditors` with file-name patterns and Files opens matching files in your page, while OpenChamber keeps saving, autosave and Cmd/Ctrl+S. Use `onFileOpen`, `onFileSnapshot` and `onFileSaved`; set `"content": "binary"` to get and return bytes for formats like spreadsheets or images.

## VS Code
