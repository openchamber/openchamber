---
title: Enterprise mode and Excalidraw extension
---

## App

### New
- **Enterprise mode for teams.** Set `OPENCHAMBER_ENTERPRISE_MODE=1` on the server and conversations stay with the model providers in your OpenCode config: Jev, OpenAI speech, external tunnels and the shared relay are off, push notifications carry no message text, and providers are managed only in the config. [See what it covers](https://docs.openchamber.dev/security/#enterprise-mode).
- **Settings/Integrations: a new OpenChamber extensions section installs extras from the OpenChamber team in one click.** Excalidraw is the first one: drawing in `.excalidraw` files and Obsidian drawings now comes from this extension, and opening a drawing without it offers to install it. [Read how it works](https://docs.openchamber.dev/integrations/).
- Goal: Jev can check whether the agent reached your goal. After each turn it decides whether the work is done, whether work is left, or whether the agent is waiting for you. Pick it in Settings → Chat → Goal; the small model checks by default.
- Settings/Providers: Jev can run on your own endpoint. Enter its URL, model and an optional key under Classification providers, or set it for a whole team with `OPENCHAMBER_JEV_URL`.
- Sidebar: Timeline rows and the mobile session list show a session's goal and its waiting permission or question requests.

### Fixes
- **Settings/Providers: Jev stays off until you pick a classification provider.** Your messages were reaching OpenCode Zen without you choosing it. Off is now its own option and the default.
- Extensions: an extension page can reach the internet only through the addresses you approved when installing it, so it cannot send what it shows anywhere else.
- Git and walkthrough: commit messages, pull request descriptions and diff walkthroughs use the small model you picked or the provider you work with, never another connected provider.
- Chat: Arabic, Hebrew and Persian text reads right to left in messages and in the message box, with punctuation, lists and quotes on the right side (thanks to @yulia-ivashko).
- Chat: an error in one session stays in that session and no longer appears in every other session you open (thanks to @internetisalie and @yulia-ivashko).
- Sessions: pinned messages and project knowledge are sent to the agent again after a conversation is compacted, and a goal keeps going after a compaction.
- Chat: forking from an answer copies the conversation up to that answer, without a compaction that came later.
- Desktop: a greeting or banner printed by your shell profile no longer drops one of your environment variables (thanks to @SulimanAbdulrazzaq).
- Files: README files show their HTML blocks and badges in the Markdown preview.
- Chat: the text you type in the comment box for a selection is sharp on non-retina screens.
- Chat: grey bands no longer flicker above the message box, the queue and the agent status pill.

### SDK
- Extension pages can no longer reach the network on their own. Ship fonts and images inside your package, use `request` for your integration's API, or list up to 8 https addresses in `contributes.origins`; the user approves them, and they open `fetch`, images, fonts, styles and media, never scripts.
- File editors: declare `contributes.fileEditors` with file-name patterns and Files opens matching files in your page, while OpenChamber keeps saving, autosave and Cmd/Ctrl+S. Use `onFileOpen`, `onFileSnapshot` and `onFileSaved`; set `"content": "binary"` to get and return bytes for formats like spreadsheets or images.

## VS Code

### Fixes
- Chat: Arabic, Hebrew and Persian text reads right to left in messages and in the message box, with punctuation, lists and quotes on the right side (thanks to @yulia-ivashko).
- Chat: an error in one session stays in that session and no longer appears in every other session you open (thanks to @internetisalie and @yulia-ivashko).
