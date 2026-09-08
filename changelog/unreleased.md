---
title: Turn stats in work status
---

## App

### New

- **Turn stats:** The work status panel now shows response speed, model and tool time, tokens, and reported cost after a turn finishes. It's enabled by default (thanks to @alvins82).
- **Projects:** Move project actions, worktree setup commands, and draft starters into the repository for teammates to use. Repository commands ask for trust before running, and ask again when they change.
- Plans: Move plans into the repository, or point the Plans tab at an existing folder of Markdown files in your project.
- Sessions: Search projects by name or path in the new-session project picker on web and desktop (thanks to @maximtop).
- Usage: Charm Hyper now shows your remaining Hypercredits and their dollar value (thanks to @airtaxi).
- Settings: "Always show scrollbars" keeps scrollbars visible on this device when you move the pointer away.

### Improvements

- Chat: `/btw` now opens a separate composer with its own draft, model, and effort. Select message text and choose "By the way…" to ask about it, or use `/btw <question>` to send immediately (thanks to @ChangeHow).
- Settings: Theme, fonts, and chat layout can differ between web, desktop, mobile, and VS Code. Panel sizes and other device choices stay on the device.
- Terminal: Text renders consistently across tabs, borders and block graphics join cleanly, and touch users get a copy button beside the tabs.
- Chat: Ctrl+N/P navigation works across model lists, menus, and autocomplete. Reopening the model picker brings the selected model into view (thanks to @ChangeHow).
- Settings/Chat: Send-shortcut choices and large-text paste behavior have clearer descriptions (thanks to @ChangeHow).
- Chat: More compact text and spacing, stronger headings and contrast, consistent Activity rows, and a divider before the final answer make replies easier to read.
- Chat: Selected text uses the same visible highlight in messages, file previews, and comments across themes.

### Fixes

- Chat: Forking a user message restores its text and attachments in the new composer's draft and preserves the source draft (thanks to @karimodm).
- Chat: Interrupted tools stop showing an endless running timer after a reload (thanks to @alvins82).
- Chat: Attached images no longer appear twice just after sending.
- Chat: Opening panels or resizing the window keeps you at the end when following the latest reply. Sending no longer leaves a large blank area below the message.
- Chat: Streaming Thinking stays inside its scroll box. Scrolling or dragging upward pauses its automatic scrolling so you can read earlier reasoning (thanks to @alvins82).
- Chat: Enter adds a newline in the expanded composer; Ctrl/Cmd+Enter sends. Keyboard selection of a project or worktree returns focus to the input (thanks to @ChangeHow).
- Chat: Narrow Markdown tables fit their columns, removing the empty bordered space on the right (thanks to @ChangeHow).
- Sessions: Opening or restoring a session whose worktree was deleted leaves moving it to another directory up to you.
- Mobile: The uncommitted-changes tooltip no longer flashes over the startup screen while the last session loads.
- Terminal: Switching projects or tabs keeps each terminal's output separate. Reopening or resizing the panel no longer leaves stray prompt fragments.
- Terminal: Exiting Node-based commands on macOS and Linux no longer prints an empty IPC-channel warning.
- Updates: Updating a desktop host from the browser uses its native updater, confirms the installed version, and reports restart failures with a retry option (thanks to @ChangeHow).
- Git: Switching to a token-based identity no longer fails with a credential-helper permission error (thanks to @ICEY16360).
- Usage: OpenRouter shows per-key spending and limits, or monthly spending for unlimited keys, fixing misleading zero balances (thanks to @leducmaxime).
- Usage: Ollama Cloud's dollar-based plans show monthly spending and extra credits, fixing missing usage and rejected credentials (thanks to @kydorn).
- Usage: NeuralWatt allowance rows show usage percentages and respond to the used/remaining toggle (thanks to @kydorn).
- Usage: Slow connections to providers such as z.ai no longer fail because the connection attempt ends too early (thanks to @ouyangjian28).
- Desktop/Linux: "Open in" no longer lists unrelated editors or launches the wrong app when an installed app has a non-Latin name (thanks to @ouyangjian28).
- Scrollbars: Hovering over a scrollable area reveals its scrollbar, including in Settings and dialogs, without shifting the content (thanks to @sergiofspedro).

### Misc

- Server: `OPENCHAMBER_DATA_DIR` also covers project settings, themes, speech models, and new managed chats. Existing managed chats stay in their current location.

## VS Code

### New

- Projects: Store worktree setup commands and draft starters in the repository from Project settings. Repository commands require trust before running and after changes.
- Usage: Charm Hyper shows your remaining Hypercredits and their dollar value (thanks to @airtaxi).
- Settings: "Always show scrollbars" keeps scrollbars visible when the pointer leaves a scrollable area.

### Improvements

- **Chat:** `/btw` now has a separate composer with its own draft, model, and effort. The "By the way…" text-selection action prefills a question with the selected passage (thanks to @ChangeHow).
- Settings: VS Code keeps its own appearance and chat layout preferences, separate from web, desktop, and mobile.
- Chat: Ctrl+N/P navigation works across model lists, menus, and autocomplete. The model picker reopens with your selected model in view (thanks to @ChangeHow).
- Settings/Chat: Send-shortcut and large-text paste options have clearer descriptions (thanks to @ChangeHow).
- Chat: More compact Markdown, stronger headings and contrast, and a divider before the final answer make replies easier to scan.
- Chat: Text selection and comment highlights use a consistent, readable accent tint across themes.

### Fixes

- Chat: Forking a user message fills the destination composer with its prompt and attachments while keeping the original session's draft intact (thanks to @karimodm).
- Chat: Tools interrupted before a reload no longer keep a running timer indefinitely (thanks to @alvins82).
- Chat: Images attached to a sent message appear only once.
- Chat: Resizing the chat keeps the latest reply in view when following the end. Sending no longer creates a large blank space below the message.
- Chat: Long Thinking output stays in a capped scroll box while streaming; scrolling upward pauses its automatic scrolling (thanks to @alvins82).
- Chat: Narrow tables keep their border and toolbar close to the columns (thanks to @ChangeHow).
- Usage: OpenRouter reports key spending and limits accurately, including monthly spending for unlimited keys (thanks to @leducmaxime).
- Usage: Ollama Cloud dollar-based plans show monthly spending and extra credits; credential checks reject unreadable usage pages (thanks to @kydorn).
- Usage: NeuralWatt shows allowance percentages correctly in both used and remaining modes (thanks to @kydorn).
- Usage: Provider requests have enough time to connect on slower networks, fixing premature "fetch failed" errors (thanks to @ouyangjian28).
- Scrollbars: Hover reveals scrollbars in chat, Settings, and shared dialogs without moving the content sideways (thanks to @sergiofspedro).
