## [1.13.9] - 2026-07-02

- Agents: clearing optional agent fields now removes them from agent config instead of saving `null` values.
- Startup: the extension no longer picks OpenCode desktop app installs when looking for the standalone OpenCode CLI.
- Chat: fixed edge cases where late-loading tool content, subagent content, or streaming Thinking blocks could pull the conversation away from the latest message or fight manual scrolling.
- Chat: embedded JSON examples in messages no longer render as generated-result cards.
- Sync: chat state now recovers after idle reconnects instead of leaving sessions stuck in a stale busy state.

## [1.13.8] - 2026-06-29

- Chat: a new Follow-up behavior setting controls what happens when you press Enter on a message while the agent is still responding — Steer inserts it into the agent's current turn, or Queue holds it until the turn finishes. Replaces the previous queue-mode toggle (thanks to @bashrusakh).
- Sync: a connected but quiet session (for example an agent running a long tool call) no longer triggers repeated background refreshes every ~15 seconds (thanks to @tomzx).

## [1.13.7] - 2026-06-28

- Chat: with tool calls (such as Bash and Edit) shown expanded by default, scrolling no longer twitches, and slow scrolling no longer jumps past several messages.
- Providers: the Add provider form stays open while provider data refreshes or a model is picked in the background, instead of snapping back to an existing provider.

## [1.13.6] - 2026-06-28

- Chat: scrolling in conversations now stays steady while sending, queueing, streaming, switching sessions, and loading older messages.

## [1.13.5] - 2026-06-27

- No notable changes.

## [1.13.4] - 2026-06-27

- UI/Localization: added Japanese interface translations (thanks to @yuchi0531).
- Chat: queued messages can now be reordered by dragging them in the queue (thanks to @makeittech).
- Chat: sending a message now closes an open question prompt instead of leaving stale question UI in the composer (thanks to @tomzx).
- Chat: conversations pinned to the bottom no longer jiggle or double-scroll after sending, and revisiting older sessions snaps to the latest message without a smooth-scroll delay.
- Models: the model picker now remembers provider group expansion and custom ordering, and Shift+Delete removes a recent model from recents (thanks to @makeittech).
- Agents: agent edits against an external OpenCode server no longer show a saved-state update when the save did not succeed (thanks to @makeittech).
- Providers: the add-provider form no longer loses the selected provider during background provider refreshes (thanks to @IbrahimKhan12).

## [1.13.3] - 2026-06-24

- Chat: selecting a user-installed skill from the slash command menu now invokes the skill instead of inserting the skill name as plain text (thanks to @IbrahimKhan12).
- Chat: pasted text containing `@` no longer opens file mention autocomplete unexpectedly (thanks to @charpeni).
- Chat: code blocks in user messages now preserve characters like `<` and `->` instead of escaping them inside the code block (thanks to @bashrusakh).
- Chat: switching sessions and loading older messages no longer causes the conversation to jump backward or oscillate around the current scroll position (thanks to @herjarsa).
- Chat: Arrow Up opens prompt history again when the cursor is at the start of the composer.
- Sessions: new sessions now stay attached to the selected workspace directory instead of sometimes appearing under a stale project (thanks to @bashrusakh).
- Sessions: pinned sessions and folder rows no longer disappear from the sidebar after an empty session-list refresh (thanks to @bashrusakh).
- Agents: agent settings now include thinking variant, temperature, and top-p controls, and clearing temperature or top-p now removes the override (thanks to @bashrusakh).
- Settings/Models: per-model visibility and sibling model selections now stay saved after changes (thanks to @attilaszasz).
- Settings: font size and padding preferences now apply inside the extension webview (thanks to @Sin991114).
- Settings/Skills: the skills catalog refreshes after catalog settings change (thanks to @gokulkgm).
- Usage: MiniMax M3 and Token Plan usage now handle the provider's latest API response format (thanks to @baruchvitorino).
- Startup: managed OpenCode server processes left behind by a previous extension crash are cleaned up on the next start.

## [1.13.2] - 2026-06-18

- Chat/Performance: long conversations and large session lists now stay smooth and responsive while a response is streaming (thanks to @bashrusakh).
- Chat: the end of a streamed response is no longer occasionally cut off — messages now always settle on their complete text (thanks to @IbrahimKhan12).
- Chat: paragraphs in assistant messages now have proper spacing instead of collapsing into a single block (thanks to @foundryseven).
- Startup: the extension starts faster by no longer waiting on default OpenCode config, while your manual and per-directory model selections are preserved.

## [1.13.1] - 2026-06-17

- Startup: providers and agents now load faster at startup.
- Chat: pinned welcome starters now appear immediately when a new draft session opens.
- Chat: inline math delimiters no longer incorrectly treat currency amounts like `$50` as LaTeX math expressions.
- Chat: code-block highlighting now runs off the main thread, keeping the UI responsive during code-heavy responses.
- Chat: the context usage indicator now shows as a circular progress ring.
- Agents: deleting a built-in agent no longer creates a disable override — the agent stays as-is instead of being silently disabled.
- Agents: deleting an agent now shows an error toast when the definition is missing.

## [1.13.0] - 2026-06-15

- Startup: the extension opens faster — recent sessions, models, providers, and projects appear instantly from cache and refresh in the background, and the loading screen no longer lingers after the interface is ready.
- Startup: requests made while OpenCode is still starting now wait briefly for it to become ready instead of failing, and if OpenCode fails to start the error now includes what it reported.
- Sessions: the list now groups sessions under their workspace, so pinning sessions and moving them into folders work as expected.
- Sessions: session rows now use a cleaner single-line layout, and a new control next to "archive all" toggles archived sessions on or off.
- Chat: custom-answer question textareas resize more steadily while typing (thanks to @bigcoder84).
- Chat/Performance: long conversations now use virtualized rendering to keep large histories responsive.
- Chat/Input: tab-completing a mention no longer changes the selected agent (thanks to @Quat3rnion).
- Chat/Input: Arrow Up moves the cursor inside multi-line drafts again instead of always opening prompt history.
- Sessions: session menus now include a delete action (thanks to @ShogunPanda).
- Sessions: deleting a parent session no longer brings deleted child sessions back into the sidebar (thanks to @panzeyu2013).
- Sessions: switching sessions no longer leaves the chat area blank in some cases (thanks to @panzeyu2013).
- Settings/MCP: importing MCP snippets from OpenCode config works again (thanks to @youzini).

## [1.12.4] - 2026-06-11

- Agent Manager: creating isolated runs now opens sessions immediately while worktree setup continues in the background.
- Agent Manager: hidden models now stay hidden in multi-model selection controls (thanks to @kjhq).
- Sessions: chat folder assignments now stay in place after reloads.
- Sessions: added an action to archive all sessions (thanks to @jjdubski).
- Sessions: session and folder rows now have right-click menus for their available actions.
- Workspaces: added multi-root workspace support, including workspace folder switching in the extension (thanks to @mmospanenko).
- Settings: added search across settings pages.
- Chat/UI: added a setting to collapse long user messages.
- Chat: table copy actions now include a Markdown format option (thanks to @kjhq).
- Chat: `@agent` mentions in rendered messages now use the primary accent color.
- Usage: added Cursor quota tracking.
- UI/Localization: added French extension translations (thanks to @pascalandr).

## [1.12.3] - 2026-06-05

- Startup: OpenCode health checks now work with OpenCode 1.15.x.

## [1.12.2] - 2026-06-05

- Startup/Windows: the extension now detects more OpenCode installs from PATH, npm, Scoop, and Chocolatey.
- Chat: prompts sent while creating or switching target sessions now stay attached to the intended workspace directory.
- Files: chat and tool links now handle Windows drive-letter and backslash paths.

## [1.12.1] - 2026-06-03

- Chat: completed turns can now show changed-file chips with per-file additions and deletions, controlled by a new Chat setting.
- Chat: LSP tool calls now show the operation, file, and cursor position more clearly, and JSON tool output can be toggled between formatted and raw views or copied.
- Chat: streaming messages now appear correctly after startup, and activity/status rows show for the active session.
- Chat: completed responses no longer lose late-arriving summaries, token counts, errors, structured output, or changed-file details.
- Chat: question cards now show an error or no-longer-pending message when submit or dismiss fails instead of silently doing nothing.
- Chat: the first prompt in a new session no longer gets stuck before sending.
- Sessions: session titles update from live session events, and the extension now consistently loads all existing OpenCode sessions.
- Sessions: recent sessions now stay visible inside project groups, and new or worktree sessions stay in the correct project/worktree group.
- Settings/OpenCode: OpenCode CLI path, update-notification preference, keyboard shortcuts, and protected-session settings now stay saved after changes.
- UI/Time: the time-format preference now applies to chat timestamps, usage reset times, scheduled tasks, passkeys, and usage last-updated times.

## [1.12.0] - 2026-06-03

- Chat: added customizable draft welcome starters from commands and skills, including guided commands for catch-up, debugging, exploration, and approach comparison.
- Chat: assistant answers now have a dialog for starting a new session from that answer.
- Chat/Input: queued messages no longer auto-send before the active session is ready, and thinking-variant choices are preserved for generated messages.
- Chat/UI: markdown-rendered user messages now preserve line breaks.
- UI/Theming: chat colors now map more closely to the active editor theme, and the session UI has been refined.
- Reliability/Startup: Restart API Connection now uses the same loading and reload flow as startup.

## [1.11.7] - 2026-05-27

- Chat/Input: selecting an agent now switches to that agent's configured model, and malformed tool diffs no longer break chat rendering (thanks to @Adrian-Eckardt).
- Usage: added a setting to hide prediction rows on usage cards (thanks to @ermanhavuc).
- Reliability/Streaming: restored live streaming in the extension.

## [1.11.6] - 2026-05-25

- Settings/Plugins: added a Plugins page for managing opencode plugins, with npm update checks and user/project scopes (thanks to @Quat3rnion).
- Perf: Git repository lookups in the extension now avoid repeating the same Git read commands during refreshes.

## [1.11.5] - 2026-05-25

- Chat/Input: pending image attachments now show previews, sent image attachments can be cited from assistant messages, and markdown source mode highlights formatting while you type.
- Chat: queued messages now send to the session they were queued from, even if you switch sessions before they are sent.
- Chat/UI: chats keep following the latest response after final task summaries, activity reasoning no longer flashes before settling, and assistant timestamps stay visible on narrow layouts.
- Settings/Skills: installed skills are discovered more accurately, skill files opened from tool messages now load correctly, and snippet names keep their canonical casing (thanks to @jkker, @isanchez404).
- Voice: OpenAI-compatible custom speech providers can now use API keys (thanks to @yangyaofei).

## [1.11.4] - 2026-05-22

- Sessions: switching between chat sessions now keeps less inactive message history in the webview, especially after opening large conversations.
- Sessions: opening a session now fetches a smaller initial message page, while still expanding enough to show the latest user turn when needed.
- Chat: task tool results use final task summaries when available instead of repeatedly loading child-session messages.
- Chat: task tool polling in the extension now uses smaller message fetches while subtasks are active or idle.
- Chat: markdown file links now cap path checks in the extension, reducing stalls in messages with many inline paths.
- Chat: the extension header reads only the active session title and latest usage data instead of reacting to the full session list.

## [1.11.3] - 2026-05-19

- Editor Integration: Add to Context now attaches the selected code as context instead of pasting a formatted block into the input.
- Editor Integration: Add File to Chat now attaches selected files instead of inserting file mentions.
- Editor Integration: Add to Context, Add File to Chat, Explain, and Improve Code now target the active session editor when one is open.
- Chat: session editor tabs now update their title to match the session title.
- Sessions: session rows now include an action to open a chat as editor tab.
- Notifications: completion, question, and permission notifications now use the extension notification settings and shows as multi-platforn native notifications.
- Chat: question cards now include copy buttons for Markdown and JSON (thanks to @robertoberto).
- Chat: slash command autocomplete now includes skills and clearer command/type badges.
- Usage: added Wafer.ai quota tracking (thanks to @bowber).

## [1.11.2] - 2026-05-18

- Chat: thinking blocks can now be collapsed, and expanding tool details feels smooth (thanks to @ermanhavuc).
- Chat: reverting or forking messages now keeps file attachments in place, with clearer undo/redo controls (thanks to @youfch, @ermanhavuc).
- Sessions: root project sessions now show up correctly in the session switcher (thanks to @isanchez404).
- Skills: installed skills now match OpenCode's own skill list more closely.

## [1.11.1] - 2026-05-15

- Chat/Sessions: added a session switcher to the chat header.
- Chat/Subagents: opened subagent sessions read-only in the context panel and made subagent chats read-only.
- Chat/UI: sorted-mode tool paths animate consistently, and tooltip crashes are guarded defensively.
- Usage: quota reset times now display in your local timezone.
- Skills: the skills catalog now keeps the selected source label visible when switching sources (thanks to @kjhq).

## [1.11.0] - 2026-05-14

- Chat/Permissions: restored `@agent` mentions in sent messages and parent-session auto-accept for child-session permissions.
- Chat/Input: queued messages now auto-send one at a time in FIFO order, and model/agent selections persist across reloads (thanks to @lyxxx708, @chutastic).
- Chat/Performance: virtualized more timeline content, deferred heavy tool output, and improved scroll-to-bottom behavior.
- Editor Integration: chat commands now wait for the sidebar webview before sending selections, file mentions, explain prompts, or improve prompts.
- Editor Integration: active-editor context updates now ignore stale broadcasts.
- Reliability/Streaming: extension SSE reconnect delays now abort cleanly and disposed chat webviews clean up their live streams.
- Agent Manager: settings changes now sync into Agent Manager views immediately.
- Sessions: archived-session bulk delete now works reliably from the extension sidebar (thanks to @jjdubski).
- UI/Reliability: added smaller fixes for chunk-load recovery, locale retry behavior, stale attachment reads, and accessible session controls (thanks to @isanchez404).

## [1.10.4] - 2026-05-09

- Chat/Input: model, variant, and agent labels collapse better on narrow widths.
- Git/Worktrees: pull-request worktrees can now reuse an existing local branch when it matches the PR head.
- Git: deduplicated lightweight and full status refreshes separately, preventing stale or mismatched Git updates during background polling (thanks to @isanchez404).
- Reliability/Sync: preserved message part update ordering (thanks to @isanchez404).

## [1.10.3] - 2026-05-08

- Chat/Scrolling: rebuilt auto-follow behavior for active responses.
- Chat/Scrolling: saved scroll positions restore consistently after session switches, hydration, and draft-to-session transitions.
- Chat/UI: tightened scroll-to-bottom behavior and code-block scrolling handoff.
- Chat/Input: fixed attachment-only queued sends, stale attachment restores, stale file-search results, autocomplete tab handling, and focusable removal controls (thanks to @isanchez404).
- Reliability/Sync: reduced stale and duplicate live-state updates across request arrays, retry metadata, streaming indicators, and session status events, cutting unnecessary rerenders and stuck activity states during long-running chats (thanks to @isanchez404).
- Skills/Reliability: ignored outdated skills catalog and repo scans.
- Chat/Reliability: added smaller polish fixes for text-selection cleanup (thanks to @isanchez404).

## [1.10.2] - 2026-05-07

- Chat/Reliability: stabilized live turn rendering and session sync caches.
- Terminal: improved Android tablet keyboard handling, including control-key shortcuts, and kept app shortcuts from stealing focus while typing in the terminal (thanks to @Dav1dch).
- Terminal: set a UTF-8 locale for terminal sessions (thanks to @liyiopener).
- Usage: OpenRouter credit balances now avoid misleading percentage displays and use clearer labels across usage views (thanks to @zerone0x).
- Reliability: split the extension into a dedicated app root.

## [1.10.1] - 2026-05-06

- UI/Localization: added Polish interface translations, expanding language support for Polish-speaking users (thanks to @levy52).
- Sessions: added a quick archive action directly on session rows (thanks to @zoubenr).
- Chat/Timeline: added full-text timeline search across user, assistant, and tool messages in a session.
- Chat/Reliability: pending questions now survive session switches and directory eviction.
- Reliability/Sync: aligned session status parsing and reconnect reconciliation (thanks to @vhqtvn).
- Startup/Reliability: configured OpenCode CLI paths are now validated before managed startup, with clearer errors for missing, non-executable, or app-bundle paths.
- Performance/Reliability: reduced duplicate extension initialization, deferred heavier views, lowered managed runtime status overhead, optimized markdown file-link detection, reduced sync recovery payloads, and suppressed expected missing-directory noise.

## [1.10.0] - 2026-05-05

- Chat/UI: added the currently open editor file to chat context (thanks to @daveotero).
- Settings/Behavior: added a dedicated Behavior page with global `AGENTS.md` configuration and response style presets.
- Chat/UI: added a wide layout option.
- Chat/Streaming: reduced text flicker, preserved first chunks reliably, and kept long agent sessions from hanging during active responses (thanks to @pasta-paul).
- Chat/Scrolling: preserved per-session scroll position and kept generated prompts scrolled into view (thanks to @jwcrystal).
- Settings/UI: improved settings scrolling and empty states (thanks to @Yabuku-xD).
- Models/Providers: fixed slash-containing model IDs, refreshed model metadata after OpenCode restarts, and added safer concurrency controls for sessions sharing the same provider (thanks to @yart, @Yabuku-xD).
- GitHub/MCP: improved fork-aware issue and pull-request listing, PR status handling, and remote MCP header handling (thanks to @corrm, @ricautomation).

## [1.9.10] - 2026-04-28

- UI/Localization: added Korean interface translations and default new installs back to English when no language has been chosen (thanks to @An-jinu).
- Chat/Models: unified the model picker with a cleaner selection flow (thanks to @daveotero).
- Chat/UI: improved split-response action placement, error-message alignment, tab close affordances, and overscroll behavior.
- Sessions/Sidebar: fixed stale session, folder, project, and worktree state after mutations, and polished pinned-session indicators (thanks to @corrm, @Yabuku-xD).
- Windows: normalized drive-letter paths in extension webviews (thanks to @sdunfeng).
- Usage: added MiniMax and Ollama quota support.
- Reliability/Startup: hardened managed OpenCode startup, preserved shell PATH reliably, and improved stream/proxy recovery with heartbeat support (thanks to @An-jinu).

## [1.9.9] - 2026-04-26

- UI/Localization: added translated interface strings for Spanish, Brazilian Portuguese, Ukrainian, and Simplified Chinese, with language selection available in extension settings.
- Settings/Appearance: added selectable interface and code fonts with 10 choices each, and reorganized appearance sections.
- Chat/Header: restored context usage in the chat header, kept it tooltip-only, and kept rate-limit usage available in expanded layouts.
- Chat/Workflow: added keyboard turn navigation, widened chat content, and introduced a local workspace review slash command.
- Chat/Context: autocomplete and mention results are now easier to scan, with fuller results and clearer active-tab behavior while drafting.
- Chat/Tasks: todo list progress now updates live as task status changes, and task/model status hints are steady during active runs (thanks to @Yabuku-xD).
- Chat/Performance: improved cold start and streaming smoothness with lazy-loaded heavy components, chunk-load recovery, and lower re-render churn in long sessions (thanks to @Yabuku-xD).
- Reliability/Sync: improved reconnect recovery (thanks to @jwcrystal, @vhqtvn).
- Reliability/Startup: improved managed runtime startup by preserving user PATH and skipping stale session directories.

## [1.9.8] - 2026-04-22

- Sessions/Reliability: fixed parent-child session sync during reconnects and navigation (thanks to @jwcrystal).
- Settings/Sync: settings changes now sync reliably with other clients, and sidebar session pagination is steady in larger workspaces.
- Sessions/Folders: folder updates now persist through server-backed APIs.
- UI: refined chat chrome with a cleaner bottom scroll fade and hidden idle tasks row.
- Chat/Commands: added `/summary` slash command for a non-destructive session summary - optional topic hint after the command focuses the output, and the prompt is customizable under Settings: Magic Prompts.

## [1.9.7] - 2026-04-22

- Sessions/UI: added bulk selection in the sessions sidebar and fixed pinned sessions (thanks to @yart).
- Chat/Files: you can now drag files and folders from the file tree into chat, with improved `@folder` autocomplete when building prompt context (thanks to @youfch).
- Files: open editors now refresh file content after external changes.
- Settings/MCP: improved MCP auth flow with remote config support and clearer diagnostics (thanks to @daveotero).
- Chat/Questions: single-choice questions now use radio selection.
- Reliability: config resolution now matches OpenCode behavior more closely.
- Reliability/Streaming: strengthened bootstrap and connection recovery paths.

## [1.9.6] - 2026-04-17

- Reliability: improved startup shell detection to avoid false OpenCode discovery on POSIX login shells.
- Reliability/Streaming: moved to a WebSocket-first message stream with SSE fallback and added safer compression handling.
- Sessions/Worktrees: enforced worktree isolation for session and Git flows.
- Chat/Export: added export session as Markdown and improved empty-state/export behavior (thanks to @coldbrow).
- Chat/Markdown: added LaTeX rendering support for clearer math and technical notation in rendered messages (thanks to @ricautomation).

## [1.9.5] - 2026-04-14

- Chat/Tool Output: added an interactive tree viewer for structured outputs and fixed JSON quote rendering (thanks to @yaozhenghangma).
- Chat/Reliability: fixed question-tool content disappearing after refresh (thanks to @jwcrystal).
- Sync/Performance: optimized multi-session streaming with per-directory queues, event coalescing, and parts-gap recovery for steady live updates in busy workspaces (thanks to @jwcrystal).
- Task/Reliability: hardened subagent session resolution and polling lifecycle handling to reduce silent task failures (thanks to @jwcrystal).
- Sessions/UI: kept active sessions visible in Recent, auto-expanded parent groups for subagent sessions, and hid empty archived/folder sections (thanks to @jwcrystal).
- Models: restored model-variant compatibility with newer OpenCode runtimes (thanks to @Chi-square-test).
- Usage: added Zhipu AI Coding Plan tracking (thanks to @cainiao1992).

## [1.9.4] - 2026-04-07

- Reliability/Streaming: added loading timeouts, automatic SSE reconnect, and message retry behavior (thanks to @jwcrystal).
- Reliability/Windows: normalized workspace path handling in SSE event lookup to keep live session updates working consistently on Windows (thanks to @widipa).
- Sessions/Streaming: fixed directory-aware event routing and post-reconnect session resync (thanks to @daveotero, @jwcrystal).
- Chat/Performance: reduced streaming re-render fanout and status-row churn for smooth long responses in the editor panel.
- Chat/Scrolling: fixed scroll jumps and stabilized follow-to-latest behavior.
- Chat/Tool Output: LSP diagnostics now render directly in tool output (thanks to @yulia-ivashko).
- Models: added defensive fallbacks for missing model cost/capability metadata (thanks to @Chi-square-test).

## [1.9.3] - 2026-03-01

- Security/Chat: user messages now escape raw HTML by default (thanks to @kalac2232).
- Sessions/Drafts: draft chat config now stays aligned with the active draft target directory.
- Files/Markdown: added filesystem stat support in the extension bridge to validate markdown targets reliably before file handling flows (thanks to @geekifan).
- Chat/Models: added arrow-key navigation for thinking-mode selection in model controls (thanks to @daveotero).
- Chat: improved error message readability with clearer styling and safer word-wrapping (thanks to @nguyenngothuong).
- Chat/JSON: added an interactive JSON tree viewer with collapse/expand controls and richer color cues for easier inspection of large structured outputs (thanks to @nguyenngothuong).
- Reliability/Streaming: proxy handling now normalizes identity encoding, strips conflicting compression headers and hop-by-hop response headers, and suppresses expected upstream SSE close errors to reduce noisy disconnect failures (thanks to @jwcrystal, @Jovines, @JiwaniZakir, @shekohex).
- Usage: added ZhipuAI quota tracking and fixed MiniMax coding-plan plus GitHub Copilot overusage calculations (thanks to @kalac2232, @baruchvitorino, @ebrainte).

## [1.9.2] - 2026-03-31

- Chat/Performance: overhauled live sync and streaming updates to reduce re-render churn and keep long-running chats smooth in the extension.
- Sessions/UI: refined sidebar behavior with cleaner spacing, better truncation/tooltips, and a resizable sessions pane for tighter workspace control.
- Chat/Editor integration: improved Explorer file insertion.
- Reliability: startup now queues bridge and stream requests until the API is ready.
- Chat: reasoning content now renders through the markdown pipeline.

## [1.9.1] - 2026-03-20

- Sessions: sidebar lists now keep sessions visible in both Recent and Project sections for easier session discovery (thanks to @nguyenngothuong).
- Chat/GitHub: linked issues and pull requests now show as user-message attachments and open reliably through extension-safe external link handling.
- Settings/MCP: adding MCP servers now correctly respects user scope.
- Reliability: managed server startup now imports login-shell environment values and normalizes Windows paths to reduce session-loading mismatches and proxy-related connection issues.
- Usage: added MiniMax Weekly quota provider support (thanks to @nzlov).

## [1.9.0] - 2026-03-20

- Navigation/UI: refreshed the extension shell with a redesigned sidebar, clearer hierarchy, and cleaner session grouping.
- Sessions: improved sidebar organization and interaction stability, including fixes for drag/rename edge cases during quick session management.
- Chat/Performance: reduced streaming overhead and update churn for smooth long responses, steady activity rendering, and fewer UI stalls in heavy sessions.
- Chat: improved follow-to-latest behavior and timeline stability.
- Chat/Permissions: added per-session permission auto-accept controls to reduce repetitive approval prompts in iterative workflows.
- Reliability/Windows: normalized workspace drive-letter handling and hid background process windows to reduce startup/session mismatches (thanks to @zerone0x).

## [1.8.7] - 2026-03-13

- No notable changes.

## [1.8.6] - 2026-03-13

- Chat: completed a turn-based render pipeline with steady streaming, smooth auto-follow, and more stable activity/tool progress behavior during long responses.
- Chat/Settings: added richer render controls with sorted/live modes, compact Activity previews, and default-open Bash/Edit options.
- Reliability: switched extension event streaming to an SDK-based SSE proxy path.
- Settings: chat display changes now sync across sidebar and session editor views right away.
- Sessions: worktrees with active chats are now prioritized in the sidebar (thanks to @GhostFlying).
- Sessions: archived-session behavior in the extension is now scoped to the active workspace with cleaner sidebar presentation.
- Chat: fixed modified Enter send shortcuts in narrow layouts (thanks to @eengad).
- Chat: fixed queue button behavior and focus-mode composer sizing (thanks to @shekohex).
- Diff: edit result comparisons now preserve original file extensions in virtual "before" files.

## [1.8.5] - 2026-03-04

- Chat/Files: edit-style tool results now open in a VS Code diff editor with focus on the first changed line.
- Chat: improved focus-mode input layout.
- Settings: removed duplicate chat display options from Appearance and hid extension-irrelevant sections.
- UI/Theming: aligned startup/loading branding with the active theme for a more consistent look during connection and auth states.
- Reliability: improved startup recovery for provider/model/agent loading.

## [1.8.4] - 2026-03-04

- Chat: added Save as image support for assistant messages.
- Chat: added a new `Changes` tool-output mode that opens edit/write/patch results by default while keeping activity easier to scan.
- Chat Activity: active tools now appear immediately and continue updating in collapsed view (thanks to @nelsonPires5).
- Chat: file references in assistant responses are now clickable (including line targets).
- Chat/Files: improved `@` file mentions with active-project scoping and more consistent search behavior.
- Chat/GitHub: added Attach menu support for linking pull requests into your draft with picker-based selection and attached PR context.
- Chat: simplified attachment actions with a direct Attach files flow.
- Chat: improved sticky user-message behavior with bounded height and internal scrolling.
- Shortcuts/Models: added favorite-model cycling shortcuts (thanks to @iamhenry).
- UI: interactive controls now consistently use pointer cursors.


## [1.8.3] - 2026-03-02

- Chat: added user-message display options for plain-text rendering and sticky headers, with preferences persisted in settings.
- Chat: improved code block readability with cleaner header actions, restored horizontal scrolling, and themed highlighting in markdown and tool output (thanks to @nelsonPires5).
- Chat: model picker provider groups are now collapsible, with expanded/collapsed state remembered.

## [1.8.2] - 2026-03-01

- Chat: improved message readability with cleaner tool/reasoning rendering and more polished markdown presentation in long responses.
- Chat Activity: timing display is now less noisy, with detailed end timestamps shown on hover when you need them (thanks to @nelsonPires5).
- Reliability: improved panel visibility/reconnect handling.
- Reliability: fixed live-streaming edge cases for event endpoints with query/trailing-slash variants.

## [1.8.1] - 2026-02-28

- No notable changes.

## [1.8.0] - 2026-02-28

- Chat: improved long-session performance with virtualized message rendering, smooth scrolling, and more stable behavior in large histories (thanks to @shekohex).
- Chat: added drag-and-drop file attachments (thanks to @Asuta).
- Chat: enabled markdown rendering in user messages for clearer formatted prompts and notes (thanks to @haofeng0705).
- Chat: pasted absolute paths are now treated as normal messages.
- Chat: fixed queued send behavior for inactive sessions to reduce accidental sends to the wrong conversation.
- Chat: edit tools now use improved diffs (thanks to @shekohex).
- UI: improved long filename handling in file-mention autocomplete (thanks to @haofeng0705).
- Usage: added MiniMax coding-plan quota provider support (thanks to @nzlov).
- Usage: added Ollama Cloud quota provider support (thanks to @iamhenry).

## [1.7.5] - 2026-02-25

- Sessions: improved switching performance.
- Chat: fixed cases where messages could duplicate or disappear during active conversations.

## [1.7.4] - 2026-02-24

- Settings: redesigned the settings workspace with flatter, more consistent layouts.
- Settings: grouped agents/skills navigation by subfolder to make larger setups easier to manage (thanks to @nguyenngothuong).
- Chat: improved streaming smoothness and runtime stability with buffered updates and reliability fixes.
- Chat: draft text now persists per session, and the input supports an expanded focus mode for longer prompts (thanks to @nguyenngothuong).
- Chat: added fullscreen Mermaid preview, improved default thinking-variant persistence, and hardened file-preview safety checks for a more predictable message experience (thanks to @yulia-ivashko).
- Sessions: expanded folder management with subfolders, cleaner organization controls, and clearer delete confirmations (thanks to @nguyenngothuong).
- Settings: added an MCP config manager UI to simplify editing and validating MCP server configuration (thanks to @nguyenngothuong).
- Chat Activity: improved Structured Output tool rendering with dedicated title/icon, clearer result descriptions, and more reliable detailed expansion defaults.
- Chat: added C, C++, and Go language support for syntax-aware rendering in code-heavy workflows (thanks to @fomenks).
- Reliability: aligned file read/raw endpoint safety checks with other runtimes (thanks to @yulia-ivashko).

## [1.7.3] - 2026-02-21

- Sessions: added custom folders to group chat sessions, with move/rename/delete flows and persisted collapse state per project (thanks to @nguyenngothuong).
- Notifications: improved agent progress notifications and permission handling to reduce noisy prompts during active runs (thanks to @nguyenngothuong).
- Settings: added customizable keyboard shortcuts for chat actions, panel toggles, and services (thanks to @nelsonPires5).
- UI: unified clipboard copy behavior.
- Reliability: improved startup environment detection by capturing login-shell environment snapshots.
- Reliability: refactored OpenCode config/auth integration into domain modules for steady provider auth and command loading flows (thanks to @nelsonPires5).

## [1.7.2] - 2026-02-20

- Chat: question prompts now guide you to unanswered items before submit.
- Chat: fixed auto-send queue to wait for the active session to be idle before sending.
- Chat: improved streaming activity rendering and session attention indicators.
- UI: added Plan view in the context sidebar panel for quicker access to plan content while you work (thanks to @nelsonPires5).
- Settings: model variant options now refresh correctly in draft/new-session flows, avoiding stale selections.
- Reliability: provider auth failures now show clearer re-auth guidance when tokens expire (thanks to @yulia-ivashko).

## [1.7.1] - 2026-02-18

- Chat: slash commands now follow server command semantics (including multiline arguments).
- Chat: added a shell mode triggered by leading `!`, with inline output visibility/copy.
- Chat: improved delegated-task clarity with richer subtask bubbles, better task-detail rendering, and parent-chat surfacing for child permission/question requests.
- Chat: improved `@` mention autocomplete by prioritizing agents and cleaning up ordering.
- Skills: discovery now uses OpenCode API as the source of truth with safer fallback scanning.
- Skills: upgraded editing/install UX with better code editing, syntax-aware related files, and clearer location targeting across user/project .opencode and .agents scopes.

## [1.7.0] - 2026-02-17

- Chat: improved live streaming responsiveness with part-delta updates and smarter auto-follow scrolling during generation.
- Chat: Mermaid diagrams now render directly in messages, with quick copy/download actions for easier reuse.
**- Reliability: managed runtime startup now rotates secure auth credentials and hardens API proxy auth forwarding for safer local connections (thanks to @yulia-ivashko).**
**- Reliability: extension startup/shutdown handling is more predictable.**

## [1.6.9] - 2026-02-16

- Agent Manager / Worktrees: switched to an upstream-first worktree flow with stronger branch tracking (thanks to @yulia-ivashko).
- Usage: added NanoGPT quota provider support and improved provider wiring for steady usage reporting (thanks to @nelsonPires5).
- UI: compact model info in selection (price + capabilities) (thanks to @nelsonPires5).

## [1.6.8] - 2026-02-12

- Chat: added drag-and-drop attachments with inline image previews.
- Sessions: fixed previously selected session carry-over when navigating from chat / session draft and list of sessions.
- Chat: improved picker search with fuzzy matching on names and descriptions to speed up finding the right agent/model.
- Usage: corrected Gemini and Antigravity quota source mapping and labels (thanks to @gsxdsm).
- Usage: remaining-quota mode now inverts usage markers (thanks to @gsxdsm).

## [1.6.7] - 2026-02-10

- Added usage pace and prediction indicators in the header and settings to make quota usage trends easier to track (thanks to @gsxdsm).
- Added confirmation dialogs for destructive delete/reset actions to reduce accidental mistakes in settings and management flows.
- Improved reliability for message loading.

## [1.6.6] - 2026-02-9

- Usage: added per-model quota groups in the header and fixed provider dropdown scrolling for easier usage tracking (thanks to @nelsonPires5, @gsxdsm).
- Reliability: fixed OpenCode auth pass-through/proxy behavior to reduce failed extension requests (thanks to @gsxdsm).

## [1.6.5] - 2026-02-6

- Settings: added an OpenCode CLI path override.
- Chat: added arrow-key prompt history and an optional setting to persist input drafts between restarts (thanks to @gsxdsm).
- Chat: thinking/reasoning blocks now render consistently, and justification visibility settings now apply reliably (thanks to @gsxdsm).
- Reliability: improved OpenCode binary resolution and HOME-path handling for steady local startup.

## [1.6.4] - 2026-02-5

- Improved Windows PATH resolution and cold-start readiness checks to reduce "stuck loading" sessions.
- Usage: expanded quota tracking with more providers (including GitHub Copilot) and a provider selector dropdown (thanks to @gsxdsm, @nelsonPires5).
- Chat: select text in messages to quickly add it to your prompt or start a new session (thanks to @gsxdsm).


## [1.6.3] - 2026-02-2

- Improved server health check with the proper health API endpoint and increased timeout for steady startup (thanks to @wienans).
- Settings dialog no longer persists open/closed state across extension restarts.


## [1.6.2] - 2026-02-1

- Added multi-provider quota dashboard in settings to monitor API usage across OpenAI, Google, and z.ai with auto-refresh support (thanks to @nelsonPires5).
- Enhanced token-based theming system.


## [1.6.1] - 2026-01-30

- Chat: added Stop button to cancel generation mid-response.
- Chat: improved compact controls on narrow panels with a unified drawer for model and tool options.
- Chat: added Apply Patch tool support for opening files in editor.
- Reliability: improved event stream reconnection when the panel is hidden/shown or VS Code regains focus.


## [1.6.0] - 2026-01-29

- Added message stall detection with automatic soft resync.
- Fixed "Load older" button in long sessions with proper progressive pagination.
- Session activity status now updates reliably even when the extension panel is hidden or collapsed.


## [1.5.9] - 2026-01-28

- Agent Manager: migrated to the OpenCode SDK worktree implementation; sessions in worktrees are now completely isolated.
- Agent Manager: worktree setup commands are now persistent per project and automatically saved/restored.


## [1.5.8] - 2026-01-26

- Plans: added new Plan/Build mode switching support.
- Chat: linkable mentions, better wrapping, and markdown/scroll polish in messages.
- Skills: ClawdHub catalog now pages results and retries transient failures.
- Diff: fixed Chrome scrolling in All Files layout.
- Activity: added a text-justification setting for activity summaries (thanks to @iyangdianfeng).
- Performance: faster chat rendering for busy sessions.
- Reliability: file lists and message sends handle missing directories and transient errors better.


## [1.5.7] - 2026-01-24

- No notable changes.


## [1.5.6] - 2026-01-24

- GitHub: added backend support for PRs/issues workflows; UI comes later.


## [1.5.5] - 2026-01-23

- Settings: agent and command overrides now prefer plural directories while still honoring legacy singular folders.
- Skills: installs now target plural directories while still recognizing legacy singular folders.


## [1.5.4] - 2026-01-22

- Apply Patch tool now shows a diff preview.
- Settings: manage provider configuration files directly from the extension.


## [1.5.3] - 2026-01-20

- Chat: improved session switching with more stable scroll anchoring.
- Chat: the collapsed Activity view now shows the latest 6 tools by default.
- Chat: updated accent color derivation to better match editor themes.
- Performance: improved filesystem/search speed and general stability (thanks to @TheRealAshik).
- Files: adjusted default visibility for hidden/dotfiles to be visible and gitignored entries to be hidden.


## [1.5.2] - 2026-01-17

- Chat: optimized message loading for opening sessions.
- Layout: tuned responsive breakpoint and server readiness timeout for steady startup.
- Reliability: improved OpenCode process cleanup to reduce orphaned servers.


## [1.5.1] - 2026-01-16

- No notable changes.


## [1.5.0] - 2026-01-16

- Improved OpenCode server management to ensure it initializes within the workspace directory.
- Enhanced extension startup with context-aware readiness checks for the current workspace.
- Fixed orphaned OpenCode processes not being cleaned up on restart or exit.
- Session tabs: fixed opening new session in editor tab; title bar button now opens new session tab, sidebar button opens current or new session.
- Layout: added responsive expanded layout showing sessions sidebar + chat side-by-side when extension is wide enough (≥700px).
- Layout: extension now opens to sessions list instead of new session draft.
- Layout: compact header with reduced padding.
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

- Switched OpenCode CLI management to the SDK.
- Input: removed auto-complete and auto-correction.
- Shortcuts: switched the agent cycling shortcut from Shift+Tab back to Tab.
- Chat: added question tool support with a rich UI for interaction.


## [1.4.5] - 2026-01-08

- Chat: added support for model variants (thinking effort).
- Shortcuts: switched the agent cycling shortcut from Tab to Shift+Tab.
- Skills: added autocomplete for skills on "/" when it is not the first character in input.
- Autocomplete: added scope badges for commands/agents/skills.
- Compact: changed `/summarize` to `/compact` and moved compaction to the SDK.
- MCP: added the ability to dynamically enable or disable configured MCP servers.


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
- Model selector now includes search and keyboard navigation.
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
- Fixed session activity tracking.
- Fixed directory path handling (including `~` expansion) to prevent invalid paths and related Git/worktree errors.
- Chat UI: improved turn grouping/activity rendering and fixed message metadata/agent selection propagation.
- Chat UI: improved agent activity status behavior and reduced image thumbnail sizes.


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
- Reduced markdown header sizes.


## [1.2.1] - 2025-12-16

- Todo task tracking: collapsible status row showing AI's current task and progress.
- Switched "Detailed" tool output mode to only open critical tools (task, edit, write, etc.).


## [1.2.0] - 2025-12-15

- Favorite & recent models for quick access in model selection.
- Tool call expansion settings: collapsed, activity, or detailed modes.
- Font size & spacing controls (50-200% scaling) in Appearance Settings.
- Settings page access within extension.


## [1.1.6] - 2025-12-15

- Redesigned password-protected session unlock screen.


## [1.1.5] - 2025-12-15

- Improved file attachment performance.
- Added fuzzy search for file mentions with `@` in chat.
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
