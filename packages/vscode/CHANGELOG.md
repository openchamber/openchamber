## [1.11.0] - 2026-05-14

- Chat/Permissions: restored `@agent` mentions in sent messages and parent-session auto-accept for child-session permissions, reducing missed routing and approval friction in delegated work.
- Chat/Input: queued messages now auto-send one at a time in FIFO order, and model/agent selections persist across reloads so draft context is less likely to reset unexpectedly (thanks to @lyxxx708, @chutastic).
- Chat/Performance: virtualized more timeline content, deferred heavy tool output, and improved scroll-to-bottom behavior so long sessions stay smoother.
- Editor Integration: chat commands now wait for the sidebar webview before sending selections, file mentions, explain prompts, or improve prompts, reducing dropped context when the panel is still opening.
- Editor Integration: active-editor context updates now ignore stale broadcasts, keeping chat context aligned with the file you are actually viewing (thanks to @isanchez404).
- Reliability/Streaming: extension SSE reconnect delays now abort cleanly and disposed chat webviews clean up their live streams, reducing stuck reconnects and leaked activity after panels close (thanks to @isanchez404).
- Agent Manager: settings changes now sync into Agent Manager views immediately, keeping extension panels consistent after configuration updates (thanks to @isanchez404).
- Sessions: archived-session bulk delete now works more reliably from the extension sidebar (thanks to @jjdubski).
- UI/Reliability: added smaller fixes for chunk-load recovery, locale retry behavior, stale attachment reads, and accessible session controls (thanks to @isanchez404).

## [1.10.4] - 2026-05-09

- Chat/Input: collapsed model, variant, and agent labels more gracefully on narrow widths, keeping prompt controls usable in compact editor panels.
- Git/Worktrees: pull-request worktrees can now reuse an existing local branch when it matches the PR head, reducing blocked setup flows.
- Git: deduplicated lightweight and full status refreshes separately, preventing stale or mismatched Git updates during background polling (thanks to @isanchez404).
- Reliability/Sync: preserved message part update ordering so live chat output stays consistent during rapid streaming updates (thanks to @isanchez404).

## [1.10.3] - 2026-05-08

- Chat/Scrolling: rebuilt auto-follow behavior so active responses stay pinned when you want them to, while wheel, touch, keyboard, scrollbar, and find-in-page interactions more reliably release control when you scroll away.
- Chat/Scrolling: restored saved scroll positions more consistently after session switches, hydration, and draft-to-session transitions, reducing jumps to the wrong part of a conversation.
- Chat/UI: tightened scroll-to-bottom behavior so the button appears only after you move past the visible bottom spacer, and code-block scrolling no longer prevents the main chat from releasing auto-follow when the nested block cannot scroll further.
- Chat/Input: fixed attachment-only queued sends, stale attachment restores, stale file-search results, autocomplete tab handling, and focusable removal controls so drafting stays reliable across queued, linked, and restored messages (thanks to @isanchez404).
- Reliability/Sync: reduced stale and duplicate live-state updates across request arrays, retry metadata, streaming indicators, and session status events, cutting unnecessary rerenders and stuck activity states during long-running chats (thanks to @isanchez404).
- Skills/Reliability: ignored outdated skills catalog and repo scans, keeping skills setup from showing results from an older request (thanks to @isanchez404).
- Chat/Reliability: added smaller polish fixes for text-selection cleanup (thanks to @isanchez404).

## [1.10.2] - 2026-05-07

- Chat/Reliability: stabilized live turn rendering and session sync caches, reducing flicker, stale state, and missing updates during reconnects or long-running chats.
- Terminal: improved Android tablet keyboard handling, including control-key shortcuts, and kept app shortcuts from stealing focus while typing in the terminal (thanks to @Dav1dch).
- Terminal: set a UTF-8 locale for terminal sessions so Unicode output renders more reliably across shells and commands (thanks to @liyiopener).
- Usage: OpenRouter credit balances now avoid misleading percentage displays and use clearer labels across usage views (thanks to @zerone0x).
- Reliability: split the extension into a dedicated app root, improving startup boundaries and reducing cross-runtime UI assumptions.

## [1.10.1] - 2026-05-06

- UI/Localization: added Polish interface translations, expanding language support for Polish-speaking users (thanks to @levy52).
- Sessions: added a quick archive action directly on session rows, making cleanup faster from the session list (thanks to @zoubenr).
- Chat/Timeline: added full-text timeline search across user, assistant, and tool messages in a session, making it easier to jump back to earlier context (thanks to @jwcrystal).
- Chat/Reliability: pending questions now survive session switches and directory eviction, reducing lost approval or clarification prompts during longer multi-session work (thanks to @ablepharus).
- Reliability/Sync: aligned session status parsing and reconnect reconciliation so activity state recovers more accurately after extension reconnects (thanks to @vhqtvn).
- Startup/Reliability: configured OpenCode CLI paths are now validated before managed startup, with clearer errors for missing, non-executable, or app-bundle paths.
- Performance/Reliability: reduced duplicate extension initialization, deferred heavier views until needed, lowered managed runtime status overhead, optimized markdown file-link detection, reduced sync recovery payloads, and suppressed expected missing-directory noise for smoother day-to-day use.

## [1.10.0] - 2026-05-05

- Chat/UI: added the currently open editor file to chat context, making it faster to ask about the file you are already editing (thanks to @daveotero).
- Settings/Behavior: added a dedicated Behavior page with global `AGENTS.md` configuration and response style presets, making it easier to tune assistant instructions and answer style across workspaces (thanks to @Yabuku-xD).
- Chat/UI: added a wide layout option for roomier review sessions.
- Chat/Streaming: reduced text flicker, preserved first chunks more reliably, and kept long agent sessions from hanging during active responses (thanks to @pasta-paul).
- Chat/Scrolling: preserved per-session scroll position and kept generated prompts scrolled into view, making session switching and prompt generation feel steadier (thanks to @jwcrystal).
- Settings/UI: improved settings scrolling and empty states for cleaner setup flows (thanks to @Yabuku-xD).
- Models/Providers: fixed slash-containing model IDs, refreshed model metadata after OpenCode restarts, and added safer concurrency controls for sessions sharing the same provider (thanks to @yart, @Yabuku-xD).
- GitHub/MCP: improved fork-aware issue and pull-request listing, PR status handling, and remote MCP header handling for more reliable repository and remote-provider workflows (thanks to @corrm, @ricautomation).

## [1.9.10] - 2026-04-28

- UI/Localization: added Korean interface translations and default new installs back to English when no language has been chosen (thanks to @An-jinu).
- Chat/Models: unified the model picker with a cleaner, more consistent selection flow (thanks to @daveotero).
- Chat/UI: improved split-response action placement, error-message alignment, tab close affordances, and overscroll behavior for a more polished conversation view.
- Sessions/Sidebar: fixed stale session, folder, project, and worktree state after mutations, and polished pinned-session indicators so navigation stays accurate (thanks to @corrm, @Yabuku-xD).
- Windows: normalized drive-letter paths in extension webviews so file links and workspace paths resolve more reliably (thanks to @sdunfeng).
- Usage: added MiniMax and Ollama quota support for broader usage visibility in the extension.
- Reliability/Startup: hardened managed OpenCode startup, preserved shell PATH more reliably, and improved stream/proxy recovery with heartbeat support (thanks to @An-jinu).

## [1.9.9] - 2026-04-26

- UI/Localization: added translated interface strings for Spanish, Brazilian Portuguese, Ukrainian, and Simplified Chinese, with language selection available in extension settings.
- Settings/Appearance: added selectable interface and code fonts with 10 choices each, and reorganized appearance sections for faster personalization.
- Chat/Header: restored context usage in the chat header, kept it tooltip-only, and kept rate-limit usage available in expanded layouts.
- Chat/Workflow: added keyboard turn navigation, widened chat content, and introduced a local workspace review slash command for faster review handoff.
- Chat/Context: autocomplete and mention results are now easier to scan, with fuller results and clearer active-tab behavior while drafting.
- Chat/Tasks: todo list progress now updates live as task status changes, and task/model status hints are steadier during active runs (thanks to @Yabuku-xD).
- Chat/Performance: improved cold start and streaming smoothness with lazy-loaded heavy components, chunk-load recovery, and lower re-render churn in long sessions (thanks to @Yabuku-xD).
- Reliability/Sync: improved reconnect recovery so active sessions resync more reliably after transient stream interruptions, with safer local-stream buffering (thanks to @jwcrystal, @vhqtvn).
- Reliability/Startup: improved managed runtime startup by preserving user PATH and skipping stale session directories, reducing startup edge-case failures.

## [1.9.8] - 2026-04-22

- Sessions/Reliability: fixed parent-child session sync during reconnects and navigation, so status and progress stay aligned in nested session trees (thanks to @jwcrystal).
- Settings/Sync: settings changes now sync more reliably with other clients, and sidebar session pagination is steadier in larger workspaces.
- Sessions/Folders: folder updates now persist through server-backed APIs, improving consistency across different machine path setups.
- UI: refined chat chrome with a cleaner bottom scroll fade and hidden idle tasks row.
- Chat/Commands: added `/summary` slash command for a non-destructive session summary - optional topic hint after the command focuses the output, and the prompt is customizable under Settings: Magic Prompts.

## [1.9.7] - 2026-04-22

- Sessions/UI: added bulk selection in the sessions sidebar and fixed pinned sessions so they stay pinned after reloads (thanks to @yart).
- Chat/Files: you can now drag files and folders from the file tree into chat, with improved `@folder` autocomplete when building prompt context (thanks to @youfch).
- Files: open editors now refresh file content after external changes, reducing stale-file surprises while coding (thanks to @jwcrystal).
- Settings/MCP: improved MCP auth flow with remote config support and clearer diagnostics for faster setup and troubleshooting (thanks to @daveotero).
- Chat/Questions: single-choice questions now use radio selection, making guided responses clearer and faster.
- Reliability: config resolution now matches OpenCode behavior more closely, reducing extension/runtime mismatches during startup and settings reads (thanks to @cyan).
- Reliability/Streaming: strengthened bootstrap and connection recovery paths, improving first-load consistency and reducing stuck/empty session states during reconnects.

## [1.9.6] - 2026-04-17

- Reliability: improved startup shell detection to avoid false OpenCode discovery on POSIX login shells, reducing stuck startup edge cases in new workspaces (thanks to @geekifan).
- Reliability/Streaming: moved to a WebSocket-first message stream with SSE fallback and added safer compression handling, improving stability on slower or proxied connections (thanks to @geekifan, @jwcrystal).
- Sessions/Worktrees: enforced worktree isolation for session and Git flows, reducing cross-project context bleed when switching chats or branches (thanks to @jwcrystal).
- Chat/Export: added export session as Markdown and improved empty-state/export behavior, making conversation handoff and notes easier (thanks to @coldbrow).
- Chat/Markdown: added LaTeX rendering support for clearer math and technical notation in rendered messages (thanks to @ricautomation).

## [1.9.5] - 2026-04-14

- Chat/Tool Output: added an interactive tree viewer for structured outputs and fixed JSON quote rendering, making large payloads easier to inspect accurately (thanks to @yaozhenghangma).
- Chat/Reliability: fixed question-tool content disappearing after refresh, so follow-up answers remain visible after panel reloads (thanks to @jwcrystal).
- Sync/Performance: optimized multi-session streaming with per-directory queues, event coalescing, and parts-gap recovery for steadier live updates in busy workspaces (thanks to @jwcrystal).
- Task/Reliability: hardened subagent session resolution and polling lifecycle handling to reduce silent task failures (thanks to @jwcrystal).
- Sessions/UI: kept active sessions visible in Recent, auto-expanded parent groups for subagent sessions, and hid empty archived/folder sections for cleaner navigation (thanks to @jwcrystal).
- Models: restored model-variant compatibility with newer OpenCode runtimes so variant selection behaves more reliably (thanks to @Chi-square-test).
- Usage: added Zhipu AI Coding Plan tracking for broader quota visibility in the extension (thanks to @cainiao1992).

## [1.9.4] - 2026-04-07

- Reliability/Streaming: added loading timeouts, automatic SSE reconnect, and message retry behavior so temporary connection stalls recover more reliably (thanks to @jwcrystal).
- Reliability/Windows: normalized workspace path handling in SSE event lookup to keep live session updates working more consistently on Windows (thanks to @widipa).
- Sessions/Streaming: fixed directory-aware event routing and post-reconnect session resync so subagent/session status is less likely to get stuck after reconnects (thanks to @daveotero, @jwcrystal).
- Chat/Performance: reduced streaming re-render fanout and status-row churn for smoother long responses in the editor panel.
- Chat/Scrolling: fixed scroll jumps and stabilized follow-to-latest behavior so live output stays easier to track while generating.
- Chat/Tool Output: LSP diagnostics now render directly in tool output, making code issue review faster during iterative runs (thanks to @yulia-ivashko).
- Models: added defensive fallbacks for missing model cost/capability metadata so model controls stay stable with incomplete provider responses (thanks to @Chi-square-test).

## [1.9.3] - 2026-03-01

- Security/Chat: user messages now escape raw HTML by default, so pasted markup is shown as text instead of being interpreted in chat (thanks to @kalac2232).
- Sessions/Drafts: draft chat config now stays aligned with the active draft target directory, reducing model/agent mismatch when switching draft context (thanks to @hkay-dev).
- Files/Markdown: added filesystem stat support in the extension bridge to validate markdown targets more reliably before file handling flows (thanks to @geekifan).
- Chat/Models: added arrow-key navigation for thinking-mode selection in model controls, making keyboard model tuning faster while composing prompts (thanks to @daveotero).
- Chat: improved error message readability with clearer styling and safer word-wrapping, so failures stay easier to scan in narrow editor panels (thanks to @nguyenngothuong).
- Chat/JSON: added an interactive JSON tree viewer with collapse/expand controls and richer color cues for easier inspection of large structured outputs (thanks to @nguyenngothuong).
- Reliability/Streaming: proxy handling now normalizes identity encoding, strips conflicting compression headers and hop-by-hop response headers, and suppresses expected upstream SSE close errors to reduce noisy disconnect failures (thanks to @jwcrystal, @Jovines, @JiwaniZakir, @shekohex).
- Usage: added ZhipuAI quota tracking and fixed MiniMax coding-plan plus GitHub Copilot overusage calculations for more accurate quota reporting (thanks to @kalac2232, @baruchvitorino, @ebrainte).

## [1.9.2] - 2026-03-31

- Chat/Performance: overhauled live sync and streaming updates to reduce re-render churn and keep long-running chats smoother in the extension.
- Sessions/UI: refined sidebar behavior with cleaner spacing, better truncation/tooltips, and a resizable sessions pane for tighter workspace control.
- Chat/Editor integration: improved Explorer file insertion so drag-and-drop and context actions add `@` file mentions more reliably without duplicate path text.
- Reliability: startup now queues bridge and stream requests until the API is ready, reducing false bootstrap failures and early-session instability.
- Chat: reasoning content now renders through the markdown pipeline for more consistent readability during live responses.

## [1.9.1] - 2026-03-20

- Sessions: sidebar lists now keep sessions visible in both Recent and Project sections for easier session discovery (thanks to @nguyenngothuong).
- Chat/GitHub: linked issues and pull requests now show as user-message attachments and open more reliably through extension-safe external link handling.
- Settings/MCP: adding MCP servers now correctly respects user scope so user entries are not written into project config files.
- Reliability: managed server startup now imports login-shell environment values and normalizes Windows paths to reduce session-loading mismatches and proxy-related connection issues.
- Usage: added MiniMax Weekly quota provider support for broader quota tracking coverage (thanks to @nzlov).

## [1.9.0] - 2026-03-20

- Navigation/UI: refreshed the extension shell with a redesigned sidebar, clearer hierarchy, and cleaner session grouping so active work is easier to navigate.
- Sessions: improved sidebar organization and interaction stability, including fixes for drag/rename edge cases during quick session management.
- Chat/Performance: reduced streaming overhead and update churn for smoother long responses, steadier activity rendering, and fewer UI stalls in heavy sessions.
- Chat: improved follow-to-latest behavior and timeline stability so ongoing responses remain easier to track.
- Chat/Permissions: added per-session permission auto-accept controls to reduce repetitive approval prompts in iterative workflows.
- Reliability/Windows: normalized workspace drive-letter handling and hid background process windows to reduce startup/session mismatches (thanks to @zerone0x).

## [1.8.7] - 2026-03-13

- No notable changes.

## [1.8.6] - 2026-03-13

- Chat: completed a turn-based render pipeline with steadier streaming, smoother auto-follow, and more stable activity/tool progress behavior during long responses.
- Chat/Settings: added richer render controls with sorted/live modes, compact Activity previews, and default-open Bash/Edit options for faster review.
- Reliability: switched extension event streaming to an SDK-based SSE proxy path, improving consistency for live updates and session activity signals across chat surfaces.
- Settings: chat display changes now sync across sidebar and session editor views right away, so preferences stay consistent in every open panel.
- Sessions: worktrees with active chats are now prioritized in the sidebar, so in-progress work is easier to resume (thanks to @GhostFlying).
- Sessions: archived-session behavior in the extension is now scoped to the active workspace with cleaner sidebar presentation.
- Chat: fixed modified Enter send shortcuts in narrow layouts, so Ctrl/Cmd+Enter send works more consistently when the panel is compact (thanks to @eengad).
- Chat: fixed queue button behavior and focus-mode composer sizing so input actions stay visible during longer prompts (thanks to @shekohex).
- Diff: edit result comparisons now preserve original file extensions in virtual "before" files, improving syntax highlighting while reviewing changes.

## [1.8.5] - 2026-03-04

- Chat/Files: edit-style tool results now open in a VS Code diff editor with focus on the first changed line, making review and follow-up edits much faster.
- Chat: improved focus-mode input layout so the footer action row stays pinned and available while composing long prompts.
- Settings: removed duplicate chat display options from Appearance and hid extension-irrelevant sections, making settings easier to scan.
- UI/Theming: aligned startup/loading branding with the active theme for a more consistent look during connection and auth states.
- Reliability: improved startup recovery for provider/model/agent loading so options are less likely to appear empty right after opening the extension.

## [1.8.4] - 2026-03-04

- Chat: added Save as image support for assistant messages, so you can export response snapshots directly from the extension.
- Chat: added a new `Changes` tool-output mode that opens edit/write/patch results by default while keeping activity easier to scan.
- Chat Activity: active tools now appear immediately and continue updating in collapsed view, so in-flight work stays visible with stable durations (thanks to @nelsonPires5).
- Chat: file references in assistant responses are now clickable (including line targets), making jump-to-file workflows faster during review.
- Chat/Files: improved `@` file mentions with active-project scoping and more consistent search behavior, reducing irrelevant results.
- Chat/GitHub: added Attach menu support for linking pull requests into your draft with picker-based selection and attached PR context.
- Chat: simplified attachment actions with a direct Attach files flow, reducing friction when adding context from the workspace.
- Chat: improved sticky user-message behavior with bounded height and internal scrolling, so long prompts stay readable without overwhelming the thread.
- Shortcuts/Models: added favorite-model cycling shortcuts, so you can switch between starred models without leaving the keyboard (thanks to @iamhenry).
- UI: interactive controls now consistently use pointer cursors, improving click affordance throughout the extension (thanks to @KJdotIO).


## [1.8.3] - 2026-03-02

- Chat: added user-message display options for plain-text rendering and sticky headers, with preferences persisted in settings.
- Chat: improved code block readability with cleaner header actions, restored horizontal scrolling, and more polished themed highlighting in markdown and tool output (thanks to @nelsonPires5).
- Chat: model picker provider groups are now collapsible, with expanded/collapsed state remembered.

## [1.8.2] - 2026-03-01

- Chat: improved message readability with cleaner tool/reasoning rendering and more polished markdown presentation in long responses.
- Chat Activity: timing display is now less noisy, with detailed end timestamps shown on hover when you need them (thanks to @nelsonPires5).
- Reliability: improved panel visibility/reconnect handling so session activity stays more consistent after hiding and reopening the extension.
- Reliability: fixed live-streaming edge cases for event endpoints with query/trailing-slash variants, improving real-time updates across chat, session editor, and agent-manager views.

## [1.8.1] - 2026-02-28

- No notable changes.

## [1.8.0] - 2026-02-28

- Chat: improved long-session performance with virtualized message rendering, smoother scrolling, and more stable behavior in large histories (thanks to @shekohex).
- Chat: added drag-and-drop file attachments, so dropping files from Explorer into chat is now a first-class flow (thanks to @Asuta).
- Chat: enabled markdown rendering in user messages for clearer formatted prompts and notes (thanks to @haofeng0705).
- Chat: pasted absolute paths are now treated as normal messages, reducing accidental command-like sends.
- Chat: fixed queued send behavior for inactive sessions to reduce accidental sends to the wrong conversation.
- Chat: enabled bueatiful diffs for edit tools in chat (thanks to @shekohex).
- UI: improved long filename handling in file-mention autocomplete so results stay readable while typing (thanks to @haofeng0705).
- Usage: added MiniMax coding-plan quota provider support for broader usage tracking coverage (thanks to @nzlov).
- Usage: added Ollama Cloud quota provider support for broader usage tracking coverage (thanks to @iamhenry).

## [1.7.5] - 2026-02-25

- Sessions: improved switching performance so moving between chats feels more immediate.
- Chat: fixed cases where messages could duplicate or disappear during active conversations.

## [1.7.4] - 2026-02-24

- Settings: redesigned the settings workspace with flatter, more consistent layouts so key options are easier to find.
- Settings: grouped agents/skills navigation by subfolder to make larger setups easier to manage (thanks to @nguyenngothuong).
- Chat: improved streaming smoothness and runtime stability with buffered updates and reliability fixes, reducing lag, stuck spinners, memory growth, and timeout-related interruptions in long runs (thanks to @nguyenngothuong).
- Chat: draft text now persists per session, and the input supports an expanded focus mode for longer prompts (thanks to @nguyenngothuong).
- Chat: added fullscreen Mermaid preview, improved default thinking-variant persistence, and hardened file-preview safety checks for a more predictable message experience (thanks to @yulia-ivashko).
- Sessions: expanded folder management with subfolders, cleaner organization controls, and clearer delete confirmations (thanks to @nguyenngothuong).
- Settings: added an MCP config manager UI to simplify editing and validating MCP server configuration (thanks to @nguyenngothuong).
- Chat Activity: improved Structured Output tool rendering with dedicated title/icon, clearer result descriptions, and more reliable detailed expansion defaults.
- Chat: added C, C++, and Go language support for syntax-aware rendering in code-heavy workflows (thanks to @fomenks).
- Reliability: aligned file read/raw endpoint safety checks with other runtimes for more consistent extension behavior (thanks to @yulia-ivashko).

## [1.7.3] - 2026-02-21

- Sessions: added custom folders to group chat sessions, with move/rename/delete flows and persisted collapse state per project (thanks to @nguyenngothuong).
- Notifications: improved agent progress notifications and permission handling to reduce noisy prompts during active runs (thanks to @nguyenngothuong).
- Settings: added customizable keyboard shortcuts for chat actions, panel toggles, and services, so you can better match the extension to your workflow (thanks to @nelsonPires5).
- UI: unified clipboard copy behavior for more consistent copy actions and feedback across extension surfaces.
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

## [1.7.0] - 2026-02-17

- Chat: improved live streaming responsiveness with part-delta updates and smarter auto-follow scrolling during generation.
- Chat: Mermaid diagrams now render directly in messages, with quick copy/download actions for easier reuse.
**- Reliability: managed runtime startup now rotates secure auth credentials and hardens API proxy auth forwarding for safer local connections (thanks to @yulia-ivashko).**
**- Reliability: extension startup/shutdown handling is more predictable, reducing stuck states during reconnects.**

## [1.6.9] - 2026-02-16

- Agent Manager / Worktrees: switched to an upstream-first worktree flow with stronger branch tracking, making worktree sessions more predictable (thanks to @yulia-ivashko).
- Usage: added NanoGPT quota provider support and improved provider wiring for steadier usage reporting (thanks to @nelsonPires5).
- UI: compact model info in selection (price + capabilities), making model selection faster and more cost-aware (thanks to @nelsonPires5).

## [1.6.8] - 2026-02-12

- Chat: added drag-and-drop attachments with inline image previews, so sending screenshots and files from the editor is faster and much more reliable.
- Sessions: fixed previously selected session carry-over when navigating from chat / session draft and list of sessions.
- Chat: improved picker search with fuzzy matching on names and descriptions to speed up finding the right agent/model.
- Usage: corrected Gemini and Antigravity quota source mapping and labels for more reliable usage metrics (thanks to @gsxdsm).
- Usage: remaining-quota mode now inverts usage markers, making trend direction clearer at a glance (thanks to @gsxdsm).

## [1.6.7] - 2026-02-10

- Added usage pace and prediction indicators in the header and settings to make quota usage trends easier to track (thanks to @gsxdsm).
- Added confirmation dialogs for destructive delete/reset actions to reduce accidental mistakes in settings and management flows.
- Improved reliability for message loading so sessions recover more predictably after reloads.

## [1.6.6] - 2026-02-9

- Usage: added per-model quota groups in the header and fixed provider dropdown scrolling for easier usage tracking (thanks to @nelsonPires5, @gsxdsm).
- Reliability: fixed OpenCode auth pass-through/proxy behavior to reduce failed extension requests (thanks to @gsxdsm).

## [1.6.5] - 2026-02-6

- Settings: added an OpenCode CLI path override so you can use a custom/local CLI install.
- Chat: added arrow-key prompt history and an optional setting to persist input drafts between restarts (thanks to @gsxdsm).
- Chat: thinking/reasoning blocks now render more consistently, and justification visibility settings now apply reliably (thanks to @gsxdsm).
- Reliability: improved OpenCode binary resolution and HOME-path handling for steadier local startup.

## [1.6.4] - 2026-02-5

- Improved Windows PATH resolution and cold-start readiness checks to reduce "stuck loading" sessions.
- Usage: expanded quota tracking with more providers (including GitHub Copilot) and a provider selector dropdown (thanks to @gsxdsm, @nelsonPires5).
- Chat: select text in messages to quickly add it to your prompt or start a new session (thanks to @gsxdsm).


## [1.6.3] - 2026-02-2

- Improved server health check with the proper health API endpoint and increased timeout for steadier startup (thanks to @wienans).
- Settings dialog no longer persists open/closed state across extension restarts.


## [1.6.2] - 2026-02-1

- Added multi-provider quota dashboard in settings to monitor API usage across OpenAI, Google, and z.ai with auto-refresh support (thanks to @nelsonPires5).
- Enhanced token-based theming system for better themes support.


## [1.6.1] - 2026-01-30

- Chat: added Stop button to cancel generation mid-response.
- Chat: improved compact controls on narrow panels with a unified drawer for model and tool options.
- Chat: added Apply Patch tool support for opening files in editor
- Reliability: improved event stream reconnection when the panel is hidden/shown or VS Code regains focus.


## [1.6.0] - 2026-01-29

- Added message stall detection with automatic soft resync for more reliable message delivery.
- Fixed "Load older" button in long sessions with proper progressive pagination.
- Session activity status now updates reliably even when the extension panel is hidden or collapsed.


## [1.5.9] - 2026-01-28

- Agent Manager: migrated to Opencode SDK worktree implementation; sessions in worktrees are now completely isolated.
- Agent Manager: worktree setup commands are now persistant per project and automatically saved/restored.


## [1.5.8] - 2026-01-26

- Plans: added new Plan/Build mode switching support.
- Chat: linkable mentions, better wrapping, and markdown/scroll polish in messages.
- Skills: ClawdHub catalog now pages results and retries transient failures.
- Diff: fixed Chrome scrolling in All Files layout.
- Activity: added a text-justification setting for activity summaries (thanks to @iyangdianfeng).
- Performance: faster chat rendering for busy sessions.
- Reliability: file lists and message sends handle missing directories and transient errors more gracefully.


## [1.5.7] - 2026-01-24

- No notable changes


## [1.5.6] - 2026-01-24

- GitHub: added backend support for PRs/issues workflows; UI comes later.


## [1.5.5] - 2026-01-23

- Settings: agent and command overrides now prefer plural directories while still honoring legacy singular folders.
- Skills: installs now target plural directories while still recognizing legacy singular folders.


## [1.5.4] - 2026-01-22

- Apply Patch tool now shows a diff preview for applying patch edits.
- Settings: manage provider configuration files directly from the extension.


## [1.5.3] - 2026-01-20

- Chat: Smoother session switching with more stable scroll anchoring.
- Chat: new Activity view in collapsed state, now shows latest 6 tools by default.
- Chat: Updated accent color derivation to better match editor themes.
- Performance: Faster filesystem/search operations and general stability improvements (thanks to @TheRealAshik).
- Files: adjusted default visibility for hidden/dotfiles to be visible and gitignored entries to be hidden.


## [1.5.2] - 2026-01-17

- Chat: optimized message loading for opening sessions.
- Layout: tuned responsive breakpoint and server readiness timeout for steadier startup.
- Reliability: improved OpenCode process cleanup to reduce orphaned servers.


## [1.5.1] - 2026-01-16

- No notable changes


## [1.5.0] - 2026-01-16

- Improved OpenCode server management to ensure it initializes within the workspace directory.
- Enhanced extension startup with context-aware readiness checks for the current workspace.
- Fixed orphaned OpenCode processes not being cleaned up on restart or exit.
- Session tabs: fixed opening new session in editor tab; title bar button now opens new session tab, sidebar button opens current or new session.
- Layout: added responsive expanded layout showing sessions sidebar + chat side-by-side when extension is wide enough (≥700px).
- Layout: extension now opens to sessions list instead of new session draft.
- Layout: compact header with reduced padding for better space efficiency.
- Settings: hidden Git Identities tab, Git section, and Diff view settings (not applicable to VS Code).
- Settings: hidden project switcher dropdown (VS Code uses workspace).
- Shortcuts: disabled worktree session creation with shortcuts (Ctrl+Shift+N now opens standard session).


## [1.4.9] - 2026-01-14

- Added session editor panel to view sessions alongside files.
- Improved server connection reliability with multiple URL candidate support.
- Upload: increased attachment size limit to 50MB with automatic image compression to 2048px for large files.


## [1.4.8] - 2026-01-14

- Chat: sidebar sessions are now automatically sorted by last updated date (thanks to @vio1ator).
- Chat: fixed edit tool output and added turn duration.
- UI: todo lists and status indicators now hide automatically when all tasks are completed (thanks to @vio1ator).
- Reliability: improved project state preservation on validation failures (thanks to @vio1ator) and refined server health monitoring.
- Stability: added graceful shutdown handling for the server process (thanks to @vio1ator).


## [1.4.7] - 2026-01-10

- Skills: added ClawdHub integration as built-in market for skills.


## [1.4.6] - 2026-01-09

- Switch opencode cli management to SDK.
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


## [1.4.4] - 2026-01-08

- Agent Manager / Multi Run: select agent per worktree session (thanks to @wienans).
- Agent Manager / Multi Run: worktree actions to delete group or individual worktrees, or keep only selected one (thanks to @wienans).
- Agent Manager: added "Copy Worktree Path" action in the more menu (thanks to @wienans).
- Worktrees: added session creation flow with loading screen, auto-create worktree setting, and setup commands management.
- Session sidebar: refactoring with unified view for sessions in worktrees.
- Settings: added ability to create new session in worktree by default.
- Chat: fixed IME composition for CJK input to prevent accidental send (thanks to @madebyjun).
- Projects: added multi-project support with per-project settings for agents/commands/skills.
- Event stream: improved SSE with heartbeat management, permission bootstrap on connect, and reconnection logic.
- Model selector: fixed dropdowns not responding to viewport size.


## [1.4.3] - 2026-01-04

- Added Agent Manager panel to run the same prompt across up to 5 models in parallel (thanks to @wienans).
- Added permission prompt UI for tools configured with "ask" in opencode.json, showing requested patterns and "Always Allow" options (thanks to @aptdnfapt).
- Added "Open subAgent session" button on task tool outputs to quickly navigate to child sessions (thanks to @aptdnfapt).
- Improved activation reliability and error handling.


## [1.4.2] - 2026-01-02

- Added timeline dialog (`/timeline` command or Cmd/Ctrl+T) for navigating, reverting, and forking from any point in the conversation (thanks to @aptdnfapt).
- Added `/undo` and `/redo` commands for reverting and restoring messages in a session (thanks to @aptdnfapt).
- Added fork button on user messages to create a new session from any point (thanks to @aptdnfapt).
- Migrated to OpenCode SDK v2 with improved API types and streaming.


## [1.4.1] - 2026-01-02

- Added the ability to select the same model multiple times in multi-agent runs for response comparison.
- Model selector now includes search and keyboard navigation for faster model selection.
- Added revert button to all user messages (including first one).
- Added HEIC image support for file attachments with automatic MIME type normalization for text format files.
- Only show the main Worktree in the Chat Sidebar (thanks to @wienans).
- Terminal: improved terminal performance and stability by switching to the Ghostty-based terminal renderer.


## [1.4.0] - 2026-01-01

- Added the ability to run multiple agents from a single prompt, with each agent working in an isolated worktree.
- Worktrees: new branch creation can start from a chosen base; remote branches are only created when you push.
- Default location is now the right secondary sidebar in VS Code, and the left activity bar in Cursor/Windsurf; navigation moved into the title bar (thanks to @wienans).
- Chat: now shows clearer error messages when agent messages fail.
- Sidebar: improved readability for sticky headers with a dynamic background.


## [1.3.9] - 2025-12-30

- Added skills management to settings with the ability to create, edit, and delete skills.
- Added Skills catalog functionality for discovering and installing skills from external sources.
- Added right-click context menu with "Add to Context," "Explain," and "Improve Code" actions (thanks to @wienans).


## [1.3.8] - 2025-12-29

- Added queued message mode with chips, batching, and idle auto‑send (including attachments).
- Added queue mode toggle to settings (chat section).
- Fixed scroll position persistence for active conversation turns across session switches.
- Refactored Agents/Commands management with ability to configure project/user scopes.


## [1.3.7] - 2025-12-28

- Redesigned Settings as a full-screen view with tabbed navigation.
- ESC key now closes settings.
- Added responsive tab labels in settings header (icons only at narrow widths).
- Improved session activity status handling and message step completion logic.
- Introduced enhanced extension settings with dynamic layout based on width.


## [1.3.6] - 2025-12-27

- Added the ability to manage (connect/disconnect) providers in settings.
- Adjusted auto-summarization visuals in chat.


## [1.3.5] - 2025-12-26

- Improved file search with fuzzy matching capabilities.
- Fixed workspace switching performance and API health checks.
- Improved provider loading reliability during workspace switching.
- Fixed session handling for non-existent worktree directories.
- Added settings for choosing the default model/agent to start with in a new session.


## [1.3.4] - 2025-12-25

- Improved type checking and editor integration.


## [1.3.3] - 2025-12-25

- Fixed startup, more reliable OpenCode CLI/API management, and stabilized API proxying/streaming.
- Added an animated loading screen and introduced command for status/debug output.
- Fixed session activity tracking so it correctly handles transitions through states.
- Fixed directory path handling (including `~` expansion) to prevent invalid paths and related Git/worktree errors.
- Chat UI: improved turn grouping/activity rendering and fixed message metadata/agent selection propagation.
- Chat UI: improved agent activity status behavior and reduced image thumbnail sizes for better readability.


## [1.3.0] - 2025-12-21

- Added revert functionality in chat for user messages.
- Updated user message layout/styling.
- Improved header tab responsiveness.
- Fixed bugs with new session creation when the extension initialized for the first time.
- Adjusted extension theme mapping and model selection view.
- Polished file autocomplete experience.


## [1.2.9] - 2025-12-20

- Session auto‑cleanup feature with configurable retention.
- Optimization for long sessions.


## [1.2.6] - 2025-12-19

- Added write/create tool preview in permission cards with syntax highlighting.
- More descriptive assistant status messages with tool-specific and varied idle phrases.


## [1.2.5] - 2025-12-19

- Polished chat experience for longer sessions.
- Smoother session rename experience.


## [1.2.2] - 2025-12-17

- Agent Task tool now renders progressively with live duration and completed sub-tools summary.
- Unified markdown rendering between assistant messages and tool outputs.
- Reduced markdown header sizes for better visual balance.


## [1.2.1] - 2025-12-16

- Todo task tracking: collapsible status row showing AI's current task and progress.
- Switched "Detailed" tool output mode to only open critical tools (task, edit, write, etc.) for better performance.


## [1.2.0] - 2025-12-15

- Favorite & recent models for quick access in model selection.
- Tool call expansion settings: collapsed, activity, or detailed modes.
- Font size & spacing controls (50-200% scaling) in Appearance Settings.
- Settings page access within extension.


## [1.1.6] - 2025-12-15

- Redesigned password-protected session unlock screen.


## [1.1.5] - 2025-12-15

- Enhanced file attachment features performance.
- Added fuzzy search feature for file mentioning with @ in chat.
- Optimized input area layout.


## [1.1.4] - 2025-12-15

- Flexoki themes for Shiki syntax highlighting for consistency with the app color schema.
- Enhanced extension theming with editor themes.


## [1.1.2] - 2025-12-13

- Moved extension to activity bar (left sidebar).
- Added feedback messages for "Restart API Connection" command.
- Removed redundant commands.
- Enhanced UserTextPart styling.


## [1.1.0] - 2025-12-13

- Added assistant answer fork flow to start new sessions with inherited context.
- Initial VS Code extension release with editor integration: file picker, click-to-open in tool parts.
- Improved scroll performance.
