# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

## [1.8.1] - 2026-02-28

- Web/Auth: fixed an issue where non-tunnel browser sessions could incorrectly show a tunnel-only lock screen; normal auth flow now appears unless a tunnel is actually active.


## [1.8.0] - 2026-02-28

- Desktop: added SSH remote instance support with dedicated lifecycle and UX flows, so you can work against remote machines more reliably (thanks to @shekohex).
- Projects: added project icon customization with upload/remove and automatic favicon discovery from your repository (thanks to @shekohex).
- Projects: added header project actions on Web and Mobile, so you can run and stop any configured project commands without leaving chat.
- Projects/Desktop: project actions can also open SSH-forwarded URLs, making remote dev-server workflows quicker from inside the app.
- Desktop: added dynamic window titles that reflect active project and remote context, so it is easier to track where you are working (thanks to @shekohex).
- Remote Tunnel: added tunnel settings with quick/named modes, secure one-time connect links (with QR), and saved named-tunnel presets/tokens so enabling remote access is easier and safer (thanks to @yulia-ivashko).
- UI: expanded sprite-based file and folder icons across Files, Diff, and Git views for faster visual scanning (thanks to @shekohex).
- UI: added an expandable project rail with project names, a settings toggle, and saved expansion state for easier navigation in multi-project setups (thanks to @nguyenngothuong).
- UI/Files: added file-type icons across file lists, tabs, and diffs, so you can identify files faster at a glance (thanks to @shekohex).
- Files: added a read-only highlighted view with a quick toggle back to edit mode, so you can quickly review code with richer syntax rendering if you don't need to edit thing (thanks to @shekohex).
- Files: markdown preview now handles frontmatter more cleanly, improving readability for docs-heavy repos (thanks to @shekohex).
- Chat: improved long-session performance with virtualized message rendering, smoother scrolling, and more stable behavior in large histories (thanks to @shekohex).
- Chat: enabled markdown rendering in user messages for clearer formatted prompts and notes (thanks to @haofeng0705).
- Chat: enabled bueatiful diffs for edit tools in chat making this aligned with dedicated diffs view style (thanks to @shekohex).
- Chat: pasted absolute paths are now treated as normal messages, reducing accidental command-like behavior when sharing paths.
- Chat: fixed queued sends for inactive sessions, reducing stuck queues.
- Chat: upgraded Mermaid rendering with a cleaner diagram view plus quick copy/download actions, making generated diagrams easier to read and share (thanks to @shekohex).
- Notifications: improved child-session notification detection to reduce missed or misclassified subtask updates (thanks to @Jovines).
- Deployment: added Docker deployment support with safer container defaults and terminal shell fallback, making self-hosted setups easier to run (thanks to @nzlov).
- Reliability: improved Windows compatibility across git status checks, OpenCode startup, path normalization, and session merge behavior (thanks to @mmereu).
- Usage: added MiniMax coding-plan quota provider support for broader usage tracking coverage (thanks to @nzlov).
- Usage: added Ollama Cloud quota provider support for broader usage tracking coverage (thanks to @iamhenry).


## [1.7.5] - 2026-02-25

- UI: moved projects into a dedicated sidebar rail and tightened the layout so switching projects and sessions feels faster.
- Chat: fixed an issue where messages could occasionally duplicate or disappear during active conversations.
- Sessions: reduced session-switching overhead to make chat context changes feel more immediate.
- Reliability/Auth: migrated session auth storage to signed JWTs with a persistent secret, reducing unexpected auth-state drift after reconnects or reloads (thanks to @Jovines).
- Mobile: pending permission prompts now recover after reconnect/resume instead of getting lost mid-run (thanks to @nelsonPires5).
- Mobile/Chat: refined message spacing and removed the top scroll shadow for a cleaner small-screen reading experience (thanks to @Jovines).
- Web: added `OPENCODE_HOST` support so you can connect directly to an external OpenCode server using a full base URL (thanks to @colinmollenhour).
- Web/Mobile: fixed in-app update flow in containerized setups so updates apply correctly.


## [1.7.4] - 2026-02-24

- Settings: redesigned the settings workspace with flatter, more consistent page layouts so configuration is faster to scan and edit.
- Settings: improved agents and skills navigation by grouping entries by subfolder for easier management at scale (thanks to @nguyenngothuong).
- Chat: improved streaming smoothness and stability with buffered updates and runtime fixes, reducing lag, stuck spinners, memory growth, and timeout-related interruptions in long runs (thanks to @nguyenngothuong).
- Chat: added fullscreen Mermaid preview, persisted default thinking variant selection, and hardened file-preview safety checks for a safer, more predictable message experience (thanks to @yulia-ivashko).
- Chat: draft text now persists per session, and the input supports an expanded focus mode for longer prompts (thanks to @nguyenngothuong).
- Sessions: expanded folder management with subfolders, cleaner organization actions, and clearer delete confirmations (thanks to @nguyenngothuong).
- Settings: added an MCP config manager UI to simplify editing and validating MCP server configuration (thanks to @nguyenngothuong).
- Git/PR: moved commit-message and PR-description generation to active-session structured output, so generation uses current session context and avoids fragile backend polling.
- Chat Activity: improved Structured Output tool rendering with dedicated title/icon, clearer result descriptions, and more reliable detailed expansion defaults.
- Notifications/Voice: moved utility model controls into AI Summarization as a Zen-only Summarization Model setting.
- Mobile: refreshed drawer and session-status layouts for better small-screen usability (thanks to @Jovines).
- Desktop: improved remote instance URL handling for more reliable host/query matching (thanks to @shekohex).
- Files: added C, C++, and Go language support for syntax-aware rendering in code-heavy workflows (thanks to @fomenks).


## [1.7.3] - 2026-02-21

- Settings: added customizable keyboard shortcuts for chat actions, panel toggles, and services, so you can better match OpenChamber to your workflow (thanks to @nelsonPires5).
- Sessions: added custom folders to group chat sessions, with move/rename/delete flows and persisted collapse state per project (thanks to @nguyenngothuong).
- Notifications: improved agent progress notifications and permission handling to reduce noisy prompts during active runs (thanks to @nguyenngothuong).
- Diff/Plans/Files: restored inline comments making more like a GitHub style again (thanks to @nelsonPires5).
- Terminal: restored terminal text copy behavior, so selecting and copying command output works reliably again (thanks to @shekohex).
- UI: unified clipboard copy behavior across Desktop app, Web app, and VS Code extension for more consistent copy actions and feedback.
- Reliability: improved startup environment detection by capturing login-shell environment snapshots, reducing missing PATH/tool issues on launch.
- Reliability: refactored OpenCode config/auth integration into domain modules for steadier provider auth and command loading flows (thanks to @nelsonPires5).


## [1.7.2] - 2026-02-20

- Chat: question prompts now guide you to unanswered items before submit, making tool-question flows faster.
- Chat: fixed auto-send queue to wait for the active session to be idle before sending, reducing misfires during agent messages.
- Chat: improved streaming activity rendering and session attention indicators, so active progress and unread signals stay more consistent.
- UI: added Plan view in the context sidebar panel for quicker access to plan content while you work (thanks to @nelsonPires5).
- Settings: model variant options now refresh correctly in draft/new-session flows, avoiding stale selections.
- Reliability: provider auth failures now show clearer re-auth guidance when tokens expire, making recovery faster (thanks to @yulia-ivashko).


## [1.7.1] - 2026-02-18

- Chat: slash commands now follow server command semantics (including multiline arguments), so command behavior is more consistent with OpenCode CLI.
- Chat: added a shell mode triggered by leading `!`, with inline output visibility/copy.
- Chat: improved delegated-task clarity with richer subtask bubbles, better task-detail rendering, and parent-chat surfacing for child permission/question requests.
- Chat: improved `@` mention autocomplete by prioritizing agents and cleaning up ordering for faster picks.
- Skills: discovery now uses OpenCode API as the source of truth with safer fallback scanning, improving installed-state accuracy.
- Skills: upgraded editing/install UX with better code editing, syntax-aware related files, and clearer location targeting across user/project .opencode and .agents scopes.
- Mobile: fixed accidental abort right after tapping Send on touch devices, reducing interrupted responses (thanks to @shekohex).
- Maintenance: removed deprecated GitHub Actions cloud runtime assets and docs to reduce setup confusion (thanks to @yulia-ivashko).


## [1.7.0] - 2026-02-17

- Chat: improved live streaming with part-delta updates and smarter auto-follow scrolling, so long responses stay readable while they generate.
- Chat: Mermaid diagrams now render inline in assistant messages, with quick copy/download actions for easier sharing.
- UI: added a context overview panel with token usage, cost breakdown, and raw message inspection to make session debugging easier.
- Sessions: project icon and color customizations now persist reliably across restarts.
**- Reliability: managed local OpenCode runtimes now use rotated secure auth and tighter lifecycle control across runtimes, reducing stale-process and reconnect issues (thanks to @yulia-ivashko).**
- Git/GitHub: improved backend reliability for repository and auth operations, helping branch and PR flows stay more predictable (thanks to @nelsonPires5).


## [1.6.9] - 2026-02-16

- **UI: redesigned the workspace shell with a context panel, tabbed sidebars, and quicker navigation across chat, files, and reviews, so daily workflows feel more focused.**
- UI: compact model info in selection (price + capabilities), making model selection faster and more cost-aware (thanks to @nelsonPires5).
- Chat: fixed files attachment issue and added displaying of excided quota information.
- Diff: improved large diff rendering and interaction performance for smoother reviews on heavy changesets.
- Worktrees: shipped an upstream-first flow across supported runtimes, making branch tracking and worktree session setup more predictable (thanks to @yulia-ivashko).
- Git: improved pull request branch normalization and base/remote resolution to reduce PR setup mismatches (thanks to @gsxdsm).
- Sessions: added a persistent project notes and todos panel, so key context and follow-ups stay attached to each project (thanks to @gsxdsm).
- Sessions: introduced the ability to pin sessions within your groups for easy access.
- Settings: added a configurable Zen model for commit messages generation and summarization of notifications (thanks to @gsxdsm).
- Usage: added NanoGPT quota support and hardened provider handling for more reliable usage tracking (thanks to @nelsonPires5).
- Reliability: startup now auto-detects and safely connects to an existing OpenCode server, reducing duplicate-server conflicts (thanks to @ruslan-kurchenko).
- Desktop: improved day-to-day polish with restored desktop window geometry and posiotion (thanks to @yulia-ivashko).
- Mobile: fixes for small-screen editor, terminal, and layout overlap issues (thanks to @gsxdsm, @nelsonPires5).


## [1.6.8] - 2026-02-12

- Chat: added drag-and-drop attachments with inline image previews, so sharing screenshots and files in prompts feels much faster and more reliable.
- Sessions: fixed a sidebar issue where draft input could carry over when switching projects, so each workspace keeps cleaner chat context.
- Chat: improved quick navigation from the sessions list by adding double-click to jump into chat and auto-focus the draft input; also fixed mobile session return behavior (thanks to @gsxdsm).
- Chat: improved agent/model picking with fuzzy search across names and descriptions, making long lists easier to filter.
- Usage: corrected Gemini and Antigravity quota source mapping and labels for more accurate usage tracking (thanks to @gsxdsm).
- Usage: when using remaining-quota mode, usage markers now invert direction to better match how remaining capacity is interpreted (thanks to @gsxdsm).
- Desktop: fixed project selection in opened remote instances.
- Desktop: fixed opened remote instances that use HTTP (helpful for instances under tunneling).


## [1.6.7] - 2026-02-10

- Voice: added built-in voice input and read-aloud responses with multiple providers, so you can drive chats hands-free when typing is slower (thanks to @gsxdsm).
- Git: added multi-remote push selection and smarter fork-aware pull request creation to reduce manual branch/remote setup (thanks to @gsxdsm).
- Usage: added usage pace and prediction indicators in the header and settings, so it is easier to see how quickly quota is moving (thanks to @gsxdsm).
- Diff/Plans: fixed comment draft collisions and improved multi-line comment editing in plan and file workflows, so feedback is less likely to get lost (thanks to @nelsonPires5).
- Notifications: stopped firing completion notifications for comment draft edits to reduce noisy alerts during review-heavy sessions (thanks to @nelsonPires5).
- Settings: added confirmation dialogs for destructive delete/reset actions to prevent accidental data loss.
- UI: refreshed header and settings layout, improved host switching, and upgraded the editor for smoother day-to-day navigation and editing.
- Desktop: added multi-window support with a dedicated "New Window" action for parallel work across projects (thanks to @yulia-ivashko).
- Reliability: fixed message loading edge cases, stabilized voice-mode persistence across restarts, and improved update flow behavior across platforms.

## [1.6.6] - 2026-02-9

- Desktop: redesigned the main workspace with a dedicated Git sidebar and bottom terminal dock, so Git and terminal actions stay in reach while chatting.
- Desktop: added an `Open In` button to open the current workspace in Finder, Terminal, and supported editors with remembered app preference (thanks to @yulia-ivashko).
- Header: combined Instance, Usage, and MCP into one services menu for faster access to runtime controls and rate limits while decluttering the header space.
- Git: added push/pull with remote selection, plus in-app rebase/merge flows with improved remote inference and clearer conflict handling (thanks to @gsxdsm).
- Git: reorganized the Git workspace with improved in-app PR workflows.
- Files: improved editing with breadcrumbs, better draft handling, smoother editor interactions, and more reliable directory navigation from file context (thanks to @nelsonPires5).
- Sessions: improved status behavior, faster mobile session switching with running/unread indicators, and clearer worktree labels when branch name differs (thanks to @Jovines, @gsxdsm).
- Notifications: added smarter templates with concise summaries, so completion alerts are easier to scan (thanks to @gsxdsm).
- Usage: added per-model quota breakdowns with collapsible groups, and fixed provider dropdown scrolling (thanks to @nelsonPires5, @gsxdsm).
- Terminal: improved input responsiveness with a persistent low-latency transport for steadier typing (thanks to @shekohex).
- Mobile: fixed chat input layout issues on small screens (thanks to @nelsonPires5).
- Reliability: fixed OpenCode auth pass-through and proxy env handling to reduce intermittent connection/auth issues (thanks to @gsxdsm).


## [1.6.5] - 2026-02-6

- Settings: added an OpenCode CLI path override so you can point OpenChamber at a custom/local CLI install.
- Chat: added arrow-key prompt history and an optional setting to persist input drafts between restarts (thanks to @gsxdsm).
- Chat: thinking/reasoning blocks now render more consistently, and justification visibility settings now apply reliably (thanks to @gsxdsm).
- Diff/Plans: added inline comment drafts so you can leave line-level notes and feed them back into requests (thanks to @nelsonPires5).
- Sessions: you can now rename projects directly from the sidebar, and issue/PR pickers are easier to scan when starting from GitHub context (thanks to @shekohex, @gsxdsm).
- Worktrees: improved worktree flow reliability, including cleaner handling when a worktree was already removed outside the app (thanks to @gsxdsm).
- Terminal: improved Android keyboard behavior and removed distracting native caret blink in terminal inputs (thanks to @shekohex).
- UI: added Vitesse Dark and Vitesse Light theme presets.
- Reliability: improved OpenCode binary resolution and HOME-path handling across runtimes for steadier local startup.


## [1.6.4] - 2026-02-5

- Desktop: switch between local and remote OpenChamber instances, plus a thinner runtime for better feature parity and fewer desktop-only quirks.
- VSCode: improved Windows PATH resolution and cold-start readiness checks to reduce "stuck loading" for sessions/models/agents.
- Mobile: split Agent/Model controls and a quick commands button with autocomplete (Commands/Agents/Files) for easier input (thanks to @Jovines, @gsxdsm).
- Chat: select text in messages to quickly add it to your prompt or start a new session (thanks to @gsxdsm).
- Diff/Plans: add inline comment drafts so you can annotate specific lines and include those notes in requests (thanks to @nelsonPires5).
- Terminal/Syntax: font size controls and Phoenix file extension support for better highlighting in files and diffs (thanks to @shekohex).
- Usage: expanded quota tracking with more providers (including GitHub Copilot) and a provider selector dropdown (thanks to @gsxdsm, @nelsonPires5).
- Git: improved macOS SSH agent support for smoother private-repo auth (thanks to @shekohex).
- Web: fixed missing icon when installing the Android PWA (thanks to @nelsonPires5).
- GitHub: PR description generation supports optional extra context for better summaries (thanks to @nelsonPires5).


## [1.6.3] - 2026-02-2

- Web: improved server readiness check to use the `/global/health` endpoint for more reliable startup detection.
- Web: added login rate limit protection to prevent brute-force attempts on the authentication endpoint (thanks to @Jovines).
- VSCode: improved server health check with the proper health API endpoint and increased timeout for steadier startup (thanks to @wienans).
- Settings: dialog no longer persists open/closed state across app restarts.


## [1.6.2] - 2026-02-1

- Usage: new multi-provider quota dashboard to monitor API usage across OpenAI, Google, and z.ai (thanks to @nelsonPires5).
- Settings: now opens in a windowed dialog on desktop with backdrop blur for better focus.
- Terminal: added tabbed interface to manage multiple terminal sessions per directory.
- Files: added multi-file tabs on desktop and dropdown selector on mobile (thanks to @nelsonPires5).
- UI: introduced token-based theming system and 18 themes with light/dark variants; with support for custom user themes from `~/.config/openchamber/themes`.
- Diff: optimized stacked view with worker-pool processing and lazy DOM rendering for smoother scrolling.
- Worktrees: workspace path now resolves correctly when using git worktrees (thanks to @nelsonPires5).
- Projects: fixed directory creation outside workspace in the Add Project modal (thanks to @nelsonPires5).


## [1.6.1] - 2026-01-30

- Chat: added Stop button to cancel generation mid-response.
- Mobile: revamped chat controls on small screens with a unified controls drawer (thanks to @nelsonPires5).
- UI: update dialog now includes the changelog so you can review what's new before updating.
- Terminal: added optional on-screen key bar (Esc/Ctrl/arrows/Enter) for easier terminal navigation.
- Notifications: added "Notify for subtasks" toggle to silence child-session notifications during multi-run (thanks to @Jovines).
- Reliability: improved event-stream reconnection when the app becomes visible again.
- Worktrees: starting new worktree sessions now defaults to HEAD when no start point is provided.
- Git: commit message generation now includes untracked files and handles git diff --no-index comparisons more reliably (thanks to @MrLYC).
- Desktop: improved macOS window chrome and header spacing, including steadier traffic lights on older macOS versions (thanks to @yulia-ivashko).


## [1.6.0] - 2026-01-29

- Chat: added message stall detection with automatic soft resync for more reliable message delivery.
- Chat: fixed "Load older" button behavior in chat with proper pagination implementation.
- Git: PR picker now validates local branch existence and includes a refresh action.
- Git: worktree integration now syncs clean target directories before merging.
- Diff: fixed memory leak when viewing many modified files; large changesets now lazy-load for smoother performance.
- VSCode: session activity status now updates reliably even when the webview is hidden.
- Web: session activity tracking now works consistently across browser tabs.
- Reliability: plans directory no longer errors when missing.


## [1.5.9] - 2026-01-28

- Worktrees: migrated to Opencode SDK worktree implementation; sessions in worktrees are now completely isolated.
- Git: integrate worktree commits back to a target branch with commit previews and guided conflict handling.
- Files: toggle markdown preview when viewing files (thanks to @Jovines).
- Files: open the file viewer in fullscreen for focused review and editing (thanks to @TaylorBeeston).
- Plans: switch between markdown preview and edit mode in the Plan view.
- UI: Files, Diff, Git, and Terminal now follow the active session/worktree directory, including new-session drafts.
- Web: plan lists no longer error when the plans directory is missing.


## [1.5.8] - 2026-01-26

- Plans: new Plan/Build mode switching support with dedicated Plan content view with per-session context.
- GitHub: sign in with multiple accounts and smoother auth flow.
- Chat/UI: linkable mentions, better wrapping, and markdown/scroll polish in messages.
- Skills: ClawdHub catalog now pages results and retries transient failures.
- Diff: fixed Chrome scrolling in All Files layout.
- Mobile: improved layout for attachments, git, and permissions on small screens (thanks to @nelsonPires5).
- Web: iOS safe-area support for the PWA header.
- Activity: added a text-justification setting for activity summaries (thanks to @iyangdianfeng).
- Reliability: file lists and message sends handle missing directories and transient errors more gracefully.


## [1.5.7] - 2026-01-24

- GitHub: PR panel supports fork PR detection by branch name.
- GitHub: Git tab PR panel can send failed checks/comments to chat with hidden context; added check details dialog with Actions step breakdown.
- Web: GitHub auth flow fixes.


## [1.5.6] - 2026-01-24

- GitHub: connect your account in Settings with device-flow auth to enable GitHub tools.
- Sessions: start new sessions from GitHub issues with seeded context (title, body, labels, comments).
- Sessions: start new sessions from GitHub pull requests with PR context baked in (including diffs).
- Git: manage pull requests in the Git view with AI-generated descriptions, status checks, ready-for-review, and merge actions.
- Mobile: fixed CommandAutocomplete dropdown scrolling (thanks to @nelsonPires5).


## [1.5.5] - 2026-01-23

- Navigation: URLs now sync the active session, tab, settings, and diff state for shareable links and reliable back/forward (thanks to @TaylorBeeston).
- Settings: agent and command overrides now prefer plural directories while still honoring legacy singular folders.
- Skills: installs now target plural directories while still recognizing legacy singular folders.
- Web: push notifications no longer fire when a window is visible, avoiding duplicate alerts.
- Web: improved push subscription handling across multiple windows for more reliable delivery.


## [1.5.4] - 2026-01-22

- Chat: new Apply Patch tool UI with diff preview for patch-based edits.
- Files: refreshed attachment cards and related file views for clearer context.
- Settings: manage provider configuration files directly from the UI.
- UI: updated header and sidebar layout for a cleaner, tighter workspace fit (thanks to @TheRealAshik).
- Diff: large diffs now lazy-load to avoid freezes (thanks to @Jovines).
- Web: added Background notifications for PWA.
- Reliability: connect to external OpenCode servers without auto-start and fixed subagent crashes (thanks to @TaylorBeeston).


## [1.5.3] - 2026-01-20

- Files: edit files inline with syntax highlighting, draft protection, and save/discard flow.
- Files: toggles to show hidden/dotfiles and gitignored entries in file browsers and pickers (thanks to @syntext).
- Settings: new memory limits controls for session message history.
- Chat: smoother session switching with more stable scroll anchoring.
- Chat: new Activity view in collapsed state, now shows latest 6 tools by default.
- Chat: fixed message copy on Firefox for macOS (thanks to @syntext).
- Appearance: new corner radius control and restored input bar offset setting (thanks to @TheRealAshik).
- Git: generated commit messages now auto-pick a gitmoji when enabled (thanks to @TheRealAshik).
- Performance: faster filesystem/search operations and general stability improvements (thanks to @TheRealAshik).


## [1.5.2] - 2026-01-17

- Sessions: added branch picker dialog to start new worktree sessions from local branches (thanks to @nilskroe).
- Sessions: added project header worktree button, active-session loader, and right-click context menu in the sessions sidebar (thanks to @nilskroe).
- Sessions: improved worktree delete dialog with linked session details, dirty-change warnings, and optional remote branch removal.
- Git: added gitmoji picker in commit message composer with cached emoji list (thanks to @TaylorBeeston).
- Chat: optimized message loading for opening sessions.
- UI: added one-click diagnostics copy in the About dialog.
- VSCode: tuned layout breakpoint and server readiness timeout for steadier startup.
- Reliability: improved OpenCode process cleanup to reduce orphaned servers.


## [1.5.1] - 2026-01-16

- Desktop: fixed orphaned OpenCode processes not being cleaned up on restart or exit.
- Opencode: fixed issue with reloading configuration was killing the app


## [1.5.0] - 2026-01-16

- UI: added a new Files tab to browse workspace files directly from the interface.
- Diff: enhanced the diff viewer with mobile support and the ability to ask the agent for comments on changes.
- Git Identities: added "default identity" setting with one-click set/unset and automatic local identity detection.
- VSCode: improved server management to ensure it initializes within the workspace directory with context-aware readiness checks.
- VSCode: added responsive layout with sessions sidebar + chat side-by-side when wide, compact header, and streamlined settings.
- Web/VSCode: fixed orphaned OpenCode processes not being cleaned up on restart or exit.
- Web: the server now automatically resolves and uses an available port if the default is occupied.
- Stability: fixed heartbeat race condition causing session stalls during long tasks (thanks to @tybradle).
- Desktop: fixed commands for worktree setup access to PATH.


## [1.4.9] - 2026-01-14

- VSCode: added session editor panel to view sessions alongside files.
- VSCode: improved server connection reliability with multiple URL candidate support.
- Diff: added stacked/inline diff mode toggle in settings with sidebar file navigation (thanks to @nelsonPires5).
- Mobile: fixed iOS keyboard safe area padding for home indicator bar (thanks to @Jovines).
- Upload: increased attachment size limit to 50MB with automatic image compression to 2048px for large files.


## [1.4.8] - 2026-01-14

- Git Identities: added token-based authentication support with ~/.git-credentials discovery and import.
- Settings: consolidated Git settings and added opencode zen model selection for commit generation (thanks to @nelsonPires5).
- Web Notifications: added configurable native web notifications for assistant completion (thanks to @vio1ator).
- Chat: sidebar sessions are now automatically sorted by last updated date (thanks to @vio1ator).
- Chat: fixed edit tool output and added turn duration.
- UI: todo lists and status indicators now hide automatically when all tasks are completed (thanks to @vio1ator).
- Reliability: improved project state preservation on validation failures (thanks to @vio1ator) and refined server health monitoring.
- Stability: added graceful shutdown handling for the server process (thanks to @vio1ator).


## [1.4.7] - 2026-01-10

- Skills: added ClawdHub integration as built-in market for skills.
- Web: fixed issues in terminal


## [1.4.6] - 2026-01-09

- VSCode/Web: switch opencode cli management to SDK.
- Input: removed auto-complete and auto-correction.
- Shortcuts: switched agent cycling shortcut from Shift + TAB to TAB again.
- Chat: added question tool support with a rich UI for interaction.


## [1.4.5] - 2026-01-08

- Chat: added support for model variants (thinking effort).
- Shortcuts: Switched agent cycling shortcut from TAB to Shift + TAB.
- Skills: added autocomplete for skills on "/" when it is not the first character in input.
- Autocomplete: added scope badges for commands/agents/skills.
- Compact: changed /summarize command to be /compact and use sdk for compaction.
- MCP: added ability to dynamically enabled/disabled configured MCP.
- Web: refactored project adding UI with autocomplete.


## [1.4.4] - 2026-01-08

- Agent Manager / Multi Run: select agent per worktree session (thanks to @wienans).
- Agent Manager / Multi Run: worktree actions to delete group or individual worktrees, or keep only selected one (thanks to @wienans).
- Agent Manager: added "Copy Worktree Path" action in the more menu (thanks to @wienans).
- Worktrees: added session creation flow with loading screen, auto-create worktree setting, and setup commands management.
- Session sidebar: refactoring with unified view for sessions in worktrees.
- Settings: added ability to create new session in worktree by default
- Git view: added branch rename for worktree.
- Chat: fixed IME composition for CJK input to prevent accidental send (thanks to @madebyjun).
- Projects: added multi-project support with per-project settings for agents/commands/skills.
- Event stream: improved SSE with heartbeat management, permission bootstrap on connect, and reconnection logic.
- Tunnel: added QR code and password URL for Cloudflare tunnel (thanks to @martindonadieu).
- Model selector: fixed dropdowns not responding to viewport size.


## [1.4.3] - 2026-01-04

- VS Code extension: added Agent Manager panel to run the same prompt across up to 5 models in parallel (thanks to @wienans).
- Added permission prompt UI for tools configured with "ask" in opencode.json, showing requested patterns and "Always Allow" options (thanks to @aptdnfapt).
- Added "Open subAgent session" button on task tool outputs to quickly navigate to child sessions (thanks to @aptdnfapt).
- VS Code extension: improved activation reliability and error handling.


## [1.4.2] - 2026-01-02

- Added timeline dialog (`/timeline` command or Cmd/Ctrl+T) for navigating, reverting, and forking from any point in the conversation (thanks to @aptdnfapt).
- Added `/undo` and `/redo` commands for reverting and restoring messages in a session (thanks to @aptdnfapt).
- Added fork button on user messages to create a new session from any point (thanks to @aptdnfapt).
- Desktop app: keyboard shortcuts now use Cmd on macOS and Ctrl on web/other platforms (thanks to @sakhnyuk).
- Migrated to OpenCode SDK v2 with improved API types and streaming.


## [1.4.1] - 2026-01-02

- Added the ability to select the same model multiple times in multi-agent runs for response comparison.
- Model selector now includes search and keyboard navigation for faster model selection.
- Added revert button to all user messages (including first one).
- Added HEIC image support for file attachments with automatic MIME type normalization for text format files.
- VS Code extension: added git backend integration for UI to access (thanks to @wienans).
- VS Code extension: Only show the main Worktree in the Chat Sidebar (thanks to @wienans).
- Web app: terminal backend now supports a faster Bun-based PTY when Bun is available, with automatic fallback for existing Node-only setups.
- Terminal: improved terminal performance and stability by switching to the Ghostty-based terminal renderer, while keeping the existing terminal UX and per-directory sessions.
- Terminal: fixed several issues with terminal session restore and rendering under heavy output, including switching directories and long-running TUI apps.


## [1.4.0] - 2026-01-01

- Added the ability to run multiple agents from a single prompt, with each agent working in an isolated worktree.
- Git view: improved branch publishing by detecting unpublished commits and automatically setting the upstream on first push.
- Worktrees: new branch creation can start from a chosen base; remote branches are only created when you push.
- VS Code extension: default location is now the right secondary sidebar in VS Code, and the left activity bar in Cursor/Windsurf; navigation moved into the title bar (thanks to @wienans).
- Web app: added Cloudflare Quick Tunnel support for simpler remote access (thanks to @wojons and @aptdnfapt).
- Mobile: improved keyboard/input bar behavior (including Android fixes and better keyboard avoidance) and added an offset setting for curved-screen devices (thanks to @auroraflux).
- Chat: now shows clearer error messages when agent messages fail.
- Sidebar: improved readability for sticky headers with a dynamic background.


## [1.3.9] - 2025-12-30

 - Added skills management to settings with the ability to create, edit, and delete skills (make sure you have the latest OpenCode version for skills support).
- Added Skills catalog functionality for discovering and installing skills from external sources.
- VS Code extension: added right-click context menu with "Add to Context," "Explain," and "Improve Code" actions (thanks to @wienans).


## [1.3.8] - 2025-12-29

- Added Intel Mac (x86_64) support for the desktop application (thanks to @rothnic).
- Build workflow now generates separate builds for Apple Silicon (arm64) and Intel (x86_64) Macs (thanks to @rothnic).
- Improved dev server HMR by reusing a healthy OpenCode process to avoid zombie instances.
- Added queued message mode with chips, batching, and idle auto‑send (including attachments).
- Added queue mode toggle to OpenChamber settings (chat section) with persistence across runtimes.
- Fixed scroll position persistence for active conversation turns across session switches.
- Refactored Agents/Commands management with ability to configure project/user scopes.


## [1.3.7] - 2025-12-28

- Redesigned Settings as a full-screen view with tabbed navigation.
- Added mobile-friendly drill-down navigation for settings.
- ESC key now closes settings; double-ESC abort only works on chat tab without overlays.
- Added responsive tab labels in settings header (icons only at narrow widths).
- Improved session activity status handling and message step completion logic.
- Introduced enchanced VSCode extension settings with dynamic layout based on width.


## [1.3.6] - 2025-12-27

- Added the ability to manage (connect/disconnect) providers in settings.
- Adjusted auto-summarization visuals in chat.


## [1.3.5] - 2025-12-26

- Added Nushell support for operations with Opencode CLI.
- Improved file search with fuzzy matching capabilities.
- Enhanced mobile responsiveness in chat controls.
- Fixed workspace switching performance and API health checks.
- Improved provider loading reliability during workspace switching.
- Fixed session handling for non-existent worktree directories.
- Added Discord links in the about section.
- Added settings for choosing the default model/agent to start with in a new session.


## [1.3.4] - 2025-12-25

- Diff view now loads reliably even with large files and slow networks.
- Fixed getting diffs for worktree files.
- VS Code extension: improved type checking and editor integration.


## [1.3.3] - 2025-12-25

- Updated OpenCode SDK to 1.0.185 across all app versions.
- VS Code extension: fixed startup, more reliable OpenCode CLI/API management, and stabilized API proxying/streaming.
- VS Code extension: added an animated loading screen and introduced command for status/debug output.
- Fixed session activity tracking so it correctly handles transitions through states (including worktree sessions).
- Fixed directory path handling (including `~` expansion) to prevent invalid paths and related Git/worktree errors.
- Chat UI: improved turn grouping/activity rendering and fixed message metadata/agent selection propagation.
- Chat UI: improved agent activity status behavior and reduced image thumbnail sizes for better readability.


## [1.3.2] - 2025-12-22

- Fixed new bug session when switching directories
- Updated Opencode SDK to the latest version


## [1.3.1] - 2025-12-22

- New chats no longer create a session until you send your first message.
- The app opens to a new chat by default.
- Fixed mobile and VSCode sessions handling
- Updated app identity with new logo and icons across all platforms.


## [1.3.0] - 2025-12-21

- Added revert functionality in chat for user messages.
- Polished mobile controls in chat view.
- Updated user message layout/styling.
- Improved header tab responsiveness.
- Fixed bugs with new session creation when the VSCode extension initialized for the first time.
- Adjusted VSCode extension theme mapping and model selection view.
- Polished file autocomplete experience.


## [1.2.9] - 2025-12-20

- Session auto‑cleanup feature with configurable retention for each app version including VSCode extension.
- Ability to update web package from mobile/PWA view in setting.
- A lot of different optimization for a long sessions.


## [1.2.8] - 2025-12-19

- Introduced update mechanism for web version that doesn't need any cli interaction.
- Added installation script for web version with package managed detection.
- Update and restart of web server now support automatic pick-up of previously set parameters like port or password.


## [1.2.7] - 2025-12-19

- Comprehensive macOS native menu bar entries.
- Redesigned directory selection view for web/mobile with improved layout.
- Improved theme consistency across dropdown menus, selects, and command palette.
- Introduced keyboard shortcuts help menu and quick actions menu.


## [1.2.6] - 2025-12-19

- Added write/create tool preview in permission cards with syntax highlighting.
- More descriptive assistant status messages with tool-specific and varied idle phrases.
- Polished Git view layout


## [1.2.5] - 2025-12-19

- Polished chat expirience for longer session.
- Fixed file link from git view to diff.
- Enhancements to the inactive state management of the desktop app.
- Redesigned Git tab layout with improved organization.
- Fixed untracked files in new directories not showing individually.
- Smoother session rename experience.


## [1.2.4] - 2025-12-18

- MacOS app menu entries for Check for update and for creating bug/request in Help section.
- For Mobile added settings, improved terminal scrolling, fixed app layout positioning.


## [1.2.3] - 2025-12-17

- Added image preview support in Diff tab (shows original/modified images instead of base64 code).
- Improved diff view visuals and alligned style among different widgets.
- Optimized git polling and background diff+syntax pre-warm for instant Diff tab open.
- Optomized reloading unaffected diffs.


## [1.2.2] - 2025-12-17

- Agent Task tool now renders progressively with live duration and completed sub-tools summary.
- Unified markdown rendering between assistant messages and tool outputs.
- Reduced markdown header sizes for better visual balance.


## [1.2.1] - 2025-12-16

- Todo task tracking: collapsible status row showing AI's current task and progress.
- Switched "Detailed" tool output mode to only open the 'task', 'edit', 'multiedit', 'write', 'bash' tools for better performance.


## [1.2.0] - 2025-12-15

- Favorite & recent models for quick access in model selection.
- Tool call expansion settings: collapsed, activity, or detailed modes.
- Font size & spacing controls (50-200% scaling) in Appearance Settings.
- Settings page access within VSCode extension.
Thanks to @theblazehen for contributing these features!


## [1.1.6] - 2025-12-15

- Optimized diff view layout with smaller fonts and compact hunk separators.
- Improved mobile experience: simplified header, better diff file selector.
- Redesigned password-protected session unlock screen.


## [1.1.5] - 2025-12-15

- Enhanced file attachment features performance.
- Added fuzzy search feature for file mentioning with @ in chat.
- Optimized input area layout.


## [1.1.4] - 2025-12-15

- Flexoki themes for Shiki syntax highlighting for consistency with the app color schema.
- Enchanced VSCode extension theming with editor themes.
- Fixed mobile view model/agent selection.


## [1.1.3] - 2025-12-14

- Replaced Monaco diff editor with Pierre/diffs for better performance.
- Added line wrap toggle in diff view with dynamic layout switching (auto-inline when narrow).


## [1.1.2] - 2025-12-13

- Moved VS Code extension to activity bar (left sidebar).
- Added feedback messages for "Restart API Connection" command.
- Removed redundant VS Code commands.
- Enhanced UserTextPart styling.


## [1.1.1] - 2025-12-13

- Adjusted model/agent selection alignment.
- Fixed user message rendering issues.


## [1.1.0] - 2025-12-13

- Added assistant answer fork flow so users can start a new session from an assistant plan/response with inherited context.
- Added OpenChamber VS Code extension with editor integration: file picker, click-to-open in tool parts.
- Improved scroll performance with force flag and RAF placeholder.
- Added git polling backoff optimization.


## [1.0.9] - 2025-12-08

- Added directory picker on first launch to reduce macOS permission prompts.
- Show changelog in update dialog from current to new version.
- Improved update dialog UI with inline version display.
- Added macOS folder access usage descriptions.


## [1.0.8] - 2025-12-08

- Added fallback detection for OpenCode CLI in ~/.opencode/bin.
- Added window focus after app restart/update.
- Adapted traffic lights position and corner radius for older macOS versions.


## [1.0.7] - 2025-12-08

- Optimized Opencode binary detection.
- Adjusted app update experience.


## [1.0.6] - 2025-12-08

- Enhance shell environment detection.


## [1.0.5] - 2025-12-07

- Fixed "Load older messages" incorrectly scrolling to bottom.
- Fixed page refresh getting stuck on splash screen.
- Disabled devtools and page refresh in production builds.


## [1.0.4] - 2025-12-07

- Optimized desktop app start time


## [1.0.3] - 2025-12-07

- Updated onboarding UI.
- Updated sidebar styles.


## [1.0.2] - 2025-12-07

- Updated MacOS window design to the latest one.


## [1.0.1] - 2025-12-07

- Initial public release of OpenChamber web and desktop packages in a unified monorepo.
- Added GitHub Actions release pipeline with macOS signing/notarization, npm publish, and release asset uploads.
- Introduced OpenCode agent chat experience with section-based navigation, theming, and session persistence.
