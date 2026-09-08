## [1.22.2] - 2026-09-05

### New

- **Comments on code.** Select lines, click the `+` in the gutter or right-click → OpenChamber → Add Comment, and write your note. It stays pinned to the code and goes out with your next message as a context card. Works in diffs too (thanks to @felipegenef).
- The extension is available in Turkish (thanks to @fitzgpt).
- Chat: prompt history. Arrow up and down in the composer bring back your earlier prompts, attachments included, and the history survives a reload. It covers the current session; Settings → Chat can widen it to every project and set how many prompts to keep, 40 by default (thanks to @mattv8).
- Chat: an "Enter sends" switch in Settings → Chat. On, Enter sends and Shift+Enter adds a line; off, the other way round. Ctrl/Cmd+Enter always sends. Nothing changes until you flip it (thanks to @claymor333).

### Improvements

- Chat: Markdown tables are readable again, columns take the width their content needs (thanks to @ChangeHow).
- Chat: the Summary, Tree, or Raw view you pick for a JSON tool result is remembered for every JSON card and after a reload (thanks to @karimodm).
- A fresh install uses VS Code's display language until you choose one in Settings.

### Fixes

- Settings/Providers: editing a custom provider keeps all of its model settings, and the protocol you chose is saved (thanks to @hehuaiyu).
- Chat: huge patches in tool cards open without freezing the page (thanks to @karimodm).
- Chat: pressing Enter to confirm text on a Japanese, Chinese, or Korean keyboard no longer sends a comment by accident (thanks to @ChangeHow).
- Goal Mode: when a reply is cut off by the length limit, the goal continues, and Resume gives it another try (thanks to @bashrusakh).
- Sessions: subagent sessions are found in projects with more than 200 sessions (thanks to @bashrusakh).
- Permission auto-accept works again with the stable OpenCode (thanks to @bashrusakh).
- On Windows, the status command and adding a folder to the workspace handle drive-letter case correctly (thanks to @pttydou).

## [1.22.1] - 2026-09-04

### New

- Settings: Fixel Text is available as an interface font.
- Usage: exe.dev usage windows are tracked.

### Improvements

- **OpenCode Go:** the usage request the extension sends now carries the `x-opencode-session` header OpenCode Go requires from 6 September. Chat traffic already had it.
- Chat: a queued message keeps its attached context, file mentions, and skill, and editing it brings them back to the composer.
- Sessions: starting a rename selects the whole title (thanks to @yulia-ivashko).

### Fixes

- Worktrees: removing a worktree no longer freezes the interface. It runs in the background with a progress toast (thanks to @yulia-ivashko).
- Worktrees: a worktree created from a branch behind its upstream now fetches first and branches from the remote (thanks to @jtatum).
- Worktrees: the New Worktree dialog keeps what you typed when the worktree list changes while it is open (thanks to @yulia-ivashko).
- Worktrees: a removed worktree leaves the sidebar under every project it was listed in (thanks to @yulia-ivashko).
- Thinking effort: picking Default sticks after a send and across agent or session switches, and a reopened session restores the effort its last message used (thanks to @yulia-ivashko).
- Settings: the theme no longer flips when you switch sessions across directories, and a theme the extension cannot fully report keeps your current preference (thanks to @kydorn).

### Misc

- The Settings Integrations page, which offered the Claude Code and Cursor plugin installs, is gone.

## [1.22.0] - 2026-08-30

### Improvements

- **Chat:** a session you open from the sidebar lands at its end and stays there. Switching sessions no longer jumps or renders half a conversation.

### Fixes

- Chat: a turn that OpenCode stopped no longer ends with nothing on screen. What OpenCode reported shows under the last message, and a message an idle session left unanswered is named as such.
- Chat: the status report (Ctrl/Cmd+Shift+L) lists the last session errors and rejected sends.

## [1.21.1] - 2026-08-29

### New

- **Turkish interface:** OpenChamber can be used in Turkish (thanks to @fitzgpt).
- Composer: pasting a big block of text offers to attach it as a `pasted-context-N.txt` file and leaves a reference at the caret. Settings → Chat can make it always attach or always paste inline (thanks to @makeittech).
- Multi-Run: a group can hold more than five models (thanks to @tomzx).
- Chat: a tool card with a file path has a quick-open button that opens the file in the editor (thanks to @robertoberto).

### Improvements

- Context usage reports a session's cost including everything its subagents spent (thanks to @igorvelho).
- Chat: the text the model writes before it asks a question appears right away instead of waiting until the turn ends (thanks to @makeittech).
- Usage: GitHub Copilot shows a single AI Credits window matching Copilot's token-based quota (thanks to @jakoss).
- The extension reuses its OpenCode output channel across managed-server restarts instead of making duplicates (thanks to @TTTPOB).

### Fixes

- **Chat:** a very large tool result is capped before it renders, so it no longer freezes the panel (thanks to @JSap0914).
- Chat: a code block with JavaScript template strings no longer sends the highlighter into endless backtracking (thanks to @makeittech).
- Chat: a diff with a truncated header no longer crashes the conversation (thanks to @pascalandr).
- Chat: a draft or recalled message with Windows line endings no longer throws "Selection points outside of document" every time you open it (thanks to @yulia-ivashko).
- Chat: a session no longer looks frozen after the webview reloads or opens late. Pending permission and question cards come back (thanks to @yangyaofei).
- Chat: a session no longer looks frozen after you dismiss the agent's questions and send a new task (thanks to @bashrusakh).
- Chat: when the turn-ending signal from OpenCode is lost, the working spinner clears within about a second instead of up to ten (thanks to @makeittech).
- `/btw` side questions: a btw session answers the side question instead of carrying on with the parent's plan, and it forks at the last completed turn, so it never inherits a reply that is still streaming (thanks to @pocharlies).
- Composer: typing three backticks leaves the caret inside the finished code fence, an empty input keeps a visible caret, and platform autocorrect behaves as it should (thanks to @franzudev, @TTTPOB, and @IbrahimKhan12).
- Chat scrolling: with "Follow new content while streaming" off, sending while scrolled up leaves the view where it is, and a middle-button pan or Shift+Space stops auto-follow the way the wheel does (thanks to @pascalandr).
- Chat scrolling: PageUp/PageDown in the prompt box no longer shifts the whole panel up.
- Chat: question prompts render Markdown (thanks to @pascalandr).
- Chat: a bare link next to CJK or full-width punctuation no longer swallows it (thanks to @gaojunran).
- Chat: inline code, chips, and model-picker highlights stay readable in high-contrast themes (thanks to @difagume and @bashrusakh).
- Chat: a finished reasoning block shows in full instead of replaying, the text-selection menu stays inside the window, and the sticky user-message header no longer fades over the reply (thanks to @makeittech).
- Chat: sending without a selected model says what is missing (thanks to @rvaldemar).
- Chat: `/init` stays in slash-command autocomplete after the conversation starts (thanks to @Dawnfz-Lenfeng).
- Chat: copying a message keeps Markdown spacing (thanks to @ChangeHow).
- Chat: a model you picked by hand survives switching between Build and Plan (thanks to @makeittech).
- Updates: updating OpenCode no longer fails with a bare "Bad Request". The extension names the release it will install and shows OpenCode's reason when it refuses (thanks to @mdatsev and @yulia-ivashko).
- "Add Project" adds the folder you chose to the workspace instead of failing (thanks to @bashrusakh).
- The extension starts in the current workspace folder instead of one restored from storage (thanks to @makeittech).
- Sidebar: pending permission and question badges are no longer covered by the hover actions (thanks to @makeittech).
- Sidebar: worktree branch search hides branches that do not match (thanks to @bashrusakh).
- Settings/Providers: after you save an API key or sign in, the provider no longer shows "Credentials missing" with its models hidden until you switch away and back (thanks to @herjarsa).
- Settings: number fields and selects no longer clip at large font sizes (thanks to @makeittech).
- Settings: Windows skill paths are classified correctly, so disabled and duplicate skills are hidden as intended (thanks to @Ttungx).
- Windows: closing VS Code stops the managed OpenCode process instead of leaving it running (thanks to @a0000001).
- Work status: undoing or redoing a parent session keeps its subagents at the same point in history (thanks to @alexandrereyes).

## [1.21.0] - 2026-08-26

### New

- **Chat: comment on a reply.** Select text in a chat message and choose Comment to attach that quote with your note to the next message. The selection stays highlighted while you type.
- Chat: context attachments. Diff and file comments, terminal selections, and linked issues and pull requests show as compact context cards, with a source header, the captured content behind an expander, and your comment below.
- Composer: hovering a context chip above the input opens a stacked preview of everything attached, where you can edit comments in place or remove items before sending.
- Permission cards answer to the keyboard. Alt+Enter allows once, Alt+Shift+Enter allows always, Alt+Backspace denies, and the keys are printed on the buttons.

### Improvements

- Chat: @ file mentions rank files and directories together by how well they match, so the file you typed is at the top. Multi-word queries match in any order, and a long path keeps the folder next to the file name visible.
- Search: Ctrl/Cmd+P matches the whole file path, so searching a folder name finds the files inside it.
- Search: pickers for agents, models, providers, and branches put the best matches first, match multi-word queries in any order, and ignore punctuation, so "gpt4o" finds "gpt-4o".
- Keyboard: dropdowns and pickers answer Ctrl+N and Ctrl+P for down and up, the session switcher opens focused on your current session, and shortcut labels show the binding you have set (thanks to @ChangeHow).
- Chat: Cmd/Ctrl+Shift+T cycles through every thinking level the selected model offers instead of stopping at the end (thanks to @nimobeeren).
- Chat: OpenCode notices share one style.

### Fixes

- Chat: the view no longer sticks on its loading screen on slow or remote connections, including code-server behind a reverse proxy (thanks to @VinciYan).
- Chat: the timeline dialog fits small windows instead of squeezing the message list to a couple of rows (thanks to @gaojunran).

## [1.20.0] - 2026-08-23

### New

- **/btw side questions:** type `/btw` and your question to ask something off-topic in a temporary session forked from the current one. The answer streams into a panel above the composer, which you can collapse, keep as a full session, or discard without touching the chat (thanks to @jaygupta17).
- Skills catalog: browse curated GitHub skill collections in a card catalog with search across sources and a link to each skill's repository.
- Settings/Projects: a project can pin a thinking level next to its model, for models that offer levels.
- Chat: an app link such as `spotify://` asks for confirmation before opening another app. You can trust a link type on one device and manage trusted links in Settings.
- Providers: more custom providers are supported.

### Improvements

- Settings: the workspace selector on Providers, Agents, MCP, Commands, and Skills only changes what those pages show, instead of moving the chat, session list, and file tree to another workspace.
- Chat: while a reply streams, the model status line under the last message turns into the finished message's info row in place.
- Usage: Z.ai credit limits appear alongside its other quota windows.
- UI: the default dialog close button is easier to click or tap (thanks to @rockinrimmer).

### Fixes

- Settings/General: changing the default model, variant, or agent no longer repoints an open chat that already carries a model you picked for it. Chats following the default still switch right away.
- Settings/Providers: the provider you select no longer jumps to another one when the chat selection or provider data changes.
- Chat: if OpenCode restarts while a response is running, the chat stops with an interrupted state and a notification to continue instead of hanging silently (thanks to @sum117).
- Chat: newly sent messages and highlighted code blocks no longer flicker, and Bash output grows with its content instead of being cut off.
- Chat: file paths in messages open from the session's workspace, even if you last browsed files in another workspace (thanks to @tomzx).
- Chat: a long user message can be expanded even when its final layout finishes after it first appears.
- Sidebar: sessions created outside OpenChamber appear in the sidebar and Recent list without a page refresh (thanks to @tomzx).

### Misc

- Settings/Integrations: the experimental page lists only integrations you can install. Unavailable and Coming soon entries are gone.

## [1.19.0] - 2026-08-19

### New

- **Settings/Integrations:** a new Integrations page lists the Claude Code, Command Code and Cursor plugins with install, update, setup and remove actions. Discord and Telegram are marked coming soon.
- Usage: Command Code plan limits appear in the Usage page and the work status panel.

### Improvements

- Usage: the context readout in the chat header shows the session's cost in its tooltip (thanks to @YunFeng0817).
- Attachments: text pulled out of Office and OpenDocument files is capped and shown more compactly, so a large document and its images no longer crowd out the rest of the message.

### Fixes

- **Chat:** an open conversation no longer keeps re-coloring the same code blocks in the background, which drove CPU use up while the chat sat idle (thanks to @makeittech).
- Settings: saving settings no longer wipes an OpenCode config written with unquoted JSON5 keys down to an empty `$schema` stub. Plugins, MCP servers and providers stay, and the change reports a failure (thanks to @makeittech).
- Chat: a new chat no longer saves its first message and then never starts when the last worktree directory was deleted; it falls back to the active project.
- Chat: typing with Chinese, Japanese or Korean input methods no longer breaks composition or throws the cursor to the end of the composer (thanks to @makeittech).
- Chat: the context readout no longer climbs past 100% after turns with many tool calls, and no longer jumps when you reopen an older session (thanks to @pocharlies).
- Projects: project names match the folder name exactly, so `.ssh` and `opencode-claude` no longer read as `.Ssh` and `Opencode Claude`. Names you set yourself are kept.
- Add Project adds the chosen folder to the workspace instead of showing a "Failed to add project" toast.
- The model menu no longer paints white text on a white highlight in a high-contrast theme, so the hovered or selected model stays readable (thanks to @bashrusakh).
- Skills Catalog: the misspelled source name ClawdHub now reads ClawHub (thanks to @makeittech).

## [1.18.4] - 2026-08-14

### Fixes

- **Chat:** new messages no longer jump above older ones once the message ID sequence rolls over. Loading history, reverting and redoing follow the same order as the conversation.

## [1.18.3] - 2026-08-14

### Improvements

- Chat images: a finished assistant reply collects its Markdown images into a compact gallery with thumbnails and full-screen previews, including workspace images across multi-root workspaces (thanks to @ChangeHow).
- Chat: the Focus Chat command and the Add to Context action put the cursor in the chat input, so you can keep typing.
- Usage: quota limits you chose to display refresh every three minutes, and you can refresh them by hand at any time.
- Usage: OpenCode Go quota tracking uses your existing OpenCode API key. No browser cookies or workspace ID needed.

### Fixes

- Sessions: switching projects selects a session that belongs to the new workspace (thanks to @makeittech).
- Chat: a message you already submitted stays with its session; a later project switch no longer sends it somewhere else (thanks to @makeittech).
- Chat: typing `!` for shell mode no longer leaves the `!` in the command or puts the caret on the wrong side of it (thanks to @RyderAsKing).
- Chat: line numbers with three or more digits no longer wrap in code blocks (thanks to @ChangeHow).

## [1.18.2] - 2026-08-10

### New

- Usage: xAI quota reporting (thanks to @iamhenry).

### Improvements

- Chat: shell command output is expanded by default, and adding a message to context puts focus back in the composer (thanks to @pascalandr, @makeittech).
- Chat: the composer caret is easier to see.
- Notebooks: notebook links open in the notebook editor when a compatible extension is installed (thanks to @TTTPOB).
- UI: dialogs, dropdowns, popovers and tooltips share the same glass styling.

### Fixes

- **Settings:** OpenCode configuration changes gather behind a single Apply & Restart action, so OpenCode no longer restarts after every edit. The confirmation warns you when active chats will be stopped (thanks to @makeittech).
- Chat: a queued message no longer sends into a response that is still streaming, and tool cards left running by an interrupted response settle instead of staying stuck (thanks to @makeittech).
- Chat: a message you submitted before switching sessions stays with the session and workspace you sent it from. If you switch away it is cancelled, never delivered to another runtime (thanks to @Wsyjq).
- Chat: a fresh message no longer replays its entry animation after it has been shown (thanks to @makeittech).
- MCP: authorization handles browser callbacks more reliably, settings show clearly which servers are available, and a failed connection offers a retry action.
- Settings: quick edits to notification templates no longer overwrite one another, and the collapsed-user-message preference sticks (thanks to @AmanTahiliani, @pascalandr).
- Attachments: removing an attached Office or OpenDocument file also removes the images taken out of that document (thanks to @chiamsun).
- Security: archive extraction updated for GHSA-xcpc-8h2w-3j85 (thanks to @mel0nyrame).

## [1.18.1] - 2026-08-04

### New

- **Sessions:** an archived session can be restored to the active list, from the sidebar context menu, the archived-sessions page or the bulk-selection bar (thanks to @makeittech).
- Chat: Ctrl/Cmd+L adds the selected text to the chat input, or focuses the input when nothing is selected.

### Improvements

- Providers: an OAuth-only provider shows a Connect flow in place of the API key form, and its models appear once you are signed in.
- Providers: a sign-in that needs extra details, such as GitHub Copilot Enterprise, asks for them before it opens the browser.

### Fixes

- **Providers:** signing in to an OAuth-only provider, such as Cursor, completes in the browser. The login is stored and the provider updates, so you are no longer left signed out.
- Providers: the copy button for device codes works.
- Chat: a model you chose by hand stays selected after a delegated subtask finishes; it no longer reverts to the agent's default model.

## [1.18.0] - 2026-08-04

### New

- **Providers:** add and edit custom OpenAI-compatible providers in Settings, with their endpoint, models, credentials, headers, and configuration scope (thanks to @makeittech).
- Localization: the interface is available in German (thanks to @SGD-DEV).
- Settings/Skills: skills kept in the workspace's own `.agents/skills` folder show up for the active workspace (thanks to @makeittech).
- Usage: DeepSeek quota is tracked (thanks to @airtaxi).

### Fixes

- Chat/Tools: Bash output reads as it did in the terminal instead of showing raw escape codes for progress bars and rewritten lines (thanks to @catan271).
- Chat: queued messages retry after a failed send or an interrupted turn instead of sitting stuck until the next session update.
- Chat: assistant messages no longer run HTML.
- Chat: clicking an apply_patch result opens the file you clicked instead of always the first one (thanks to @nabsiddiqui).
- Settings/Skills: renaming a skill keeps its instructions and supporting files. The rename action only shows for skills OpenChamber can safely move (thanks to @makeittech).
- Usage: Kimi for Coding counts usage correctly whether the provider reports what you used or what is left (thanks to @makeittech).
- Sessions: archiving and unarchiving stays inside the current workspace.
- Sidebar: a worktree shared by two projects appears once.
- Sidebar: session titles no longer clip at the ends of their rows.

## [1.17.2] - 2026-08-01

### Improvements

- Chat: a tool description shows the glob pattern when the tool was given one.
- Sessions: a session with an agent working shows a live activity dot even while the sidebar is collapsed (thanks to @pascalandr).

### Fixes

- Permissions: per-session auto-accept answers permission requests as they arrive when it is turned on.
- Chat: messages that arrive right after the connection opens no longer disappear.
- Chat: clicking the padding around the composer puts the cursor in the text (thanks to @IbrahimKhan12).
- Chat: the `/` menu lists a skill once when a command shares its name (thanks to @IbrahimKhan12).
- Usage: every Z.ai usage window shows up in the usage view.

## [1.17.1] - 2026-07-29

### New

- **OpenCode updates:** the extension can update a managed OpenCode installation and restart it for you. A server you manage yourself is left alone (thanks to @yulia-ivashko).

### Improvements

- **Chat tools:** a Bash card shows output while the command is still running, in a pane of fixed height that follows new lines until you scroll away. The timer keeps counting to the real end instead of stopping at 300 seconds.
- Chat: a slash-command starter picks up whatever you already typed in the draft and passes it as the command's arguments.
- Usage: an OpenAI business account shows the spend limit you configured for Codex (thanks to @jrandiny).

### Fixes

- Chat: a stalled response reconnects instead of hanging in the extension.
- Chat: a history you loaded to the end stops offering "Load older" after a refresh.
- Chat: messages you removed by reverting stay gone after you send the next message.
- Settings: subpanels keep a visible vertical scrollbar and lose the horizontal one (thanks to @sergiofspedro).

## [1.17.0] - 2026-07-28

### New

- **Context panel:** Changes, pull requests, files, terminal, notes, plans, previews, and side chats live in one resizable panel with a rail to switch between them. The pull-request view shows checks and comments as they land, and a failed check or a comment can go straight into a chat draft.
- Chat: text selected from a Markdown code block keeps its fences, language, and block structure when you add it to the composer or start a session with it (thanks to @ChangeHow).
- Settings: an option hides starter suggestions on the new-session screen.
- Usage: Crof and NeuralWatt quotas are tracked (thanks to @kydorn).

### Improvements

- **Chat composer:** what you type renders as you type it, with Markdown emphasis, attention lines, file and agent mentions, slash commands, snippets, attachment citations, and `~path` references. A file mention can be edited in place.
- Sessions: the sidebar uses clearer project zones and single-line rows, with folders after ungrouped sessions and archived sessions kept in their workspace sections.
- Chat/Permissions: sending a message while a permission prompt is open denies what is pending in the session and its subagents, then queues your message for the next turn (thanks to @tomzx).
- Chat/Subagents: a subagent chat can be prompted while direct subagent prompting is on, even before the parent session has loaded.

### Fixes

- Sessions: chats sort by activity again. A chat moves in the list when it starts or finishes, and stops reshuffling while a response streams.
- Chat: jumping to a message in a long conversation lands on the right one even when the rows above it have not been drawn yet.
- Chat: code blocks stop shifting lines and merging into nearby text while they render, and copied code keeps its original text (thanks to @ChangeHow).
- Usage: Crof no longer reports "Unsupported provider" (thanks to @kydorn).
- Shortcuts: double-Escape can no longer be primed while the current session is not the active one.

## [1.16.3] - 2026-07-22

### New

- **Chat attachments:** attach Office and OpenDocument files (`.docx`, `.pptx`, `.xlsx`, `.odt`, `.odp`, `.ods`). Their text and the embedded images OpenChamber can read are pulled out before the message goes off.
- Chat attachments: more source-code formats, notebooks, HAR files with credentials and cookies stripped, SVG and Draw.io drawings, and HEIC/HEIF images. The composer warns you when the chosen model may ignore an attachment type.

### Improvements

- **Performance:** opening and switching sessions in a big workspace puts the selected and visible chats first.
- Chat: an assistant turn shows model, agent, thinking level, duration, and time together in its footer, and replies split by a hidden system or subagent prompt read as one turn.
- Sessions: workspace groups are ordered by hand by default. A sorting choice you made yourself stays as it is.

### Fixes

- Performance: a failed refresh keeps the session list you had, a parent session no longer vanishes when its sub-sessions load first, and session data stays inside its own workspace and view.
- Chat: the working indicator names the model actually writing the reply, streaming at the bottom no longer jitters, and a new user message finishes its entry animation instead of snapping into place.
- Chat/Tools: attachments returned by plugin and custom tools stay visible after streaming and refreshes, with the same image previews and file chips as your own attachments (thanks to @FrostiDrinks).
- Cursor: opening a chat no longer crashes when the editor webview lacks its usual messaging APIs, and a closed editor tab stops receiving late streaming messages (thanks to @makeittech).
- Startup: the active workspace is worked out before saved state is restored, so a project outside the editor workspace cannot replace it.
- Agent Manager: creating a worktree recovers when an earlier Git operation left the repository locked, and removing a worktree while its setup is still running no longer brings it back.

## [1.16.2] - 2026-07-18

### New

- Sessions: a new draft or session stays with the workspace selected in the sidebar, including multi-root and nested workspaces (thanks to @bashrusakh).

### Improvements

- **Settings:** every page uses the same responsive layout, navigation is grouped by area, and a save failure is shown in the page header.
- Settings: agent tool permissions separate inherited rules from explicit ones and list session-granted rules on their own (thanks to @makeittech).

### Fixes

- Permissions: per-session auto-accept works again, survives an extension restart, and covers subagent sessions while an OpenChamber view is open.
- Chat: when creating a session fails, the new-session draft stays open with the prompt you submitted.

## [1.16.1] - 2026-07-14

### Improvements

- Chat: a shell-mode command card updates its status and output while the command runs, and highlights the command and its output.

### Fixes

- **Performance:** a large workspace session list no longer regroups every session while chats stream.
- Chat: opening a long chat after an empty or aborted agent turn no longer reloads bigger and bigger parts of its history.
- Chat: a task card follows its own subagent when several run at once, so its activity and "Open subtask" no longer point at another session.

## [1.16.0] - 2026-07-13

### New

- Settings: an editor font size setting for the code editor (thanks to @bashrusakh).
- Usage: OpenCode Go usage is tracked.

### Improvements

- Chat: a session with an active [goal](https://docs.openchamber.dev/session-goals/), started from the web or desktop app, shows the goal strip and its live status above the composer.
- Notifications: subagent completion notifications follow the same settings as the main app.

### Fixes

- Chat: code blocks are highlighted again. The webview's security policy was blocking the syntax highlighter (thanks to @bashrusakh).
- Chat: a queued message sends when the session is already idle instead of waiting forever (thanks to @bashrusakh).
- Chat: a pending agent question stays answerable after a restart, and a renamed session keeps its new title (thanks to @bashrusakh).
- Chat: tool output renders for tools that return something other than text (thanks to @bashrusakh).
- Sessions: pinned sessions survive a refresh (thanks to @bashrusakh).
- Agents: saving agent settings from the UI keeps custom YAML frontmatter fields (thanks to @bashrusakh).
- Windows: a difference in drive letter casing no longer splits one project into duplicates (thanks to @bashrusakh).

## [1.15.0] - 2026-07-10

### New

- Chat/Tools: every tool call expands to show its input, result, and errors, including MCP, plugin, and custom tools. Read and Skill stay compact links to their files.
- Chat/Tools: a JSON result opens in navigable summary, tree, and raw views.
- Chat: code blocks can show line numbers that stay aligned while text streams in.
- Chat: a Wrap Code Block Lines setting controls how long lines wrap.
- Editor Integration: "Add to Context" and the active-editor pin selection use workspace-relative filenames, so the model reads the right file when two files share a name (thanks to @Catan).

### Improvements

- Chat: Mermaid diagrams have zoom controls (thanks to @c-w-xiaohei).
- Chat/Tools: an expanded file-edit or patch result has a button per file to open the diff or jump to the first changed line in the editor.

### Fixes

- Chat/Thinking: reasoning parts stay separate and in the order they happened, and a collapsed preview no longer ends with empty HTML comments.
- Chat: with Sticky User Header on, a user message no longer floats over earlier messages in a long conversation.
- Chat: a message that timed out or lost the connection after OpenCode accepted it stays in the conversation instead of being marked failed.

## [1.14.1] - 2026-07-07

### New

- Chat: the timeline dialog loads older messages when the session history is not fully fetched yet.

### Improvements

- Chat: file references with a line range like `src/file.ts:10-20` are clickable (thanks to @Catan).

### Fixes

- Chat: favorite models stay saved after the extension restarts (thanks to @Catan).
- Settings: closing Settings returns to the view you came from (thanks to @Catan).

## [1.14.0] - 2026-07-05

### Improvements

- Chat: loading older messages keeps your scroll position steady.

### Fixes

- Chat: the stop button aborts a session running in a different project or worktree. Those aborts used to do nothing at all.
- Startup: on Windows, OpenCode installed via npm launches from paths with spaces such as C:\Program Files\nodejs, a binary path pasted with quotes into the Opencode Binary setting works, and the extension also looks in the system-wide npm prefix and Scoop's shims.

## [1.13.9] - 2026-07-02

### Fixes

- Agents: clearing an optional agent field removes it from the agent config, where it used to save a `null`.
- Startup: the extension looks past OpenCode desktop app installs when it hunts for the standalone OpenCode CLI.
- Chat: late-loading tool content, subagent content and streaming Thinking blocks no longer pull the conversation away from the latest message or fight your scrolling.
- Chat: an embedded JSON example in a message stays text and no longer renders as a generated-result card.
- Sync: a chat wakes up properly after an idle reconnect, instead of leaving sessions stuck as busy.

## [1.13.8] - 2026-06-29

### New

- **Chat: choose what Enter does mid-reply.** A Follow-up behavior setting either steers your message into the agent's current turn or queues it until the turn finishes. It takes over from the old queue-mode toggle (thanks to @bashrusakh).

### Fixes

- Sync: a connected but quiet session, say an agent running a long tool call, stops kicking off a background refresh every 15 seconds (thanks to @tomzx).

## [1.13.7] - 2026-06-28

### Fixes

- Providers: the Add provider form stays open while provider data refreshes or you pick a model in the background. It used to snap back to an existing provider.
- Chat: with tool calls such as Bash and Edit expanded by default, scrolling no longer twitches, and slow scrolling no longer jumps past several messages.

## [1.13.6] - 2026-06-28

### Improvements

- Chat: scrolling stays steady while you send, queue, stream, switch sessions, and load older messages.

## [1.13.5] - 2026-06-27

### Misc

- No notable changes.

## [1.13.4] - 2026-06-27

### New

- Japanese: the interface is available in Japanese (thanks to @yuchi0531).
- Chat: drag a queued message to move it up or down the queue (thanks to @makeittech).

### Improvements

- Models: the model picker keeps your provider groups open and in the order you put them, and Shift+Delete drops a model from recents (thanks to @makeittech).

### Fixes

- Chat: sending a message closes an open question, so the composer no longer keeps the answered prompt on screen (thanks to @tomzx).
- Chat: a conversation pinned to the bottom stays still after you send, and opening an older session lands on the latest message right away.
- Agents: editing an agent on an external OpenCode server no longer says it saved when it did not (thanks to @makeittech).
- Providers: the add-provider form keeps the provider you picked (thanks to @IbrahimKhan12).

## [1.13.3] - 2026-06-24

### New

- Agents: agent settings have thinking variant, temperature, and top-p controls (thanks to @bashrusakh).

### Improvements

- Agents: clearing temperature or top-p removes the override (thanks to @bashrusakh).
- Settings: your font size and padding apply inside the extension (thanks to @Sin991114).

### Fixes

- Chat: picking one of your own skills from the slash menu runs the skill instead of typing its name into the message (thanks to @IbrahimKhan12).
- Chat: a code block in your own message keeps characters like `<` and `->` (thanks to @bashrusakh).
- Chat: Arrow Up opens prompt history again when the cursor sits at the start of the composer.
- Chat: pasting text with an `@` in it no longer pops up file mentions (thanks to @charpeni).
- Chat: switching sessions or loading older messages no longer jumps the conversation backward or makes it wobble (thanks to @herjarsa).
- Sessions: a new session stays with the folder you picked (thanks to @bashrusakh).
- Sessions: pinned sessions and folders stay in the sidebar when a session list comes back empty (thanks to @bashrusakh).
- Settings/Models: per-model visibility and sibling model choices stay saved (thanks to @attilaszasz).
- Settings/Skills: the skills catalog reloads after you change catalog settings (thanks to @gokulkgm).
- Usage: MiniMax M3 and Token Plan usage read the provider's current responses again (thanks to @baruchvitorino).
- Startup: managed OpenCode processes left over from a crash are cleaned up on the next start.

## [1.13.2] - 2026-06-18

### Improvements

- **Chat:** long conversations and big session lists stay smooth while a reply streams in (thanks to @bashrusakh).
- Startup: the extension starts faster, it no longer waits for the default OpenCode config.

### Fixes

- Chat: the last words of a streamed reply are no longer cut off (thanks to @IbrahimKhan12).
- Chat: paragraphs in a reply have space between them again (thanks to @foundryseven).
- Startup: your manual and per-folder model choices survive a restart.

## [1.13.1] - 2026-06-17

### Improvements

- Chat: pinned welcome starters are on screen as soon as a new draft session opens.
- Chat: the context usage indicator is a round progress ring.
- Startup: providers and agents load faster.

### Fixes

- Chat: a reply full of code no longer freezes the page while it highlights.
- Chat: an amount like `$50` stays an amount instead of being read as math.
- Agents: deleting a built-in agent leaves it in place instead of quietly disabling it.
- Agents: deleting an agent whose definition is missing shows an error instead of doing nothing.

## [1.13.0] - 2026-06-15

### New

- Sessions: session rows now use a cleaner single-line layout, and a new control next to "archive all" toggles archived sessions on or off.

### Improvements

- Sessions: the list now groups sessions under their workspace, so pinning sessions and moving them into folders work as expected.
- Chat: custom-answer question textareas resize more steadily while typing (thanks to @bigcoder84).
- Chat/Performance: long conversations now use virtualized rendering to keep large histories responsive.
- Chat/Input: Arrow Up moves the cursor inside multi-line drafts again instead of always opening prompt history.
- Sessions: session menus now include a delete action (thanks to @ShogunPanda).
- Settings/MCP: importing MCP snippets from OpenCode config works again (thanks to @youzini).

### Fixes

- Startup: the extension opens faster — recent sessions, models, providers, and projects appear instantly from cache and refresh in the background, and the loading screen no longer lingers after the interface is ready.
- Startup: requests made while OpenCode is still starting now wait briefly for it to become ready instead of failing, and if OpenCode fails to start the error now includes what it reported.
- Chat/Input: tab-completing a mention no longer changes the selected agent (thanks to @Quat3rnion).
- Sessions: deleting a parent session no longer brings deleted child sessions back into the sidebar (thanks to @panzeyu2013).
- Sessions: switching sessions no longer leaves the chat area blank in some cases (thanks to @panzeyu2013).

## [1.12.4] - 2026-06-11

### New

- Sessions: added an action to archive all sessions (thanks to @jjdubski).
- Workspaces: added multi-root workspace support, including workspace folder switching in the extension (thanks to @mmospanenko).
- Settings: added search across settings pages.
- Chat/UI: added a setting to collapse long user messages.
- Usage: added Cursor quota tracking.
- UI/Localization: added French extension translations (thanks to @pascalandr).

### Improvements

- Agent Manager: creating isolated runs now opens sessions immediately while worktree setup continues in the background.
- Agent Manager: hidden models now stay hidden in multi-model selection controls (thanks to @kjhq).
- Sessions: chat folder assignments now stay in place after reloads.
- Sessions: session and folder rows now have right-click menus for their available actions.
- Chat: table copy actions now include a Markdown format option (thanks to @kjhq).
- Chat: `@agent` mentions in rendered messages now use the primary accent color.

## [1.12.3] - 2026-06-05

### Improvements

- Startup: OpenCode health checks now work with OpenCode 1.15.x.

## [1.12.2] - 2026-06-05

### Improvements

- Startup/Windows: the extension now detects more OpenCode installs from PATH, npm, Scoop, and Chocolatey.
- Chat: prompts sent while creating or switching target sessions now stay attached to the intended workspace directory.
- Files: chat and tool links now handle Windows drive-letter and backslash paths.

## [1.12.1] - 2026-06-03

### New

- Chat: completed turns can now show changed-file chips with per-file additions and deletions, controlled by a new Chat setting.
- Sessions: recent sessions now stay visible inside project groups, and new or worktree sessions stay in the correct project/worktree group.

### Improvements

- Chat: LSP tool calls now show the operation, file, and cursor position more clearly, and JSON tool output can be toggled between formatted and raw views or copied.
- Chat: streaming messages now appear correctly after startup, and activity/status rows show for the active session.
- Sessions: session titles update from live session events, and the extension now consistently loads all existing OpenCode sessions.
- Settings/OpenCode: OpenCode CLI path, update-notification preference, keyboard shortcuts, and protected-session settings now stay saved after changes.
- UI/Time: the time-format preference now applies to chat timestamps, usage reset times, scheduled tasks, passkeys, and usage last-updated times.

### Fixes

- Chat: completed responses no longer lose late-arriving summaries, token counts, errors, structured output, or changed-file details.
- Chat: question cards now show an error or no-longer-pending message when submit or dismiss fails instead of silently doing nothing.
- Chat: the first prompt in a new session no longer gets stuck before sending.

## [1.12.0] - 2026-06-03

### New

- Chat: added customizable draft welcome starters from commands and skills, including guided commands for catch-up, debugging, exploration, and approach comparison.
- Chat: assistant answers now have a dialog for starting a new session from that answer.

### Improvements

- Chat/UI: markdown-rendered user messages now preserve line breaks.
- UI/Theming: chat colors now map more closely to the active editor theme, and the session UI has been refined.
- Reliability/Startup: Restart API Connection now uses the same loading and reload flow as startup.

### Fixes

- Chat/Input: queued messages no longer auto-send before the active session is ready, and thinking-variant choices are preserved for generated messages.

## [1.11.7] - 2026-05-27

### New

- Usage: added a setting to hide prediction rows on usage cards (thanks to @ermanhavuc).

### Fixes

- Chat/Input: selecting an agent now switches to that agent's configured model, and malformed tool diffs no longer break chat rendering (thanks to @Adrian-Eckardt).
- Reliability/Streaming: restored live streaming in the extension.

## [1.11.6] - 2026-05-25

### New

- Settings/Plugins: added a Plugins page for managing opencode plugins, with npm update checks and user/project scopes (thanks to @Quat3rnion).

### Improvements

- Perf: Git repository lookups in the extension now avoid repeating the same Git read commands during refreshes.

## [1.11.5] - 2026-05-25

### New

- Voice: OpenAI-compatible custom speech providers can now use API keys (thanks to @yangyaofei).

### Improvements

- Chat/Input: pending image attachments now show previews, sent image attachments can be cited from assistant messages, and markdown source mode highlights formatting while you type.
- Chat: queued messages now send to the session they were queued from, even if you switch sessions before they are sent.
- Settings/Skills: installed skills are discovered more accurately, skill files opened from tool messages now load correctly, and snippet names keep their canonical casing (thanks to @jkker, @isanchez404).

### Fixes

- Chat/UI: chats keep following the latest response after final task summaries, activity reasoning no longer flashes before settling, and assistant timestamps stay visible on narrow layouts.

## [1.11.4] - 2026-05-22

### New

- Sessions: opening a session now fetches a smaller initial message page, while still expanding enough to show the latest user turn when needed.

### Improvements

- Sessions: switching between chat sessions now keeps less inactive message history in the webview, especially after opening large conversations.
- Chat: task tool results use final task summaries when available instead of repeatedly loading child-session messages.
- Chat: task tool polling in the extension now uses smaller message fetches while subtasks are active or idle.
- Chat: markdown file links now cap path checks in the extension, reducing stalls in messages with many inline paths.
- Chat: the extension header reads only the active session title and latest usage data instead of reacting to the full session list.

## [1.11.3] - 2026-05-19

### New

- Editor Integration: Add to Context now attaches the selected code as context instead of pasting a formatted block into the input.
- Editor Integration: Add File to Chat now attaches selected files instead of inserting file mentions.
- Editor Integration: Add to Context, Add File to Chat, Explain, and Improve Code now target the active session editor when one is open.
- Chat: slash command autocomplete now includes skills and clearer command/type badges.
- Usage: added Wafer.ai quota tracking (thanks to @bowber).

### Improvements

- Chat: session editor tabs now update their title to match the session title.
- Sessions: session rows now include an action to open a chat as editor tab.
- Notifications: completion, question, and permission notifications now use the extension notification settings and shows as multi-platforn native notifications.
- Chat: question cards now include copy buttons for Markdown and JSON (thanks to @robertoberto).

## [1.11.2] - 2026-05-18

### New

- Chat: thinking blocks can now be collapsed, and expanding tool details feels smooth (thanks to @ermanhavuc).

### Improvements

- Chat: reverting or forking messages now keeps file attachments in place, with clearer undo/redo controls (thanks to @youfch, @ermanhavuc).
- Sessions: root project sessions now show up correctly in the session switcher (thanks to @isanchez404).
- Skills: installed skills now match OpenCode's own skill list more closely.

## [1.11.1] - 2026-05-15

### New

- Chat/Sessions: added a session switcher to the chat header.

### Improvements

- Chat/Subagents: opened subagent sessions read-only in the context panel and made subagent chats read-only.
- Usage: quota reset times now display in your local timezone.
- Skills: the skills catalog now keeps the selected source label visible when switching sources (thanks to @kjhq).

### Fixes

- Chat/UI: sorted-mode tool paths animate consistently, and tooltip crashes are guarded defensively.

## [1.11.0] - 2026-05-14

### Improvements

- Chat/Input: queued messages now auto-send one at a time in FIFO order, and model/agent selections persist across reloads (thanks to @lyxxx708, @chutastic).
- Chat/Performance: virtualized more timeline content, deferred heavy tool output, and improved scroll-to-bottom behavior.
- Editor Integration: chat commands now wait for the sidebar webview before sending selections, file mentions, explain prompts, or improve prompts.
- Reliability/Streaming: extension SSE reconnect delays now abort cleanly and disposed chat webviews clean up their live streams.
- Agent Manager: settings changes now sync into Agent Manager views immediately.
- Sessions: archived-session bulk delete now works reliably from the extension sidebar (thanks to @jjdubski).

### Fixes

- Chat/Permissions: restored `@agent` mentions in sent messages and parent-session auto-accept for child-session permissions.
- Editor Integration: active-editor context updates now ignore stale broadcasts.
- UI/Reliability: added smaller fixes for chunk-load recovery, locale retry behavior, stale attachment reads, and accessible session controls (thanks to @isanchez404).

## [1.10.4] - 2026-05-09

### New

- Git/Worktrees: pull-request worktrees can now reuse an existing local branch when it matches the PR head.

### Improvements

- Chat/Input: model, variant, and agent labels collapse better on narrow widths.
- Reliability/Sync: preserved message part update ordering (thanks to @isanchez404).

### Fixes

- Git: deduplicated lightweight and full status refreshes separately, preventing stale or mismatched Git updates during background polling (thanks to @isanchez404).

## [1.10.3] - 2026-05-08

### Improvements

- Chat/Scrolling: rebuilt auto-follow behavior for active responses.
- Chat/UI: tightened scroll-to-bottom behavior and code-block scrolling handoff.
- Skills/Reliability: ignored outdated skills catalog and repo scans.

### Fixes

- Chat/Scrolling: saved scroll positions restore consistently after session switches, hydration, and draft-to-session transitions.
- Chat/Input: fixed attachment-only queued sends, stale attachment restores, stale file-search results, autocomplete tab handling, and focusable removal controls (thanks to @isanchez404).
- Reliability/Sync: reduced stale and duplicate live-state updates across request arrays, retry metadata, streaming indicators, and session status events, cutting unnecessary rerenders and stuck activity states during long-running chats (thanks to @isanchez404).
- Chat/Reliability: added smaller polish fixes for text-selection cleanup (thanks to @isanchez404).

## [1.10.2] - 2026-05-07

### Improvements

- Chat/Reliability: stabilized live turn rendering and session sync caches.
- Terminal: improved Android tablet keyboard handling, including control-key shortcuts, and kept app shortcuts from stealing focus while typing in the terminal (thanks to @Dav1dch).
- Terminal: set a UTF-8 locale for terminal sessions (thanks to @liyiopener).
- Usage: OpenRouter credit balances now avoid misleading percentage displays and use clearer labels across usage views (thanks to @zerone0x).
- Reliability: split the extension into a dedicated app root.

## [1.10.1] - 2026-05-06

### New

- UI/Localization: added Polish interface translations, expanding language support for Polish-speaking users (thanks to @levy52).
- Sessions: added a quick archive action directly on session rows (thanks to @zoubenr).
- Chat/Timeline: added full-text timeline search across user, assistant, and tool messages in a session.

### Improvements

- Chat/Reliability: pending questions now survive session switches and directory eviction.
- Reliability/Sync: aligned session status parsing and reconnect reconciliation (thanks to @vhqtvn).

### Fixes

- Startup/Reliability: configured OpenCode CLI paths are now validated before managed startup, with clearer errors for missing, non-executable, or app-bundle paths.
- Performance/Reliability: reduced duplicate extension initialization, deferred heavier views, lowered managed runtime status overhead, optimized markdown file-link detection, reduced sync recovery payloads, and suppressed expected missing-directory noise.

## [1.10.0] - 2026-05-05

### New

- Chat/UI: added the currently open editor file to chat context (thanks to @daveotero).
- Settings/Behavior: added a dedicated Behavior page with global `AGENTS.md` configuration and response style presets.
- Chat/UI: added a wide layout option.

### Improvements

- Chat/Scrolling: preserved per-session scroll position and kept generated prompts scrolled into view (thanks to @jwcrystal).
- Settings/UI: improved settings scrolling and empty states (thanks to @Yabuku-xD).
- GitHub/MCP: improved fork-aware issue and pull-request listing, PR status handling, and remote MCP header handling (thanks to @corrm, @ricautomation).

### Fixes

- Chat/Streaming: reduced text flicker, preserved first chunks reliably, and kept long agent sessions from hanging during active responses (thanks to @pasta-paul).
- Models/Providers: fixed slash-containing model IDs, refreshed model metadata after OpenCode restarts, and added safer concurrency controls for sessions sharing the same provider (thanks to @yart, @Yabuku-xD).

## [1.9.10] - 2026-04-28

### New

- UI/Localization: added Korean interface translations and default new installs back to English when no language has been chosen (thanks to @An-jinu).
- Usage: added MiniMax and Ollama quota support.

### Improvements

- Chat/Models: unified the model picker with a cleaner selection flow (thanks to @daveotero).
- Chat/UI: improved split-response action placement, error-message alignment, tab close affordances, and overscroll behavior.
- Windows: normalized drive-letter paths in extension webviews (thanks to @sdunfeng).
- Reliability/Startup: hardened managed OpenCode startup, preserved shell PATH reliably, and improved stream/proxy recovery with heartbeat support (thanks to @An-jinu).

### Fixes

- Sessions/Sidebar: fixed stale session, folder, project, and worktree state after mutations, and polished pinned-session indicators (thanks to @corrm, @Yabuku-xD).

## [1.9.9] - 2026-04-26

### New

- UI/Localization: added translated interface strings for Spanish, Brazilian Portuguese, Ukrainian, and Simplified Chinese, with language selection available in extension settings.
- Settings/Appearance: added selectable interface and code fonts with 10 choices each, and reorganized appearance sections.
- Chat/Workflow: added keyboard turn navigation, widened chat content, and introduced a local workspace review slash command.

### Improvements

- Chat/Context: autocomplete and mention results are now easier to scan, with fuller results and clearer active-tab behavior while drafting.
- Chat/Tasks: todo list progress now updates live as task status changes, and task/model status hints are steady during active runs (thanks to @Yabuku-xD).
- Chat/Performance: improved cold start and streaming smoothness with lazy-loaded heavy components, chunk-load recovery, and lower re-render churn in long sessions (thanks to @Yabuku-xD).
- Reliability/Sync: improved reconnect recovery (thanks to @jwcrystal, @vhqtvn).

### Fixes

- Chat/Header: restored context usage in the chat header, kept it tooltip-only, and kept rate-limit usage available in expanded layouts.
- Reliability/Startup: improved managed runtime startup by preserving user PATH and skipping stale session directories.

## [1.9.8] - 2026-04-22

### New

- Chat/Commands: added `/summary` slash command for a non-destructive session summary - optional topic hint after the command focuses the output, and the prompt is customizable under Settings: Magic Prompts.

### Improvements

- Settings/Sync: settings changes now sync reliably with other clients, and sidebar session pagination is steady in larger workspaces.
- Sessions/Folders: folder updates now persist through server-backed APIs.
- UI: refined chat chrome with a cleaner bottom scroll fade and hidden idle tasks row.

### Fixes

- Sessions/Reliability: fixed parent-child session sync during reconnects and navigation (thanks to @jwcrystal).

## [1.9.7] - 2026-04-22

### New

- Chat/Files: you can now drag files and folders from the file tree into chat, with improved `@folder` autocomplete when building prompt context (thanks to @youfch).

### Improvements

- Files: open editors now refresh file content after external changes.
- Settings/MCP: improved MCP auth flow with remote config support and clearer diagnostics (thanks to @daveotero).
- Chat/Questions: single-choice questions now use radio selection.
- Reliability: config resolution now matches OpenCode behavior more closely.
- Reliability/Streaming: strengthened bootstrap and connection recovery paths.

### Fixes

- Sessions/UI: added bulk selection in the sessions sidebar and fixed pinned sessions (thanks to @yart).

## [1.9.6] - 2026-04-17

### New

- Reliability/Streaming: moved to a WebSocket-first message stream with SSE fallback and added safer compression handling.
- Chat/Export: added export session as Markdown and improved empty-state/export behavior (thanks to @coldbrow).
- Chat/Markdown: added LaTeX rendering support for clearer math and technical notation in rendered messages (thanks to @ricautomation).

### Improvements

- Reliability: improved startup shell detection to avoid false OpenCode discovery on POSIX login shells.
- Sessions/Worktrees: enforced worktree isolation for session and Git flows.

## [1.9.5] - 2026-04-14

### New

- Usage: added Zhipu AI Coding Plan tracking (thanks to @cainiao1992).

### Improvements

- Sync/Performance: optimized multi-session streaming with per-directory queues, event coalescing, and parts-gap recovery for steady live updates in busy workspaces (thanks to @jwcrystal).
- Task/Reliability: hardened subagent session resolution and polling lifecycle handling to reduce silent task failures (thanks to @jwcrystal).
- Sessions/UI: kept active sessions visible in Recent, auto-expanded parent groups for subagent sessions, and hid empty archived/folder sections (thanks to @jwcrystal).

### Fixes

- Chat/Tool Output: added an interactive tree viewer for structured outputs and fixed JSON quote rendering (thanks to @yaozhenghangma).
- Chat/Reliability: fixed question-tool content disappearing after refresh (thanks to @jwcrystal).
- Models: restored model-variant compatibility with newer OpenCode runtimes (thanks to @Chi-square-test).

## [1.9.4] - 2026-04-07

### New

- Reliability/Streaming: added loading timeouts, automatic SSE reconnect, and message retry behavior (thanks to @jwcrystal).

### Improvements

- Reliability/Windows: normalized workspace path handling in SSE event lookup to keep live session updates working consistently on Windows (thanks to @widipa).
- Chat/Performance: reduced streaming re-render fanout and status-row churn for smooth long responses in the editor panel.
- Chat/Tool Output: LSP diagnostics now render directly in tool output (thanks to @yulia-ivashko).

### Fixes

- Sessions/Streaming: fixed directory-aware event routing and post-reconnect session resync (thanks to @daveotero, @jwcrystal).
- Chat/Scrolling: fixed scroll jumps and stabilized follow-to-latest behavior.
- Models: added defensive fallbacks for missing model cost/capability metadata (thanks to @Chi-square-test).

## [1.9.3] - 2026-03-01

### New

- Files/Markdown: added filesystem stat support in the extension bridge to validate markdown targets reliably before file handling flows (thanks to @geekifan).
- Chat/Models: added arrow-key navigation for thinking-mode selection in model controls (thanks to @daveotero).
- Chat/JSON: added an interactive JSON tree viewer with collapse/expand controls and richer color cues for easier inspection of large structured outputs (thanks to @nguyenngothuong).

### Improvements

- Security/Chat: user messages now escape raw HTML by default (thanks to @kalac2232).
- Sessions/Drafts: draft chat config now stays aligned with the active draft target directory.
- Chat: improved error message readability with clearer styling and safer word-wrapping (thanks to @nguyenngothuong).
- Reliability/Streaming: proxy handling now normalizes identity encoding, strips conflicting compression headers and hop-by-hop response headers, and suppresses expected upstream SSE close errors to reduce noisy disconnect failures (thanks to @jwcrystal, @Jovines, @JiwaniZakir, @shekohex).

### Fixes

- Usage: added ZhipuAI quota tracking and fixed MiniMax coding-plan plus GitHub Copilot overusage calculations (thanks to @kalac2232, @baruchvitorino, @ebrainte).

## [1.9.2] - 2026-03-31

### Improvements

- Chat/Performance: overhauled live sync and streaming updates to reduce re-render churn and keep long-running chats smooth in the extension.
- Sessions/UI: refined sidebar behavior with cleaner spacing, better truncation/tooltips, and a resizable sessions pane for tighter workspace control.
- Chat/Editor integration: improved Explorer file insertion.
- Reliability: startup now queues bridge and stream requests until the API is ready.
- Chat: reasoning content now renders through the markdown pipeline.

## [1.9.1] - 2026-03-20

### New

- Usage: added MiniMax Weekly quota provider support (thanks to @nzlov).

### Improvements

- Sessions: sidebar lists now keep sessions visible in both Recent and Project sections for easier session discovery (thanks to @nguyenngothuong).
- Chat/GitHub: linked issues and pull requests now show as user-message attachments and open reliably through extension-safe external link handling.
- Settings/MCP: adding MCP servers now correctly respects user scope.
- Reliability: managed server startup now imports login-shell environment values and normalizes Windows paths to reduce session-loading mismatches and proxy-related connection issues.

## [1.9.0] - 2026-03-20

### New

- Chat/Permissions: added per-session permission auto-accept controls to reduce repetitive approval prompts in iterative workflows.

### Improvements

- Navigation/UI: refreshed the extension shell with a redesigned sidebar, clearer hierarchy, and cleaner session grouping.
- Chat/Performance: reduced streaming overhead and update churn for smooth long responses, steady activity rendering, and fewer UI stalls in heavy sessions.
- Chat: improved follow-to-latest behavior and timeline stability.
- Reliability/Windows: normalized workspace drive-letter handling and hid background process windows to reduce startup/session mismatches (thanks to @zerone0x).

### Fixes

- Sessions: improved sidebar organization and interaction stability, including fixes for drag/rename edge cases during quick session management.

## [1.8.7] - 2026-03-13

### Improvements

- No notable changes.

## [1.8.6] - 2026-03-13

### New

- Chat/Settings: added richer render controls with sorted/live modes, compact Activity previews, and default-open Bash/Edit options.

### Improvements

- Chat: completed a turn-based render pipeline with steady streaming, smooth auto-follow, and more stable activity/tool progress behavior during long responses.
- Reliability: switched extension event streaming to an SDK-based SSE proxy path.
- Settings: chat display changes now sync across sidebar and session editor views right away.
- Sessions: worktrees with active chats are now prioritized in the sidebar (thanks to @GhostFlying).
- Sessions: archived-session behavior in the extension is now scoped to the active workspace with cleaner sidebar presentation.
- Diff: edit result comparisons now preserve original file extensions in virtual "before" files.

### Fixes

- Chat: fixed modified Enter send shortcuts in narrow layouts (thanks to @eengad).
- Chat: fixed queue button behavior and focus-mode composer sizing (thanks to @shekohex).

## [1.8.5] - 2026-03-04

### Improvements

- Chat/Files: edit-style tool results now open in a VS Code diff editor with focus on the first changed line.
- Chat: improved focus-mode input layout.
- UI/Theming: aligned startup/loading branding with the active theme for a more consistent look during connection and auth states.
- Reliability: improved startup recovery for provider/model/agent loading.

### Fixes

- Settings: removed duplicate chat display options from Appearance and hid extension-irrelevant sections.

## [1.8.4] - 2026-03-04

### New

- Chat: added Save as image support for assistant messages.
- Chat: added a new `Changes` tool-output mode that opens edit/write/patch results by default while keeping activity easier to scan.
- Chat/GitHub: added Attach menu support for linking pull requests into your draft with picker-based selection and attached PR context.
- Shortcuts/Models: added favorite-model cycling shortcuts (thanks to @iamhenry).

### Improvements

- Chat Activity: active tools now appear immediately and continue updating in collapsed view (thanks to @nelsonPires5).
- Chat: file references in assistant responses are now clickable (including line targets).
- Chat/Files: improved `@` file mentions with active-project scoping and more consistent search behavior.
- Chat: simplified attachment actions with a direct Attach files flow.
- Chat: improved sticky user-message behavior with bounded height and internal scrolling.
- UI: interactive controls now consistently use pointer cursors.

## [1.8.3] - 2026-03-02

### New

- Chat: added user-message display options for plain-text rendering and sticky headers, with preferences persisted in settings.

### Improvements

- Chat: model picker provider groups are now collapsible, with expanded/collapsed state remembered.

### Fixes

- Chat: improved code block readability with cleaner header actions, restored horizontal scrolling, and themed highlighting in markdown and tool output (thanks to @nelsonPires5).

## [1.8.2] - 2026-03-01

### Improvements

- Chat: improved message readability with cleaner tool/reasoning rendering and more polished markdown presentation in long responses.
- Chat Activity: timing display is now less noisy, with detailed end timestamps shown on hover when you need them (thanks to @nelsonPires5).
- Reliability: improved panel visibility/reconnect handling.

### Fixes

- Reliability: fixed live-streaming edge cases for event endpoints with query/trailing-slash variants.

## [1.8.1] - 2026-02-28

### Improvements

- No notable changes.

## [1.8.0] - 2026-02-28

### New

- Chat: added drag-and-drop file attachments (thanks to @Asuta).
- Usage: added MiniMax coding-plan quota provider support (thanks to @nzlov).
- Usage: added Ollama Cloud quota provider support (thanks to @iamhenry).

### Improvements

- Chat: improved long-session performance with virtualized message rendering, smooth scrolling, and more stable behavior in large histories (thanks to @shekohex).
- Chat: enabled markdown rendering in user messages for clearer formatted prompts and notes (thanks to @haofeng0705).
- Chat: pasted absolute paths are now treated as normal messages.
- Chat: edit tools now use improved diffs (thanks to @shekohex).
- UI: improved long filename handling in file-mention autocomplete (thanks to @haofeng0705).

### Fixes

- Chat: fixed queued send behavior for inactive sessions to reduce accidental sends to the wrong conversation.

## [1.7.5] - 2026-02-25

### Improvements

- Sessions: improved switching performance.

### Fixes

- Chat: fixed cases where messages could duplicate or disappear during active conversations.

## [1.7.4] - 2026-02-24

### New

- Chat: added fullscreen Mermaid preview, improved default thinking-variant persistence, and hardened file-preview safety checks for a more predictable message experience (thanks to @yulia-ivashko).
- Settings: added an MCP config manager UI to simplify editing and validating MCP server configuration (thanks to @nguyenngothuong).
- Chat: added C, C++, and Go language support for syntax-aware rendering in code-heavy workflows (thanks to @fomenks).

### Improvements

- Settings: redesigned the settings workspace with flatter, more consistent layouts.
- Settings: grouped agents/skills navigation by subfolder to make larger setups easier to manage (thanks to @nguyenngothuong).
- Chat: draft text now persists per session, and the input supports an expanded focus mode for longer prompts (thanks to @nguyenngothuong).
- Sessions: expanded folder management with subfolders, cleaner organization controls, and clearer delete confirmations (thanks to @nguyenngothuong).
- Chat Activity: improved Structured Output tool rendering with dedicated title/icon, clearer result descriptions, and more reliable detailed expansion defaults.
- Reliability: aligned file read/raw endpoint safety checks with other runtimes (thanks to @yulia-ivashko).

### Fixes

- Chat: improved streaming smoothness and runtime stability with buffered updates and reliability fixes.

## [1.7.3] - 2026-02-21

### New

- Sessions: added custom folders to group chat sessions, with move/rename/delete flows and persisted collapse state per project (thanks to @nguyenngothuong).
- Settings: added customizable keyboard shortcuts for chat actions, panel toggles, and services (thanks to @nelsonPires5).

### Improvements

- Notifications: improved agent progress notifications and permission handling to reduce noisy prompts during active runs (thanks to @nguyenngothuong).
- UI: unified clipboard copy behavior.
- Reliability: improved startup environment detection by capturing login-shell environment snapshots.
- Reliability: refactored OpenCode config/auth integration into domain modules for steady provider auth and command loading flows (thanks to @nelsonPires5).

## [1.7.2] - 2026-02-20

### New

- UI: added Plan view in the context sidebar panel for quicker access to plan content while you work (thanks to @nelsonPires5).

### Improvements

- Chat: question prompts now guide you to unanswered items before submit.
- Chat: improved streaming activity rendering and session attention indicators.
- Reliability: provider auth failures now show clearer re-auth guidance when tokens expire (thanks to @yulia-ivashko).

### Fixes

- Chat: fixed auto-send queue to wait for the active session to be idle before sending.
- Settings: model variant options now refresh correctly in draft/new-session flows, avoiding stale selections.

## [1.7.1] - 2026-02-18

### New

- Chat: added a shell mode triggered by leading `!`, with inline output visibility/copy.

### Improvements

- Chat: slash commands now follow server command semantics (including multiline arguments).
- Chat: improved delegated-task clarity with richer subtask bubbles, better task-detail rendering, and parent-chat surfacing for child permission/question requests.
- Chat: improved `@` mention autocomplete by prioritizing agents and cleaning up ordering.
- Skills: discovery now uses OpenCode API as the source of truth with safer fallback scanning.
- Skills: upgraded editing/install UX with better code editing, syntax-aware related files, and clearer location targeting across user/project .opencode and .agents scopes.

## [1.7.0] - 2026-02-17

### Improvements

- Chat: improved live streaming responsiveness with part-delta updates and smarter auto-follow scrolling during generation.
- Chat: Mermaid diagrams now render directly in messages, with quick copy/download actions for easier reuse.
- Reliability: managed runtime startup now rotates secure auth credentials and hardens API proxy auth forwarding for safer local connections (thanks to @yulia-ivashko).
- Reliability: extension startup/shutdown handling is more predictable.

## [1.6.9] - 2026-02-16

### New

- Usage: added NanoGPT quota provider support and improved provider wiring for steady usage reporting (thanks to @nelsonPires5).

### Improvements

- Agent Manager / Worktrees: switched to an upstream-first worktree flow with stronger branch tracking (thanks to @yulia-ivashko).
- UI: compact model info in selection (price + capabilities) (thanks to @nelsonPires5).

## [1.6.8] - 2026-02-12

### New

- Chat: added drag-and-drop attachments with inline image previews.

### Improvements

- Chat: improved picker search with fuzzy matching on names and descriptions to speed up finding the right agent/model.
- Usage: corrected Gemini and Antigravity quota source mapping and labels (thanks to @gsxdsm).
- Usage: remaining-quota mode now inverts usage markers (thanks to @gsxdsm).

### Fixes

- Sessions: fixed previously selected session carry-over when navigating from chat / session draft and list of sessions.

## [1.6.7] - 2026-02-10

### New

- Added usage pace and prediction indicators in the header and settings to make quota usage trends easier to track (thanks to @gsxdsm).
- Added confirmation dialogs for destructive delete/reset actions to reduce accidental mistakes in settings and management flows.

### Improvements

- Improved reliability for message loading.

## [1.6.6] - 2026-02-09

### Fixes

- Usage: added per-model quota groups in the header and fixed provider dropdown scrolling for easier usage tracking (thanks to @nelsonPires5, @gsxdsm).
- Reliability: fixed OpenCode auth pass-through/proxy behavior to reduce failed extension requests (thanks to @gsxdsm).

## [1.6.5] - 2026-02-06

### New

- Settings: added an OpenCode CLI path override.
- Chat: added arrow-key prompt history and an optional setting to persist input drafts between restarts (thanks to @gsxdsm).

### Improvements

- Chat: thinking/reasoning blocks now render consistently, and justification visibility settings now apply reliably (thanks to @gsxdsm).
- Reliability: improved OpenCode binary resolution and HOME-path handling for steady local startup.

## [1.6.4] - 2026-02-05

### New

- Chat: select text in messages to quickly add it to your prompt or start a new session (thanks to @gsxdsm).

### Improvements

- Usage: expanded quota tracking with more providers (including GitHub Copilot) and a provider selector dropdown (thanks to @gsxdsm, @nelsonPires5).

### Fixes

- Improved Windows PATH resolution and cold-start readiness checks to reduce "stuck loading" sessions.

## [1.6.3] - 2026-02-02

### Improvements

- Improved server health check with the proper health API endpoint and increased timeout for steady startup (thanks to @wienans).

### Fixes

- Settings dialog no longer persists open/closed state across extension restarts.

## [1.6.2] - 2026-02-01

### New

- Added multi-provider quota dashboard in settings to monitor API usage across OpenAI, Google, and z.ai with auto-refresh support (thanks to @nelsonPires5).

### Improvements

- Enhanced token-based theming system.

## [1.6.1] - 2026-01-30

### New

- Chat: added Apply Patch tool support for opening files in editor.

### Improvements

- Chat: improved compact controls on narrow panels with a unified drawer for model and tool options.
- Reliability: improved event stream reconnection when the panel is hidden/shown or VS Code regains focus.

### Fixes

- Chat: added Stop button to cancel generation mid-response.

## [1.6.0] - 2026-01-29

### New

- Added message stall detection with automatic soft resync.

### Improvements

- Session activity status now updates reliably even when the extension panel is hidden or collapsed.

### Fixes

- Fixed "Load older" button in long sessions with proper progressive pagination.

## [1.5.9] - 2026-01-28

### Improvements

- Agent Manager: migrated to the OpenCode SDK worktree implementation; sessions in worktrees are now completely isolated.

### Fixes

- Agent Manager: worktree setup commands are now persistent per project and automatically saved/restored.

## [1.5.8] - 2026-01-26

### New

- Plans: added new Plan/Build mode switching support.
- Activity: added a text-justification setting for activity summaries (thanks to @iyangdianfeng).

### Improvements

- Chat: linkable mentions, better wrapping, and markdown/scroll polish in messages.
- Skills: ClawdHub catalog now pages results and retries transient failures.
- Performance: faster chat rendering for busy sessions.

### Fixes

- Diff: fixed Chrome scrolling in All Files layout.
- Reliability: file lists and message sends handle missing directories and transient errors better.

## [1.5.7] - 2026-01-24

### Improvements

- No notable changes.

## [1.5.6] - 2026-01-24

### New

- GitHub: added backend support for PRs/issues workflows; UI comes later.

## [1.5.5] - 2026-01-23

### Improvements

- Settings: agent and command overrides now prefer plural directories while still honoring legacy singular folders.
- Skills: installs now target plural directories while still recognizing legacy singular folders.

## [1.5.4] - 2026-01-22

### Improvements

- Apply Patch tool now shows a diff preview.
- Settings: manage provider configuration files directly from the extension.

## [1.5.3] - 2026-01-20

### Improvements

- Chat: improved session switching with more stable scroll anchoring.
- Chat: the collapsed Activity view now shows the latest 6 tools by default.
- Chat: updated accent color derivation to better match editor themes.
- Performance: improved filesystem/search speed and general stability (thanks to @TheRealAshik).
- Files: adjusted default visibility for hidden/dotfiles to be visible and gitignored entries to be hidden.

## [1.5.2] - 2026-01-17

### Improvements

- Chat: optimized message loading for opening sessions.
- Layout: tuned responsive breakpoint and server readiness timeout for steady startup.
- Reliability: improved OpenCode process cleanup to reduce orphaned servers.

## [1.5.1] - 2026-01-16

### Improvements

- No notable changes.

## [1.5.0] - 2026-01-16

### New

- Layout: added responsive expanded layout showing sessions sidebar + chat side-by-side when extension is wide enough (≥700px).
- Layout: extension now opens to sessions list instead of new session draft.

### Improvements

- Improved OpenCode server management to ensure it initializes within the workspace directory.
- Enhanced extension startup with context-aware readiness checks for the current workspace.
- Layout: compact header with reduced padding.
- Settings: hidden Git Identities tab, Git section, and Diff view settings (not applicable to VS Code).
- Settings: hidden project switcher dropdown (VS Code uses workspace).
- Shortcuts: disabled worktree session creation with shortcuts (Ctrl+Shift+N now opens standard session).

### Fixes

- Fixed orphaned OpenCode processes not being cleaned up on restart or exit.
- Session tabs: fixed opening new session in editor tab; title bar button now opens new session tab, sidebar button opens current or new session.

## [1.4.9] - 2026-01-14

### New

- Added session editor panel to view sessions alongside files.

### Improvements

- Improved server connection reliability with multiple URL candidate support.
- Upload: increased attachment size limit to 50MB with automatic image compression to 2048px for large files.

## [1.4.8] - 2026-01-14

### New

- Stability: added graceful shutdown handling for the server process (thanks to @vio1ator).

### Improvements

- Chat: sidebar sessions are now automatically sorted by last updated date (thanks to @vio1ator).
- UI: todo lists and status indicators now hide automatically when all tasks are completed (thanks to @vio1ator).
- Reliability: improved project state preservation on validation failures (thanks to @vio1ator) and refined server health monitoring.

### Fixes

- Chat: fixed edit tool output and added turn duration.

## [1.4.7] - 2026-01-10

### New

- Skills: added ClawdHub integration as built-in market for skills.

## [1.4.6] - 2026-01-09

### New

- Chat: added question tool support with a rich UI for interaction.

### Improvements

- Switched OpenCode CLI management to the SDK.
- Input: removed auto-complete and auto-correction.
- Shortcuts: switched the agent cycling shortcut from Shift+Tab back to Tab.

## [1.4.5] - 2026-01-08

### New

- Chat: added support for model variants (thinking effort).
- Skills: added autocomplete for skills on "/" when it is not the first character in input.
- Autocomplete: added scope badges for commands/agents/skills.
- MCP: added the ability to dynamically enable or disable configured MCP servers.

### Improvements

- Shortcuts: switched the agent cycling shortcut from Tab to Shift+Tab.
- Compact: changed `/summarize` to `/compact` and moved compaction to the SDK.

## [1.4.4] - 2026-01-08

### New

- Agent Manager: added "Copy Worktree Path" action in the more menu (thanks to @wienans).
- Worktrees: added session creation flow with loading screen, auto-create worktree setting, and setup commands management.
- Settings: added ability to create new session in worktree by default.
- Projects: added multi-project support with per-project settings for agents/commands/skills.

### Improvements

- Agent Manager / Multi Run: select agent per worktree session (thanks to @wienans).
- Agent Manager / Multi Run: worktree actions to delete group or individual worktrees, or keep only selected one (thanks to @wienans).
- Session sidebar: refactoring with unified view for sessions in worktrees.
- Event stream: improved SSE with heartbeat management, permission bootstrap on connect, and reconnection logic.

### Fixes

- Chat: fixed IME composition for CJK input to prevent accidental send (thanks to @madebyjun).
- Model selector: fixed dropdowns not responding to viewport size.

## [1.4.3] - 2026-01-04

### New

- Added Agent Manager panel to run the same prompt across up to 5 models in parallel (thanks to @wienans).
- Added permission prompt UI for tools configured with "ask" in opencode.json, showing requested patterns and "Always Allow" options (thanks to @aptdnfapt).
- Added "Open subAgent session" button on task tool outputs to quickly navigate to child sessions (thanks to @aptdnfapt).

### Improvements

- Improved activation reliability and error handling.

## [1.4.2] - 2026-01-02

### New

- Added timeline dialog (`/timeline` command or Cmd/Ctrl+T) for navigating, reverting, and forking from any point in the conversation (thanks to @aptdnfapt).
- Added `/undo` and `/redo` commands for reverting and restoring messages in a session (thanks to @aptdnfapt).
- Added fork button on user messages to create a new session from any point (thanks to @aptdnfapt).

### Improvements

- Migrated to OpenCode SDK v2 with improved API types and streaming.

## [1.4.1] - 2026-01-02

### New

- Added the ability to select the same model multiple times in multi-agent runs for response comparison.
- Model selector now includes search and keyboard navigation.
- Added revert button to all user messages (including first one).
- Added HEIC image support for file attachments with automatic MIME type normalization for text format files.

### Improvements

- Only show the main Worktree in the Chat Sidebar (thanks to @wienans).
- Terminal: improved terminal performance and stability by switching to the Ghostty-based terminal renderer.

## [1.4.0] - 2026-01-01

### New

- Added the ability to run multiple agents from a single prompt, with each agent working in an isolated worktree.
- Worktrees: new branch creation can start from a chosen base; remote branches are only created when you push.

### Improvements

- Default location is now the right secondary sidebar in VS Code, and the left activity bar in Cursor/Windsurf; navigation moved into the title bar (thanks to @wienans).
- Sidebar: improved readability for sticky headers with a dynamic background.

### Fixes

- Chat: now shows clearer error messages when agent messages fail.

## [1.3.9] - 2025-12-30

### New

- Added skills management to settings with the ability to create, edit, and delete skills.
- Added Skills catalog functionality for discovering and installing skills from external sources.
- Added right-click context menu with "Add to Context," "Explain," and "Improve Code" actions (thanks to @wienans).

## [1.3.8] - 2025-12-29

### New

- Added queued message mode with chips, batching, and idle auto‑send (including attachments).
- Added queue mode toggle to settings (chat section).

### Improvements

- Refactored Agents/Commands management with ability to configure project/user scopes.

### Fixes

- Fixed scroll position persistence for active conversation turns across session switches.

## [1.3.7] - 2025-12-28

### New

- Added responsive tab labels in settings header (icons only at narrow widths).
- Introduced enhanced extension settings with dynamic layout based on width.

### Improvements

- Redesigned Settings as a full-screen view with tabbed navigation.
- ESC key now closes settings.
- Improved session activity status handling and message step completion logic.

## [1.3.6] - 2025-12-27

### New

- Added the ability to manage (connect/disconnect) providers in settings.

### Improvements

- Adjusted auto-summarization visuals in chat.

## [1.3.5] - 2025-12-26

### New

- Added settings for choosing the default model/agent to start with in a new session.

### Improvements

- Improved file search with fuzzy matching capabilities.
- Improved provider loading reliability during workspace switching.

### Fixes

- Fixed workspace switching performance and API health checks.
- Fixed session handling for non-existent worktree directories.

## [1.3.4] - 2025-12-25

### Improvements

- Improved type checking and editor integration.

## [1.3.3] - 2025-12-25

### New

- Added an animated loading screen and introduced command for status/debug output.

### Improvements

- Chat UI: improved agent activity status behavior and reduced image thumbnail sizes.

### Fixes

- Fixed startup, more reliable OpenCode CLI/API management, and stabilized API proxying/streaming.
- Fixed session activity tracking.
- Fixed directory path handling (including `~` expansion) to prevent invalid paths and related Git/worktree errors.
- Chat UI: improved turn grouping/activity rendering and fixed message metadata/agent selection propagation.

## [1.3.0] - 2025-12-21

### New

- Added revert functionality in chat for user messages.

### Improvements

- Updated user message layout/styling.
- Improved header tab responsiveness.
- Adjusted extension theme mapping and model selection view.
- Polished file autocomplete experience.

### Fixes

- Fixed bugs with new session creation when the extension initialized for the first time.

## [1.2.9] - 2025-12-20

### Improvements

- Session auto‑cleanup feature with configurable retention.
- Optimization for long sessions.

## [1.2.6] - 2025-12-19

### New

- Added write/create tool preview in permission cards with syntax highlighting.

### Improvements

- More descriptive assistant status messages with tool-specific and varied idle phrases.

## [1.2.5] - 2025-12-19

### Improvements

- Polished chat experience for longer sessions.
- Smoother session rename experience.

## [1.2.2] - 2025-12-17

### Improvements

- Agent Task tool now renders progressively with live duration and completed sub-tools summary.
- Unified markdown rendering between assistant messages and tool outputs.
- Reduced markdown header sizes.

## [1.2.1] - 2025-12-16

### Improvements

- Todo task tracking: collapsible status row showing AI's current task and progress.
- Switched "Detailed" tool output mode to only open critical tools (task, edit, write, etc.).

## [1.2.0] - 2025-12-15

### Improvements

- Favorite & recent models for quick access in model selection.
- Tool call expansion settings: collapsed, activity, or detailed modes.
- Font size & spacing controls (50-200% scaling) in Appearance Settings.
- Settings page access within extension.

## [1.1.6] - 2025-12-15

### Improvements

- Redesigned password-protected session unlock screen.

## [1.1.5] - 2025-12-15

### New

- Added fuzzy search for file mentions with `@` in chat.

### Improvements

- Improved file attachment performance.
- Optimized input area layout.

## [1.1.4] - 2025-12-15

### Improvements

- Flexoki themes for Shiki syntax highlighting for consistency with the app color schema.
- Enhanced extension theming with editor themes.

## [1.1.2] - 2025-12-13

### New

- Added feedback messages for "Restart API Connection" command.

### Improvements

- Moved extension to activity bar (left sidebar).
- Removed redundant commands.
- Enhanced UserTextPart styling.

## [1.1.0] - 2025-12-13

### New

- Added assistant answer fork flow to start new sessions with inherited context.
- Initial VS Code extension release with editor integration: file picker, click-to-open in tool parts.

### Improvements

- Improved scroll performance.
