# Changelog

<!-- Legacy copy for app versions up to 1.22.1, which fetch this file for their update notes. Generated from changelog/*.md while it exists; delete it after 2026-09-19 and nothing will recreate it. -->

## [1.22.2] - 2026-09-05

### New

- **VS Code: comments on code.** Select lines, click the `+` in the gutter or right-click → OpenChamber → Add Comment, and write your note. It stays pinned to the code and goes out with your next message as a context card. Works in diffs too (thanks to @felipegenef).
- Chat: prompt history. Arrow up and down in the composer bring back your earlier prompts, attachments included, and the history survives a reload. It covers the current session; Settings → Chat can widen it to every project on this server and set how many prompts to keep, 40 by default (thanks to @mattv8).
- Chat: an "Enter sends" switch in Settings → Chat. On, Enter sends and Shift+Enter adds a line; off, the other way round. Ctrl/Cmd+Enter always sends. Nothing changes until you flip it (thanks to @claymor333).
- Server: `OPENCHAMBER_CHATS_DIR` moves the folder that holds chats without a project, for setups where OpenCode runs as a different user (thanks to @steffenmaechtel).
- CLI: on Linux, `openchamber startup enable` warns when the service would stop at logout and shows the `loginctl` command that keeps it running (thanks to @IbrahimKhan12).
- Project actions in worktrees: a session in a worktree can use the parent project's saved actions (thanks to @mattv8).
- VS Code: the extension is available in Turkish (thanks to @fitzgpt).

### Improvements

- **Project actions:** the running state of a saved action is reliable now. It shows as running only while the command is really running, every device sees the same state, and the sidebar shows which project has something running (thanks to @mattv8).
- Chat: Markdown tables are readable again, columns take the width their content needs (thanks to @ChangeHow).
- Chat: the Summary, Tree, or Raw view you pick for a JSON tool result is remembered for every JSON card and after a reload (thanks to @karimodm).
- Mobile: with a draft typed, the collapsed composer always has a send button. While the agent is working, that button queues the message (thanks to @ChangeHow).
- Server: OpenCode config paths respect `XDG_CONFIG_HOME` (thanks to @travisdoherty).
- VS Code: a fresh install uses VS Code's language until you choose one in Settings.
- Updates: the update dialog shows each new release with its title and its New, Improvements, and Fixes groups.

### Fixes

- **Settings/Providers:** editing a custom provider keeps all of its model settings, and VS Code saves the protocol you chose (thanks to @hehuaiyu).
- Sessions: opening a session from a deleted worktree moves it back to the project (thanks to @yulia-ivashko).
- Sessions: restoring an archived session from a deleted worktree moves it back to the project (thanks to @mattv8 and @yulia-ivashko).
- Sidebar: a missing worktree stays visible with a warning until you remove it (thanks to @yulia-ivashko).
- Sessions: forks, side threads, and subagents keep working after their original chat is deleted (thanks to @yulia-ivashko).
- Chat: huge patches in tool cards open without freezing the page (thanks to @karimodm).
- Files: an open file stops flickering through reloads when nothing changed, and an edit made in another app shows up in place while your unsaved changes stay (thanks to @IbrahimKhan12).
- Chat: pressing Enter to confirm text on a Japanese, Chinese, or Korean keyboard no longer sends a comment by accident (thanks to @ChangeHow).
- Chat: a queued slash command with attached context is delivered correctly, and the "Queued messages" card disappears after the last message goes out.
- Goal Mode: when a reply is cut off by the length limit, the goal continues, and Resume gives it another try (thanks to @bashrusakh).
- Sessions: subagent sessions are found in projects with more than 200 sessions (thanks to @bashrusakh).
- Server: the terminal works in the Docker image, and non-Latin text renders correctly there (thanks to @yulia-ivashko).
- CLI: on Windows, `openchamber` starts the server under Bun when Bun is installed.
- VS Code: on Windows, the status command and adding a folder to the workspace handle drive-letter case correctly (thanks to @pttydou).
- VS Code: permission auto-accept works again with the stable OpenCode (thanks to @bashrusakh).

## [1.22.1] - 2026-09-04

### New

- **Message queue:** messages you queue while a session is busy are now sent by the OpenChamber server. They go out even if you close the tab that queued them, and every device shows the same queue.
- **Git:** switching branches with uncommitted changes now stops at a dialog to commit or revert first, with an optional push. A failed push cancels the switch (thanks to @yulia-ivashko).
- Chat: the plus button inside a chat opens a new chat draft (thanks to @yulia-ivashko).
- Git: the mobile Changes view has a branch picker (thanks to @yulia-ivashko).
- Settings: Fixel Text is available as an interface font.
- Usage: exe.dev usage windows are tracked.
- Desktop: dev server previews work over the private relay.

### Improvements

- **OpenCode Go:** every request OpenChamber sends on its own, such as commit messages, pull request text, recaps and follow-ups, walkthroughs, Goal Mode checks, notes, and usage, now carries the `x-opencode-session` header OpenCode Go requires from 6 September. Chat traffic already had it. Update before that date if you use OpenCode Go.
- Chat: a queued message keeps its attached context, file mentions, and skill, and editing it brings them back to the composer.
- Worktrees: archiving a worktree's sessions is much faster, about a second for 121 sessions instead of fifteen. Archiving several sessions picked in the sidebar is just as fast (thanks to @yulia-ivashko).
- MCP: a server that failed to start or lost its connection reconnects on its own, waiting up to thirty seconds between tries. Disabled servers and ones waiting for a login are left alone. Web and Desktop only.
- Git: the branch picker lists recent branches and marks the ones with unpushed commits (thanks to @yulia-ivashko).
- Git: a draft over a directory with uncommitted changes shows a warning on its branch selector (thanks to @yulia-ivashko).
- Git: status refreshes after a tool finishes a change or a worktree changes (thanks to @yulia-ivashko).
- Chat: a new session opens on the Chat or Project side you used last (thanks to @yulia-ivashko).
- Sessions: starting a rename selects the whole title (thanks to @yulia-ivashko).
- Settings: new installs start on the OpenChamber light and dark themes. An existing Flexoki choice is kept.
- Desktop: the instance switcher keeps its statuses between opens, never shows the connected instance as checking, waits up to fifteen seconds for a relay instance before calling it unreachable, and shows the full instance name.

### Fixes

- Worktrees: removing a worktree no longer freezes the interface. It runs in the background with a progress toast (thanks to @yulia-ivashko).
- Worktrees: a worktree created from a branch behind its upstream now fetches first and branches from the remote (thanks to @jtatum).
- Worktrees: the New Worktree dialog keeps what you typed when the worktree list changes while it is open (thanks to @yulia-ivashko).
- Worktrees: a removed worktree leaves the sidebar under every project it was listed in (thanks to @yulia-ivashko).
- Git: status no longer flashes half-finished changes while a new worktree runs its setup commands (thanks to @yulia-ivashko).
- Chat: starting an isolated-worktree session from an answer picks the right project when the open session already lives in a worktree (thanks to @yulia-ivashko).
- Chat: resizing the window no longer snaps an idle reader back to the end of the conversation.
- Thinking effort: picking Default sticks after a send and across agent or session switches, and a reopened session restores the effort its last message used (thanks to @yulia-ivashko).
- Settings: the theme no longer flips when you switch sessions across directories, and missing theme fields keep your current preference (thanks to @kydorn).
- Terminal: text no longer renders wrong until you resize the terminal, and terminals connect on servers running under Bun.
- Server: a browser on https behind an HTTP proxy hop is no longer rejected as a mismatched origin.
- Sidebar: the project label no longer shifts when its hover actions appear.
- Desktop: switching instances clears the previous instance's Linear and GitHub logins, quotas, MCP status, skills, and memory.
- Turkish interface: the missing Git repository discovery labels are back (thanks to @kydorn).

### Misc

- Settings → Integrations no longer offers the Claude Code and Cursor plugin installs. It now holds GitHub and Linear.

## [1.22.0] - 2026-08-30

### New

- **Linear:** connect a workspace in Settings → Integrations, browse and filter issues, and start a session or worktree from an issue. OpenChamber reports session progress back to Linear and can attach an issue to your next message (thanks to @AlexKutas).
- **Git:** a project with several repositories can switch between them from the Git tab. The diff, pull request, walkthrough, mobile Changes, and work status all follow the repository you pick (thanks to @jaygupta17).

### Improvements

- **Chat:** a session you open from the sidebar lands at the latest message and stays there. Switching sessions no longer jumps, renders half a conversation, crossfades, or shifts the tab title.
- Voice: local text-to-speech and macOS say pick a voice that matches the language of the reply. More local models download the first time you need them, and the voice picker lists voices from every installed model.
- Settings: each OpenChamber instance remembers its own theme, so windows connected to different instances keep the look you gave them (thanks to @kydorn).
- Settings: your GitHub account now lives in Settings → Integrations. The pull-request panel has account controls, and its rail icon appears only once you are connected.
- Files: Ctrl/Cmd+F opens search in the Markdown preview even when the preview is not focused.

### Fixes

- Chat: command, skill, and file autocomplete in a chat without a project no longer uses the project you had selected before.
- Chat: reverting to a message or forking from one brings its attached context back to the composer. Review comments, chat and file quotes, terminal selections, and browser annotations are kept.
- Chat: a stopped or unanswered turn now says what happened. The status report lists recent session, send, and managed OpenCode errors, and where to find the logs.
- Scheduled tasks: Goal, Auto-accept, and the other task settings survive when an older OpenChamber build shares the same project config.
- Git: the commit graph no longer leaves a lane gap when the same branch is merged twice (thanks to @Naputt1).
- Desktop: on Windows and Linux the close button reaches the top-right corner and follows the theme on hover (thanks to @kydorn).

## [1.21.1] - 2026-08-29

### New

- **Turkish interface:** OpenChamber can be used in Turkish (thanks to @fitzgpt).
- **Worktrees:** a session menu can move an idle session and its sub-sessions into an existing worktree. OpenChamber finds worktrees created elsewhere, asks before carrying uncommitted changes over, and keeps those changes safe if the move fails partway (thanks to @mattv8).
- Composer: pasting a big block of text, about 2,000 characters or 25 lines, offers to attach it as a `pasted-context-N.txt` file and leaves a `[pasted-context-N.txt]` reference at the caret. Settings → Chat can make it always attach or always paste inline (thanks to @makeittech).
- Work status: a session's cost includes what its subagents spent, split under the context meter and shown per subagent (thanks to @igorvelho).
- Multi-Run: a group can hold more than five models, including isolated runs that make one worktree per model (thanks to @tomzx).
- Projects: the folder picker can select several directories at once and add them together (thanks to @herjarsa).
- Files: the Markdown preview has an in-document search (Ctrl/Cmd+F) with highlighting and next/previous (thanks to @makeittech).
- Panels: right-click an editor, chat, or browser tab to close it, close others, close left or right, or close all (thanks to @adavila0703).
- Chat: a tool card with a file path has a quick-open button (thanks to @robertoberto).
- Mobile: Android connections can trust user-installed certificate authorities, such as a local proxy's (thanks to @Silvenga).
- Debug: the debug panel (Ctrl/Cmd+Shift+D) has a Requests tab showing in-flight requests and their age over the last five minutes (thanks to @tomzx).

### Improvements

- Chat: the text the model writes before it asks a question appears right away instead of waiting in the Activity group until the turn ends (thanks to @makeittech).
- Usage: GitHub Copilot shows a single AI Credits window matching Copilot's token-based quota, in place of the Chat Requests and Completions windows (thanks to @jakoss).
- Files: files up to 20,000 lines open in the full-file preview, up from 5,000 (thanks to @gaojunran).
- Mobile: Chats, the sessions that belong to no project, appear in the sessions sheet above the project list.
- Projects: the folder picker can step into a directory that is already a project and browse from there (thanks to @weixiang1862).
- Web/PWA: the installed app uses the shorter name "OpenChamber" (thanks to @bketelsen and @greghaynes).
- Sidebar: Recent rows show a compact timestamp on web and desktop.

### Fixes

- **Chat:** a very large tool result is capped before it renders, so it no longer freezes the page (thanks to @JSap0914).
- Chat: a code block with JavaScript template strings no longer sends the syntax highlighter into endless backtracking (thanks to @makeittech).
- Chat: a diff with a truncated header no longer crashes the conversation (thanks to @pascalandr).
- Chat: a draft or recalled message with Windows line endings no longer throws "Selection points outside of document" every time you open it (thanks to @yulia-ivashko).
- Chat: a session no longer looks frozen after a page reload or a late second client. Pending permission and question cards come back (thanks to @yangyaofei).
- Chat: a session no longer looks frozen after you dismiss the agent's questions and send a new task (thanks to @bashrusakh).
- Chat: when the turn-ending signal from OpenCode is lost, the working spinner clears within about a second instead of up to ten (thanks to @makeittech).
- `/btw` side questions: a btw session answers the side question instead of carrying on with the parent's plan, and it forks at the last completed turn, so it never inherits a reply that is still streaming (thanks to @pocharlies).
- Composer: typing three backticks leaves the caret inside the finished code fence, an empty input keeps a visible caret, and platform autocorrect behaves as it should (thanks to @franzudev, @TTTPOB, and @IbrahimKhan12).
- Chat scrolling: with "Follow new content while streaming" off, sending from the middle of a conversation no longer jumps to the new message.
- Chat scrolling: a middle-button pan or Shift+Space stops auto-follow the way the wheel does, and an upward wheel inside a tool output box scrolls that box instead of the chat (thanks to @pascalandr).
- Chat scrolling: PageUp/PageDown in the prompt box no longer shifts the whole window up and hides the title bar.
- Chat: question prompts render Markdown (thanks to @pascalandr).
- Chat: a bare link next to CJK or full-width punctuation no longer swallows it (thanks to @gaojunran).
- Chat: inline code and chips are readable in every theme (thanks to @difagume).
- Chat: a finished reasoning block shows in full instead of replaying as if it were still thinking, the text-selection menu stays inside the window, and the sticky user-message header no longer fades over the first lines of the reply (thanks to @makeittech).
- Chat: sending without a selected model says what is missing (thanks to @rvaldemar).
- Chat: `/init` stays in slash-command autocomplete after the conversation starts (thanks to @Dawnfz-Lenfeng).
- Chat: copying a message keeps Markdown paragraph, list, and code-block spacing (thanks to @ChangeHow).
- Chat: Ctrl/Cmd+digit is ignored while you type in a field, and a model you picked by hand survives switching between Build and Plan (thanks to @makeittech).
- Chat: a message made only of quoted context fragments appears in the prompt navigator.
- Chat: opening or closing the context panel no longer leaves a blank tail under the last message.
- Files: a file reached through a symlink inside the workspace, or under a project root that is itself a symlink, opens again instead of failing with an access error (thanks to @herjarsa).
- Files: clicking a folder or file in the sidebar tree opens it reliably on macOS trackpads, where a tiny pointer move used to swallow the click (thanks to @makeittech).
- Browser: when the agent captures a page while the browser panel is hidden, the panel is revealed first instead of the capture failing.
- Work status: undoing or redoing a parent session keeps its subagents at the same point in history (thanks to @alexandrereyes).
- Mobile: opening an agent that is already open switches to its editor instead of duplicating it (thanks to @bashrusakh).
- Sidebar: searching sessions also finds Chats, the sessions that belong to no project, which used to vanish as soon as you typed (thanks to @yulia-ivashko).
- Sidebar: pending permission and question badges are no longer covered by the hover actions (thanks to @makeittech).
- Projects: sending, forking, and image attachments work in projects whose path has non-ASCII characters, such as `Masaüstü` (thanks to @fitzgpt).
- Web/PWA: a notification click focuses an existing window (thanks to @bketelsen and @greghaynes).
- Themes: custom themes loaded through symlinks work (thanks to @divyam234).
- Plans: a saved plan opens with its content again for chats, worktrees outside the project path, and tabs restored after a reload, and an edit made right before closing is no longer lost.
- Settings: the editor font size survives a restart (thanks to @pascalandr).
- Settings: a change made right before you close the window is saved (thanks to @makeittech).
- Settings: number fields and selects no longer clip at large font sizes (thanks to @makeittech).
- Settings: refreshing GitHub account state no longer interrupts the page (thanks to @floze-the-genius).
- Settings: the Cloudflare Tunnel download link works (thanks to @AyoubAchour).
- Settings: Windows skill paths are classified correctly, so disabled and duplicate skills are hidden as intended (thanks to @Ttungx).
- Settings/Providers: after you save an API key or sign in, the provider no longer shows "Credentials missing" with its models hidden until you switch away and back (thanks to @herjarsa).
- Small model: requests send the provider's configured headers, such as an API-gateway subscription key (thanks to @dmitrii-galantsev).
- Small model: a configured Anthropic endpoint is used without a doubled `/v1`, and Google models without reasoning no longer get a thinking option (thanks to @mpeter and @IngTian).
- Git: the status panel refreshes from the real repository after checkout, branch, stash, merge, rebase, or reset, and remote branches that were never fetched appear in branch lists (thanks to @makeittech).
- Git: the Branch diff scope compares against the right base for branches created from the current branch (thanks to @gaojunran).
- Git: picking `origin/main` in the branch selector checks out the local branch instead of a detached `HEAD` (thanks to @yulia-ivashko).
- Git: branch search hides branches that do not match (thanks to @bashrusakh).
- Updates: "Update OpenCode" no longer fails with a bare "Bad Request". OpenChamber names the release it will install and shows OpenCode's reason when it refuses (thanks to @mdatsev and @yulia-ivashko).
- Updates: the desktop "Restart to Update" button says why an install failed, including an unsigned local build, and stays available to retry (thanks to @mdatsev and @yulia-ivashko).
- Desktop: a crashed window recovers on its own, and repeated crashes end in a visible failure page instead of a reload loop (thanks to @wqpan).
- Desktop: a slow or interactive shell startup file no longer stalls startup while OpenChamber looks for OpenCode. Each probe gives up after five seconds, which is what left a Homebrew OpenCode looking undetected from a Dock launch (thanks to @mskadu).
- Windows: restarting managed OpenCode cleans up orphaned listeners and process trees, closing the app stops OpenCode, and scheduled startup no longer fails on Task Scheduler's command length limit (thanks to @sergiofspedro, @a0000001, and @HAHH9527).
- Windows: startup cleanup of leftover processes no longer blocks the server (thanks to @bashrusakh).
- Server: an `OPENCODE_BINARY` from the environment is kept when `settings.json` clears its own override (thanks to @bashrusakh).
- Server: recovery through `OPENCODE_HOST` keeps the configured host and port (thanks to @colinmollenhour).
- Server: `openchamber connect-url` no longer risks tearing `settings.json` while the desktop app runs, which could unpair every device (thanks to @shijie152).
- Sessions: switching quickly no longer saves the wrong scroll position, and the log no longer fills with worktree warnings for folders that are not Git repositories (thanks to @herjarsa).
- VS Code: the extension starts in the current workspace folder instead of one restored from storage (thanks to @makeittech).

## [1.21.0] - 2026-08-26

### New

- **Chat: comment on a reply.** Select text in a chat message, or in a rendered Markdown preview in Files, and choose Comment to attach that quote with your note. The selection stays highlighted while you type, and a source line range comes along when it can be found.
- Diff: hovering a line shows a plus in the gutter. Click or drag across lines to open the comment editor for that range, styled like the chat's comments.
- Chat: context attachments. Diff comments, terminal selections, browser annotations, linked issues and pull requests now appear in the conversation as compact context cards.
- Session tabs: the web and desktop header can show open sessions as browser-style tabs (Settings → General → Navigation). A tab switches the whole workspace, and closing one leaves the session alone.
- Chat: "Follow new content while streaming" (Settings → Chat → Streaming, on by default) turns automatic following off entirely.
- Composer: hovering or tapping a context chip opens a stacked preview of everything attached, where you can edit a comment in place or remove an item before sending.
- Permission cards answer to the keyboard. Alt+Enter allows once, Alt+Shift+Enter allows always, Alt+Backspace denies, and the keys are printed on the buttons. Auto-accept has Cmd/Ctrl+K, A.
- Sessions: Cmd/Ctrl+Alt+Left/Right steps back and forward through the sessions you opened in this window. With session tabs on it moves between neighbouring tabs.
- Git: Cmd/Ctrl+Enter in the commit message box commits, and Alt+Down/Up moves between changed files in a diff review, expanding a collapsed file on arrival.
- Panels: the context rail has a configure button that chooses which panels it shows. Hidden panels keep their data, stay reachable from the command palette, and leave the digit switcher, so digits always match the icons you see.
- Mobile: the chat comment input sits exactly over the composer and rides the keyboard. Enter makes a new line there, and attach moved to the button.
- Mobile: narrowing a browser window past phone size switches to the mobile layout, and widening it switches back.

### Improvements

- **Chat scrolling is rebuilt around your message.** Sending parks your message near the top and the reply streams in below it, a paragraph at a time. Scrolling up hands you the wheel at once, and the scroll-to-bottom pill carries the model's working status while you are away.
- **Keyboard shortcuts are redesigned.** Single chords for everyday actions, a Cmd/Ctrl+K leader for two-step open and go actions, held Cmd/Ctrl+digit for session tabs, Cmd/Ctrl+Option+digit for panels. They work on non-English layouts, tooltips show the binding you have set, old custom bindings reset once, and the full map is in Settings → Shortcuts (registry contributed by @ChangeHow).
- Sessions: switching is much faster in large workspaces. The sidebar no longer rebuilds on every switch and recently viewed sessions come back already rendered, roughly halving switch time with thousands of loaded sessions (thanks to @c-w-xiaohei).
- Chat: Cmd/Ctrl+Shift+T cycles through every thinking level the selected model offers instead of stopping at the end (thanks to @nimobeeren).
- Chat: with following off, the scroll-to-bottom pill appears as soon as the reply grows past the visible area.
- Search: every searchable picker uses one matcher. Best matches first, multi-word queries in any order, punctuation ignored, so "gpt4o" finds "gpt-4o". Ctrl/Cmd+P matches whole file paths.
- Chat: @ file mentions rank files and directories together by match quality, and a long path keeps the folder next to the file name visible.
- Command palette: rarely used commands, such as pin session, copy session ID, the multi-run launcher, archived sessions, notes, todos, status, and theme, are found by typing but stay off the first screen.
- Devices: re-pairing a phone keeps the name you gave it instead of resetting it to "OpenChamber Mobile".
- Files: the editor toolbar is always docked under the file tabs.

### Fixes

- Terminal: terminals no longer vanish behind your back. Every tab and device shows the ones already running on the server, and background tabs survive the idle cleanup.
- Terminal: mobile keyboards no longer capitalize the first letter of every command.
- Browser: an agent opening a page with the browser tool no longer pops the browser panel open or switches the surface you are on. The page loads in the background.
- Auth: an expired OpenChamber login is announced within seconds by a banner with a Log in button. Sending pauses until you log in, and a conversation that failed to load reloads itself afterwards.
- Chat: a failed send returns your typed prompt to the input instead of losing it to an error toast, and a session switch mid-send lands it in that session's draft.
- Chat: prompt-rail and message jumps land exactly on the target once the layout finishes measuring, and clicking the last rail item always works.
- Chat: opening a session or resizing panels no longer strands the view in a large empty space below the last message, and a width change keeps a reader who was at the bottom at the bottom.
- Chat: streamed code blocks are highlighted while they stream, and a finished message no longer jumps when line numbers fill in.
- Chat: finished replies no longer flicker. Tool cards stopped replaying their reveal animation on completion, and resizing the window no longer throws the conversation around at the bottom.
- Chat: file links in messages are no longer checked twice, and the first check no longer uses the wrong project directory.
- Mobile: scrolling during a streaming reply works again. A drag takes over at once, the pill shows up, and loading older messages no longer throws you to the bottom.
- Mobile: on Android browsers the composer stays above the keyboard in the chat, which used to cover it with no way to scroll it into view. The draft screen's viewport pinning now covers the chat screen too.
- Desktop: two windows on different projects no longer hijack each other. One window's session switch could make the other adopt its project while you were typing.
- Desktop: notification clicks and openchamber:// links open in one window instead of all of them.
- Desktop: a relay-paired default host no longer greets every restart with the "Remote Server Unreachable" screen. The app boots and connects over the relay, and picks the direct route back up when it answers again.
- Desktop: a freshly installed or updated build no longer loads the previous version's interface from cache.
- Relay: paired devices are no longer logged out when the app restarts while another local OpenChamber process is running.
- Git: the branch's pull-request badge no longer picks up a stranger's pull request. With contributor forks added as remotes, a fork's closed pull request sharing only the branch name could show on your local branch.
- Sessions: a session list left on "loading sessions" forever after a half-open connection to OpenCode now times out and retries (thanks to @herjarsa).
- Sessions: headers find archived sessions, so an archived session's title is no longer missing.
- Settings: the selected project or session no longer jumps back to a previous choice when settings responses arrive out of order.
- Files: a preview above the editable size cap shows the whole file, and huge files no longer freeze the app (thanks to @gaojunran).
- Usage: the Command Code tile is gone, because their API exposes no usage data and the tile could only fail.
- VS Code: the chat view no longer sticks on its loading screen on slow or remote connections (thanks to @VinciYan).
- UI: the chat's scroll fades are back, the first uncached session open fades in, draft target menus stay inside the chat area, sidebar tooltips no longer appear on a passing hover, and the btw panel's shadow matches the composer.
- UI: OpenCode notices share one style, and Linear and Cloudflare tools show their own icons.
- UI: the timeline dialog fits small screens (thanks to @gaojunran).

### Misc

- Files: the floating hover toolbar and its setting were removed.
- Mobile: the setting that chose between the old and new mobile layout is gone.

## [1.20.0] - 2026-08-23

### New

- **Session: /btw side questions.** Type `/btw` and your question to ask something off-topic in a temporary session forked from the current one, so it has the full context and leaves the chat untouched. The answer streams into a panel above the composer, which you can collapse to a slim bar, keep as a full session, or discard. The temporary session stays out of the sidebar and session lists until you keep it (thanks to @jaygupta17).
- **Chats:** start a chat without choosing a project. Chats live in their own section and carry no repository or worktree context.
- Skills catalog: browse curated GitHub skill collections in a card catalog with search across sources, skill counts, stars, recent updates, and a link to each skill's repository.
- Diff: the context-panel diff can show every change on the current branch against its base branch. OpenChamber detects the base when Git knows it, and asks you once when it does not.
- Settings/Projects: a project can pin a thinking level next to its model, for models that offer levels. Both sit in one Defaults for new chats group.
- Desktop/Remote instances: a managed remote server can also be published to the remote machine's own network, so other devices there reach it without the SSH tunnel. It needs a UI password, and stays private to the tunnel otherwise.
- Chat: an app link such as `spotify://` asks for confirmation before opening another app. You can trust a link type on one device and manage trusted links in Settings.
- Sidebar: switch between the full project list and a focused view of one project.
- Providers: more custom providers are supported.
- Small model: summaries, goal audits, commit messages, and walkthroughs work with more providers.

### Improvements

- **Desktop/Remote instances:** adding an SSH connection starts from the hosts in your SSH config instead of a blank command field. Ports, install method, and passwords moved behind Advanced settings, and each connection shows Connected, Connecting, or Needs attention with the failure text and a button that fixes it.
- Chat: in the expanded composer, Enter starts a new line and Cmd/Ctrl+Enter sends, so a long prompt is harder to send by accident.
- Settings: the project selector on Providers, Agents, MCP, Commands, and Skills only changes what those pages show. It used to switch the whole app, carrying your chat, session list, and file tree to the other project.
- Git: a generated commit message matches the style and language of the repository's recent commits.
- Git: a generated pull request description follows the repository's own template when it has one, so the draft comes back in your sections and checklists instead of the built-in Summary, Why, Testing layout.
- Diff: creating an inline comment opens the chat and focuses the composer for your follow-up.
- Dictation: speech is transcribed after you stop recording. The composer shows a live waveform and timer, and a long recording splits at pauses instead of cutting words.
- Chat: while a reply streams, the model status line under the last message turns into the finished message's info row in place.
- Usage: Z.ai credit limits appear alongside its other quota windows.
- Git: pull-request checks in Work status stay current as their status changes.
- UI: the default dialog close button is easier to click or tap (thanks to @rockinrimmer).

### Fixes

- Desktop/Remote instances: connecting to a remote machine works when bun, OpenChamber, or the opencode CLI live in your home directory rather than on the system path. Installing no longer fails with a permission error, and a missing opencode CLI is reported before the connection starts instead of as a stack trace.
- Desktop/Remote instances: disconnecting from a connection set not to keep the server running actually stops that remote server.
- Settings/General: changing the default model, variant, or agent no longer repoints an open chat that already carries a model you picked for it. Chats following the default still switch right away.
- Settings/Providers: the provider you select no longer jumps to another one on its own. Changing the chat's model or agent, and background provider refreshes, used to move the selection with them.
- Chat: if OpenCode restarts while a response is running, the chat stops with an interrupted state and a notification to continue instead of hanging silently (thanks to @sum117).
- Chat: newly sent messages and highlighted code blocks no longer flicker, and Bash output grows with its content instead of being cut off.
- Chat: file paths in messages open from the session's project, even if you last browsed files in another project (thanks to @tomzx).
- Chat: in a chat without a project, the work status card steps aside when the context panel is open instead of sitting next to it.
- Chat: a long user message can be expanded even when its final layout finishes after it first appears.
- Sidebar: sessions created outside OpenChamber appear in the sidebar and Recent list without a page refresh (thanks to @tomzx).
- Files/Desktop: a file opened from outside the workspace stays readable after its temporary access expires, instead of failing until you reopen it (thanks to @pascalandr).
- Session assist: recaps and suggested follow-ups work when the Anthropic provider uses a custom endpoint. They used to fail every time.
- Desktop/Windows: the close button lines up with the rest of the window chrome.

### Misc

- Settings/Integrations: the experimental page lists only integrations you can install. Unavailable and Coming soon entries are gone.

## [1.19.0] - 2026-08-19

### New

- **Settings/Integrations:** a new Integrations page lists the Claude Code, Command Code and Cursor plugins with install, update, setup and remove actions. Discord and Telegram are marked coming soon.
- Files: drag files onto the Files sidebar to upload them into the project or into a chosen folder. Replacing a file that already exists asks first (thanks to @makeittech, @alanzchen).
- Usage/Claude: Claude plan limits work when you are signed in through Claude Code on macOS, Linux or WSL, with no second Anthropic login in OpenCode.
- Usage/Claude: the Usage page names your plan and adds per-model weekly limits and extra usage spending.
- Usage/Command Code: Command Code plan limits appear in the Usage page and the work status panel.

### Improvements

- **Project knowledge:** the Project notes panel is now Project knowledge, with notes, todos, plans and their search in a resizable sidebar. Click anywhere on a note card to expand it. Plans open and edit in the panel, and notes and plans can be pinned as context.
- Git: the pull request panel follows the branch's current open PR, and an open PR wins over an older merged or closed one (thanks to @makeittech).
- Git: after a PR is merged or closed the panel keeps showing it as the branch's last PR and offers to create the next one right below it (thanks to @makeittech).
- Chat: opening a busy subagent in the context panel shows its history while it works, not only the working-status line (thanks to @makeittech).
- Chat/Attachments: text pulled out of Office and OpenDocument files is capped and shown more compactly, so a large document and its images no longer crowd out the rest of the message.
- Files: a preview you already have open refreshes after you upload a new copy of that file (thanks to @makeittech, @alanzchen).
- Mobile/iOS: the chat composer uses native selection handles for picking text.

### Fixes

- **Settings:** saving settings no longer wipes an OpenCode config written with unquoted JSON5 keys down to an empty `$schema` stub. Plugins, MCP servers and providers stay, and the change reports a failure (thanks to @makeittech).
- Stability/Proxy: sustained API traffic no longer uses up every outgoing network port on the machine, which left nothing on the computer able to connect until the traffic stopped (thanks to @alohaninja).
- Chat: an open conversation no longer keeps re-coloring the same code blocks in the background, which pinned a CPU core and spun up the fans while you browsed files (thanks to @makeittech).
- Chat: the context meter no longer climbs past 100%, with readouts as high as 330%, after turns with many tool calls, and no longer jumps when you reopen an older session. The header, context sidebar, work status panel, mini chat and mobile all show the same value (thanks to @pocharlies).
- Chat: a new chat no longer saves its first message and then never starts when the last worktree directory was deleted; it falls back to the active project.
- Chat: typing with Chinese, Japanese or Korean input methods no longer breaks composition or throws the cursor to the end of the composer (thanks to @makeittech).
- Chat: saved chats in the context panel no longer open blank.
- Chat: dismissing an agent's clarifying questions no longer leaves the session stuck on the question screen; the next task shows its thinking and its final response.
- Projects: project names match the folder name exactly, so `.ssh` and `opencode-claude` no longer read as `.Ssh` and `Opencode Claude` in the sidebar, window title, settings and notifications. Names you set yourself are kept.
- Git/Worktrees: creating a worktree from a pull request works when the source fork was deleted or unreachable; it falls back to GitHub's pull-request reference (thanks to @makeittech).
- Files: a file reached through a symlink inside the workspace opens instead of being rejected as outside the workspace.
- Settings: the session retention action you pick is saved (thanks to @Gautam0507).
- Settings: an `OPENCODE_BINARY` environment variable you set is no longer discarded when settings hold an empty opencodeBinary value, so the managed OpenCode server still uses your binary.
- Usage/Claude: your session and weekly limits stay on screen while Anthropic blocks refreshes for a while.
- Mobile: connecting through an ngrok address works; its browser warning page no longer fails the server check.
- Desktop: browser pages served from a self-signed loopback HTTPS address load instead of being blocked by the certificate warning.
- Browser: typing a comment on a page no longer triggers app shortcuts.
- UI: the model menu no longer paints white text on a white highlight in a high-contrast theme, so the hovered or selected model stays readable (thanks to @bashrusakh).
- Skills Catalog: the misspelled source name ClawdHub now reads ClawHub (thanks to @makeittech).
- VSCode: Add Project adds the chosen folder to the workspace instead of showing a "Failed to add project" toast.

## [1.18.4] - 2026-08-14

### Fixes

- **Stability:** a single internal error no longer takes the local server down and leaves the instance unreachable until you restart it. The error is logged and the server keeps running.
- **Chat:** new messages no longer jump above older ones once the message ID sequence rolls over. Loading history, reverting and redoing follow the same order as the conversation.
- Mobile: connecting to a server that has authentication turned off survives closing and reopening the app. Auto-reconnect and the return-to-app check no longer read the missing password token as a lost connection and send you back to the connect screen.
- Browser: opening or restoring a dev server preview while you are connected over a relay or another non-standard address no longer crashes the app; the preview says the tunnel is unavailable.

## [1.18.3] - 2026-08-14

### New

- **Agent browser control:** agents can open a page and work with it. They read what is on screen, click, type, scroll, look at how an element renders, switch between mobile, tablet and desktop layouts, and save a screenshot into the project, so they can check their own work. Turn it on or off in Settings → General → OpenChamber Tools.
- Browser: dev servers are listed from what is actually listening, so one is offered however you started it, and a server that is still starting is waited for.
- Browser: the panel holds several pages at once, shows each page's own icon, and suggests addresses you already visited in this project.
- Browser: new controls for hard reload, page zoom, device sizes, a light or dark page, and clearing cookies or cached data for the panel alone.
- Mobile: long-press the logo on the connect screen or the instances list to open a connection log with a copy button, for reporting connection problems.

### Improvements

- **Browser panel:** the preview and browser panels are one panel now, backed by a real browser view in the desktop app. Pages that used to refuse to load open normally, logins stay, and developer tools are there. Point at an element or drag a region, write a comment, and it goes to chat with a screenshot of what you marked.
- Chat images: a finished assistant reply collects its Markdown images into a compact gallery with thumbnails and full-screen previews, including images from the workspace. On mobile the gallery scrolls sideways (thanks to @ChangeHow).
- Browser: when OpenChamber runs on another machine, the desktop app opens its dev servers through a local port, so pages load with working hot reload and developer tools, and links to another local port stay on that machine. In a web browser tab you can open only dev servers on your own machine.
- Remote access: a pairing QR code made while the app is reached through a public domain, for example behind a reverse proxy, includes that domain, so a paired phone can connect over it.
- Usage: quota limits you chose to display refresh every three minutes on desktop, mobile and VS Code, and you can refresh them by hand at any time.
- Usage: OpenCode Go quota tracking uses your existing OpenCode API key. No browser cookies or workspace ID needed.
- Desktop/Windows/Linux: minimizing the window always keeps it in the taskbar. The tray setting, now called "Close to the system tray", applies when you close the window.
- Desktop/Linux: frameless main and Mini Chat windows use native rounded corners (thanks to @kydorn).

### Fixes

- Remote access: a message sent through the private relay no longer fails with a 400 error when a connection drop loses part of the request; the request is retried (thanks to @claymor333).
- Mobile: a brief network hiccup when you open or return to the app no longer bounces a working connection back to the connect screen. The app retries and reconnects on its own, and a server that is really unreachable shows the connect screen within a few seconds.
- Scheduled Tasks: when two OpenChamber servers share a project configuration, a scheduled occurrence runs once; both servers no longer start duplicate sessions (thanks to @makeittech).
- Performance: a closed context panel no longer keeps its embedded chats running, and an open panel loads only the chat tab you are looking at (thanks to @karimodm).
- Sessions: switching projects selects a session that belongs to the new project (thanks to @makeittech).
- Chat: a message you already submitted stays with its session; a later project switch no longer sends it somewhere else (thanks to @makeittech).
- Chat: opening a subagent or code-review session in the context panel no longer steals focus from the main composer, and subagent prompting is available right away when it is enabled.
- Chat: code-review sessions are no longer treated as read-only subagent sessions.
- Chat: typing `!` for shell mode no longer leaves the `!` in the command or puts the caret on the wrong side of it (thanks to @RyderAsKing).
- Chat: line numbers with three or more digits no longer wrap in code blocks (thanks to @ChangeHow).
- Work status: a new-session draft shows project, MCP and usage details before the session exists, a long subagent list stays inside the panel, and hiding every section still leaves the controls to bring them back (thanks to @alohaninja).

## [1.18.2] - 2026-08-10

### New

- **Observability panel:** a new panel beside the chat brings the active goal, tasks, subagents, pinned context, MCP servers and context usage into one live view. The session list also shows how long an agent has been working.
- **Scheduled Tasks:** a project can define recurring tasks as Markdown files in `.agents/loops`. Opening the task list picks up file changes without a restart, and you can edit, enable, disable, delete or run a task from the app (thanks to @makeittech).
- Projects: you can create a new project directory outside the current workspace.
- Projects: adding, creating or cloning a project opens a new-session draft aimed at that project.
- Usage: xAI quota reporting (thanks to @iamhenry).

### Improvements

- Performance: the first web download is about 58% smaller and startup memory use about 22% lower. Heavy Settings and syntax-highlighting code loads only when you open it (thanks to @makeittech).
- Chat: shell command output is expanded by default, and adding a message to context puts focus back in the composer (thanks to @pascalandr, @makeittech).
- Chat: the composer caret is easier to see.
- Terminal: default tab names stay unique after you close tabs, Escape reaches terminal applications and no longer closes the context panel, and background connections send fewer keepalives (thanks to @makeittech).
- Walkthrough: branch comparisons use the repository's actual default branch on the remote (thanks to @RyderAsKing).
- VSCode: notebook links open in the notebook editor when a compatible extension is installed (thanks to @TTTPOB).
- UI: dialogs, dropdowns, popovers and tooltips share the same glass styling.

### Fixes

- **Settings:** OpenCode configuration changes gather behind a single Apply & Restart action, so OpenCode no longer restarts after every edit. The confirmation warns you when active chats will be stopped (thanks to @makeittech).
- Git/Worktrees: a prompt waits for a new worktree to finish checkout before it is sent, and a session runs against the worktree that owns it; it no longer opens or sends against the parent repository (thanks to @ftzi).
- Git/Worktrees: setup runs the repository's `post-checkout` hook after creating a worktree, and a deeply nested worktree no longer fails with "Filename too long" on Windows (thanks to @ftzi, @makeittech).
- Remote access: a paired device using the private relay keeps relay access when no browser client is connected or device state fails to load for a moment.
- Chat: a queued message no longer sends into a response that is still streaming, and tool cards left running by an interrupted response settle instead of staying stuck (thanks to @makeittech).
- Chat: a message you submitted before switching sessions stays with the session and workspace you sent it from. If you switch away it is cancelled, never delivered to another instance (thanks to @Wsyjq).
- Chat: a fresh message no longer replays its entry animation after it has been shown, and Shift+Enter inserts a newline again on iOS (thanks to @makeittech).
- MCP: authorization handles browser callbacks more reliably, settings show clearly which servers are available, and a failed connection offers a retry action.
- Settings: quick edits to notification templates no longer overwrite one another, and the collapsed-user-message preference sticks (thanks to @AmanTahiliani, @pascalandr).
- Files: removing an attached Office or OpenDocument file also removes the images taken out of that document, and a failed reveal on Linux shows an error instead of failing silently (thanks to @chiamsun, @pascalandr).
- Desktop/macOS: choosing a folder after you denied filesystem access works again; the app is no longer left unable to open the directory (thanks to @deatheros).
- Desktop/Windows: minimizing from the taskbar stays a native minimize, while the app's own minimize action can still hide to the tray (thanks to @pascalandr).
- Desktop: overlay scrollbars hide again after you scroll instead of staying visible.
- Mobile/Android: pairing QR codes work in older WebViews that misread `openchamber://` links (thanks to @CMBill).
- Mobile: a pending agent question reappears after a cold start, so the session no longer waits with no answer prompt.
- Server: a foreground install managed by a user systemd service updates through a separate transient service, so the server restart no longer interrupts it (thanks to @SYU8384).
- Security: archive extraction updated for GHSA-xcpc-8h2w-3j85 (thanks to @mel0nyrame).

### Misc

- Desktop/macOS: the vibrancy option is gone; it cost too much rendering work.

## [1.18.1] - 2026-08-04

### New

- **Sessions:** an archived session can be restored to the active list, from the sidebar context menu, the archived-sessions page or the bulk-selection bar. Permanent deletion is no longer the only option (thanks to @makeittech).
- Chat: Ctrl/Cmd+L adds the selected text to the chat input, or focuses the input when nothing is selected. The toggle-sidebar shortcut moved to Ctrl/Cmd+Alt+L.

### Improvements

- Providers: an OAuth-only provider shows a Connect flow in place of the API key form, and its models appear once you are signed in.
- Providers: a sign-in that needs extra details, such as GitHub Copilot Enterprise, asks for them before it opens the browser.

### Fixes

- **Providers:** signing in to an OAuth-only provider completes. The browser login is stored and the provider list updates, so you are no longer left signed out.
- Providers: the copy button for device codes works.
- Chat: a model you chose by hand stays selected after a delegated subtask finishes; it no longer reverts to the agent's default model.
- Walkthrough: models without a working provider login are gone from the walkthrough picker, and Generate stays disabled until you pick a usable model, so it no longer fails with a raw provider error.
- Walkthrough: connecting to a server older than the app says the server needs updating instead of showing a raw HTML parsing error. The "Critical" tag is now "Key change" with a tooltip, so it no longer reads as a problem found in your code.
- Agents/CLI: a prompt that never reaches its session is reported as failed, and an unavailable model, agent or variant is rejected with a clear error before anything is created.
- Desktop/Linux: "Open in Terminal" no longer launches a non-terminal app that is set as the terminal launcher (thanks to @kydorn).

## [1.18.0] - 2026-08-04

### New

- **Walkthrough:** a guided tour of a diff. The model groups related changes into stops, explains each one, and puts them in an order where each builds on the last. Start one from Changes or the pull-request view for uncommitted work, a branch against its base, or a pull request. It writes in your interface language, and the panel can redo it in another supported one.
- **Providers:** add and edit custom OpenAI-compatible providers in Settings, with their endpoint, models, credentials, headers, and configuration scope (thanks to @makeittech).
- Localization: the interface and the documentation are available in German (thanks to @SGD-DEV).
- Mobile/Android: pairing QR codes scan on devices without Google Play Services. The camera closes the moment it reads a code and a connecting screen takes over.
- Settings/Skills: skills kept in the project's own `.agents/skills` folder show up for the active project (thanks to @makeittech).
- Usage: DeepSeek quota is tracked (thanks to @airtaxi).

### Improvements

- **Mobile/Tablet:** the tablet and foldable layout follows the phone navigation now. A resizable sessions sidebar sits on the left, the workspace (Changes, Files, Terminal, Notes, MCP) on the right, and pages like settings and instances open as centered dialogs. An open diff, edited file, or attached terminal survives rotation.
- Mobile/Android: the left and right drawer swipes start farther from the screen edge, clear of Android's Back gesture.
- Performance: the web app starts faster. The 18.5 MB bundle it used to download is gone, and syntax highlighting, screenshots, diagrams, the editor, and image conversion load only when you need them (thanks to @makeittech).
- Performance: expanding a project with many worktrees stops reloading its sessions over and over.
- Git/Diff: opening a changed file puts its header at the top, and live updates refresh only the files that changed, keeping your place in the review. Saving from the built-in editor updates the diff too.
- Terminal: a terminal opens without waiting for the view to finish loading, and output that arrives first is still there when it appears (thanks to @makeittech).
- Files: in a browser, exporting a file is labelled as a download and the desktop-only reveal action is gone (thanks to @makeittech).

### Fixes

- Chat/Tools: Bash output reads as it did in the terminal instead of showing raw escape codes for progress bars and rewritten lines (thanks to @catan271).
- Chat: queued messages retry after a failed send or an interrupted turn instead of sitting stuck until the next session update.
- Chat: a prompt sent over the private relay no longer produces a duplicate reply when the connection drops after OpenCode took the message. A queued message that is already being sent is not sent a second time.
- Chat: assistant messages no longer run HTML.
- Sessions: sessions in a worktree you just created show up without restarting or refreshing the app.
- Sessions: archiving and unarchiving stays inside the current instance and workspace (thanks to @alexandrereyes).
- Sessions: starting OpenChamber from a folder that is not your project, your home folder for instance, no longer floods you with "not a git repository" errors that could stop sessions and projects from loading (thanks to @makeittech).
- Settings/Skills: renaming a skill keeps its instructions and supporting files. The rename action only shows for skills OpenChamber can safely move (thanks to @makeittech).
- Usage: Kimi for Coding counts usage correctly whether the provider reports what you used or what is left (thanks to @makeittech).
- Sidebar: a worktree shared by two projects appears once (thanks to @makeittech).
- Sidebar: session titles no longer clip at the ends of their rows.
- Chat: clicking an apply_patch result opens the file you clicked instead of always the first one (thanks to @nabsiddiqui).
- Agents/CLI: creating a session in a new worktree no longer reports a timeout while the worktree is still being created.
- Desktop/Linux: terminals and OpenCode start with the right shell arguments in AppImage installs, so zsh works again (thanks to @makeittech).

## [1.17.2] - 2026-08-01

### New

- **Sessions:** move a root session and all its sub-sessions into a new worktree from the session header menu.
- Desktop: the active session header has a menu with rename, share, export, archive, delete, and copy ID. A share link lands on your clipboard as soon as it is created.
- UI: OpenChamber, in dark and light, is the new default theme.
- Files: Settings → General has an Auto-save switch. Binary, PDF, and Office files are left out of it (thanks to @makeittech).
- Desktop/Linux: a Window Controls Style setting switches between classic rectangular buttons and macOS-style traffic lights (thanks to @kydorn).

### Improvements

- **Mobile:** the app navigates by two swipe drawers now. The left one lists sessions across projects and lets you rename, archive, or delete with a swipe; the right one holds Changes, Files, Terminal, Notes, and MCP. Tapping the title in the header opens recents with live status, and a cold launch reopens your last session or shows a connect screen when it cannot.
- Performance: the first session after startup opens faster, because background requests no longer get in front of the message load (thanks to @yulia-ivashko).
- Terminal: switching terminal tabs keeps the connection instead of building it again on every open (thanks to @makeittech).
- Chat: a tool description shows the glob pattern when the tool was given one.
- Sidebar: a session with an agent working shows a live activity dot even while the sidebar is collapsed (thanks to @pascalandr).

### Fixes

- Git/Diff: symlinks show as links in the diff instead of dumping the content of the file they point at.
- Chat: clicking the padding around the composer puts the cursor in the text (thanks to @IbrahimKhan12).
- Chat: the `/` menu lists a skill once when a command shares its name (thanks to @IbrahimKhan12).
- Usage: every Z.ai usage window shows up in the usage view.
- VS Code: per-session auto-accept answers permission requests as they arrive when it is turned on.
- Desktop: sticky session headers in the sidebar stop blinking and jumping while pages change (thanks to @ChangeHow).

### Misc

- Desktop/Windows: Windows ARM64 builds are available (thanks to @airtaxi).

## [1.17.1] - 2026-07-29

### New

- Behavior: an optional setting trims about 40% off OpenCode's built-in system prompt for the build and plan agents. It takes effect after OpenCode restarts, and it is not meant for custom build or plan definitions.

### Improvements

- **Chat tools:** a Bash card shows output while the command is still running, in a pane of fixed height that follows new lines until you scroll away. The timer keeps counting to the real end instead of stopping at 300 seconds.
- Chat: a slash-command starter picks up whatever you already typed in the draft and passes it as the command's arguments.
- Usage: an OpenAI business account shows the spend limit you configured for Codex (thanks to @jrandiny).
- Desktop: bundled OpenCode updates together with OpenChamber, with no separate update to accept (thanks to @yulia-ivashko).
- Desktop/Linux: the AppImage tray menu has Show, Hide, and Close, and "Open in" shows the icons of the apps it found (thanks to @makeittech).

### Fixes

- OpenCode: a chat recovers when OpenCode goes quiet mid-response, and managed OpenCode stops restarting in a loop during a brief connection problem.
- Session goals: a goal started from a slash command, a scheduled task included, runs the command's full instructions.
- Chat: a history you loaded to the end stops offering "Load older" after a refresh.
- Chat: messages you removed by reverting stay gone after you send the next message.
- Mobile: image previews load over the private relay.
- Settings: subpanels keep a visible vertical scrollbar and lose the horizontal one (thanks to @sergiofspedro).

## [1.17.0] - 2026-07-28

### New

- **Agents:** through the OpenChamber tool, an agent on a managed local instance can create, send to, fork, inspect, and wait for sessions, make an isolated worktree, and manage scheduled tasks. A new Schedule a Task starter walks you through setting one up from chat.
- **Context panel:** Changes, pull requests, files, terminal, notes, plans, previews, and side chats live in one resizable panel with a rail to switch between them. The pull-request view shows checks and comments as they land, and a failed check or a comment can go straight into a chat draft.
- CLI: new `session`, `schedule`, `projects`, and `models` commands.
- Chat: text selected from a Markdown code block keeps its fences, language, and block structure when you add it to the composer or start a session with it (thanks to @ChangeHow).
- Settings: an option hides starter suggestions on the new-session screen.
- Usage: Crof and NeuralWatt quotas are tracked, with subscription kWh, separate key-allowance windows, and a credits balance to fall back on (thanks to @kydorn).
- Desktop/Linux: official AppImage builds for x64 and arm64, with in-app updates, frameless window controls, minimize to the system tray, launch at login, several windows at once, and "Open in" for the apps it finds installed (thanks to @BestSithInEU, @jibanez-staticduo, @makeittech).

### Improvements

- **Sidebar:** sessions sit in Recent and per-project zones, grouped by worktree or flat. Scheduled tasks, archived sessions, multi-run, and worktree management open as full pages from the sidebar.
- Chat composer: what you type renders as you type it, with Markdown emphasis, attention lines, file and agent mentions, slash commands, snippets, attachment citations, and `~path` references. A file mention can be edited in place, and the mobile composer grows with its content.
- Chat/Permissions: sending a message while a permission prompt is open denies what is pending in the session and its subagents, then queues your message for the next turn (thanks to @tomzx).
- Chat/Subagents: a subagent chat can be prompted while direct subagent prompting is on, even before the parent session has loaded.
- Mobile/iOS: push notifications go through Apple's production service by default (thanks to @natheihei).

### Fixes

- Chat: jumping to a message in a long conversation lands on the right one even when the rows above it have not been drawn yet.
- Chat: code blocks stop shifting lines and merging into nearby text while they render, and copied code keeps its original text (thanks to @ChangeHow).
- Small Model: GitHub Copilot models use the API they support, so summaries, goal audits, commit messages, and other Small Model actions work with models that have no Chat Completions (thanks to @jakoss).
- Desktop/Linux: the app no longer freezes or crashes now and then while a chat streams with the system tray on (thanks to @kydorn).
- Desktop/Linux: a missing update manifest counts as "no update" instead of failing, and updater errors show in About and the sidebar (thanks to @BestSithInEU, @jibanez-staticduo, @makeittech).
- Mobile/iOS: notifications reach development builds installed from Xcode. The app works out which Apple push environment it is in, so sandbox and TestFlight or App Store installs both get them.
- Mobile/Android: tapping the terminal opens the keyboard, typing and backspace work with Android keyboards, and closing a focused terminal leaves the app responsive.
- Shortcuts: double-Escape can no longer be primed while the current session is not the active one.

## [1.16.3] - 2026-07-22

### New

- **Chat attachments:** attach Office and OpenDocument files (`.docx`, `.pptx`, `.xlsx`, `.odt`, `.odp`, `.ods`). Their text and the embedded images OpenChamber can read are pulled out before the message goes off.
- **Sessions/Worktrees:** move an idle root session, its sub-sessions, and your uncommitted changes into a new worktree.
- Chat attachments: more source-code formats, notebooks, HAR files with credentials and cookies stripped, SVG and Draw.io drawings, and HEIC/HEIF images. The composer warns you when the chosen model may ignore an attachment type.
- Desktop: start straight into a saved remote instance, a URL, or a pairing link, with no local OpenCode and no local server.
- Scheduled Tasks: a task can start with permission auto-accept on. Its permission and Run as goal controls are the same compact toggles as in the chat composer.
- Desktop/macOS: a setting hides the menu bar item.

### Improvements

- **Performance:** opening and switching sessions in a big workspace puts the selected and visible chats first.
- Chat: an assistant turn shows model, agent, thinking level, duration, and time together in its footer, and replies split by a hidden system or subagent prompt read as one turn.
- Sidebar: projects are ordered by hand by default. A sorting choice you made yourself stays as it is.
- Desktop/Windows: SSH remote instances connect through native Windows OpenSSH. Password login and port forwarding run in hidden background processes, and a failed connection shows the SSH error itself.
- Mobile/Terminal: opening the terminal in a mobile browser or PWA focuses the input and raises the keyboard with no second tap (thanks to @bashrusakh).

### Fixes

- Performance: a failed refresh keeps the session list you had, a parent session no longer vanishes when its sub-sessions load first, and session data stays inside its own instance, project, and worktree.
- Chat: the working indicator names the model actually writing the reply, streaming at the bottom no longer jitters, and a new user message finishes its entry animation instead of snapping into place.
- Chat/Tools: attachments returned by plugin and custom tools stay visible after streaming and refreshes, with the same image previews and file chips as your own attachments (thanks to @FrostiDrinks).
- Sessions/Worktrees: creating a worktree recovers when an earlier Git operation left the repository locked.
- VS Code and Cursor: opening a chat no longer crashes when the editor webview lacks its usual messaging APIs, and a closed editor tab stops receiving late streaming messages (thanks to @makeittech).
- VS Code: the active workspace is worked out before saved state is restored, so a project outside the editor workspace cannot replace it.
- Context Panel: a slow file-open request no longer yanks the panel back to that file after you picked another tab.

## [1.16.2] - 2026-07-18

### New

- **Terminal:** terminal sessions are rebuilt on Web, Desktop, and Mobile. They draw faster, keep their scrollback after a reconnect, and get Unicode and full-screen programs right.
- **Pinned messages:** pin a user or assistant message and its text comes back to the agent after the conversation is compacted.
- Terminal: pick the shell and whether it starts as a login shell, restart a session, and attach the selected output to the chat.
- Terminal: a theme change applies to open terminals right away.
- Mobile: a full-screen terminal workspace with touch scrolling and selection, quick keys, and Ctrl and Alt input.
- Sessions: a new draft or session stays with the project selected in the sidebar, including workspaces with nested or sibling projects (thanks to @bashrusakh).
- Session goals: goal details show which model ran the latest successful evaluation.

### Improvements

- Settings: every page uses the same responsive layout, and navigation is grouped into OpenChamber, Workspace, OpenCode, and Library.
- Settings: a save failure is shown in the page header.
- Settings: agent tool permissions separate inherited rules from explicit ones and list session-granted rules on their own (thanks to @makeittech).

### Fixes

- Chat: when creating a session fails, the new-session draft stays open with the prompt you submitted.
- Session goals: an audit waits while direct subagents are still working.
- Small Model: provider API keys given through environment variables or files work for summaries, goal audits, and the rest of the Small Model features.
- Small Model: Gemini 3 Flash models use the thinking setting they support.
- VS Code: per-session permission auto-accept works again, survives an extension restart, and covers subagent sessions while an OpenChamber view is open.
- Mobile/Android: an update download picks the APK when the release also ships an Android App Bundle.

## [1.16.1] - 2026-07-14

### New

- **Prompt Navigator:** an optional marker rail beside desktop chats. Hover a marker to preview that prompt, click to jump to it, or give it a shortcut in Keyboard Shortcuts settings (thanks to @makeittech).
- Chat/Subagents: "Open subtask" works for nested subagents in the side-panel chat, and a Parent action takes you back to the previous subagent (thanks to @ameshkov).

### Improvements

- Chat: a shell-mode command card updates its status and output while the command runs, and highlights the command and its output.
- Small Model: a custom OpenAI-compatible provider uses the base URL and API key from your OpenCode configuration (thanks to @ameshkov).

### Fixes

- **Performance:** a large session sidebar stays responsive while chats stream, including setups with many projects, worktrees, and sessions.
- Chat: opening a long chat after an empty or aborted agent turn no longer reloads bigger and bigger parts of its history.
- Chat/Subagents: a task card follows its own subagent when several run at once, so its activity and "Open subtask" no longer point at another session.
- Sessions: a temporary project lookup failure no longer drops worktree groups from the sidebar.

## [1.16.0] - 2026-07-13

### New

- **Session goals:** arm the target button in the composer and your next prompt becomes a [goal](https://docs.openchamber.dev/session-goals/). The session keeps working on it by itself, and a small model audits every finished turn, until the goal is done, blocked, or past its optional token budget.
- Session goals: the loop runs on the server, so a goal keeps going with the app closed and survives a restart.
- Session goals: a strip above the composer shows progress, with pause and resume.
- Session goals: a goal can also start from the plan-implement dialog, from a scheduled task with "Run as goal", or from the "Craft a Goal" starter and the `/craft-goal` command.
- Session goals: while a goal runs, one notification when it settles replaces the per-turn "ready" notifications.
- Chat: you can prompt a subagent session directly. Open a subagent from the context panel and send it follow-up messages. Turn it on in settings.
- Settings: an editor font size setting for the code editor (thanks to @bashrusakh).
- Usage: OpenCode Go usage is tracked.
- Files: the file viewer has a markdown preview toggle (thanks to @greghaynes).
- Sidebar: projects can be sorted several ways, with a direction toggle (thanks to @bashrusakh).

### Improvements

- Permissions: per-session auto-accept lives on the server, so a session keeps auto-accepting tool calls with the app closed and after a server restart, and subagent sessions inherit it.
- Permissions: auto-accept can be turned on for a draft before the first message (thanks to @bashrusakh).
- Settings: chat visual settings are grouped into labeled sections (thanks to @bashrusakh).
- Command palette: fuzzy search covers projects alongside sessions and files (thanks to @bashrusakh).
- Editor: "Open in" recognizes VS Code Insiders.
- Remote access: the phone's launch screen names the device it is connecting to.

### Fixes

- **Remote access:** connecting over the relay is much faster, with no wait on a stale local address that could take around 20 seconds on a phone away from home. When your computer gets a new local IP, paired devices learn it over the relay and return to the local network on their own, with no re-pairing.
- Remote access: running several OpenChamber instances on one machine no longer lands paired devices on a random one, which was behind the intermittent "Unable to reach server" errors on paired phones.
- Chat: a queued message sends when the session is already idle instead of waiting forever (thanks to @bashrusakh).
- Chat: a pending agent question stays answerable after a server restart (thanks to @bashrusakh).
- Chat: a renamed session keeps its new title instead of flickering back to the old one (thanks to @bashrusakh).
- Sidebar: pinned sessions survive a refresh, and the file tree stays expanded while it refreshes (thanks to @bashrusakh).
- Usage: Codex quota windows show the right reset times.
- GitHub: PR and issue context resolves against the source repository when you work in a fork (thanks to @bashrusakh).
- Notifications: session errors and subagent completions arrive on desktop, web, and mobile.
- Agents: saving agent settings from the UI keeps custom YAML frontmatter fields (thanks to @bashrusakh).
- Windows: a difference in drive letter casing no longer splits one project into duplicates (thanks to @bashrusakh).
- Mobile: the sessions sidebar opens right away instead of taking many seconds on some devices (thanks to @tomzx).
- Mobile: renaming a saved instance keeps its connection working. The stored access token was being lost on edit.
- Mobile: on Android 15 the app no longer draws under the status bar.
- Security: a request that fakes local host headers to look like same-machine traffic is rejected.

## [1.15.0] - 2026-07-10

### New

- **Remote access:** the new [private relay](https://docs.openchamber.dev/private-relay/) reaches your instance from anywhere over an end-to-end-encrypted tunnel, with no open ports and no third-party tunnel. It switches on when you pair a device over it and switches off when no paired device uses it (thanks to @yulia-ivashko).
- **Mobile:** the iOS and Android apps are open for testing. Join the [iOS beta on TestFlight](https://testflight.apple.com/join/5ek6GU1E) or take the Android APK from the [latest release](https://github.com/openchamber/openchamber/releases/latest). Scan the QR code from "Add a device" on your server to connect.
- Mobile: the app moves between your home Wi-Fi and the private relay on its own, carrying the open session with it, with no re-pairing.
- **Pairing:** the redesigned ["Add a device"](https://docs.openchamber.dev/connect-devices/) dialog asks where the device will be used, Anywhere, Home network only, or This computer only, then shows a big QR code with a copyable link and closes itself once the device connects (thanks to @yulia-ivashko).
- Pairing: a link is a single-use code that expires and is redeemed when the device connects (thanks to @yulia-ivashko).
- Chat/Tools: every tool call expands to show its input, result, and errors, including MCP, plugin, and custom tools. Read and Skill stay compact links to their files.
- Chat/Tools: a JSON result opens in a navigable summary view with linked URLs and expandable nested data, next to the tree and raw JSON views.
- Mobile: iPad gets a split layout with a sessions sidebar that stays open and a resizable Changes/Files sidebar.
- Mobile: the app checks for OpenChamber updates itself, and Android shows a download toast.
- Mobile: a saved instance shows a live Connected status with the connection it is using.
- Desktop: a saved server keeps every connection its pairing link carried, going direct on your network and falling back to the relay away from it, including in a new window and after a restart.
- Desktop: Windows builds can start at login and minimize to the system tray (thanks to @achcyano).
- Projects: each project can set its own default model (thanks to @makeittech).
- Diff: a Last turn mode shows only what the latest turn changed.
- Chat: changed-file chips from the latest turn open that snapshot; chips from older turns stay read-only.
- Chat: code blocks can show line numbers that stay aligned while text streams in.
- Settings: a Wrap Code Block Lines setting in Settings → Chat controls how long lines wrap.
- Devices: the "Connect to this server" list shows each paired device with a live status, Connected · Local network or Relay, and a platform badge for iOS, Android, macOS, Windows, or Linux.

### Improvements

- Desktop: the servers list in Settings shows whether each server is reachable right now, and importing a pairing link is the main way to add one.
- Desktop: the header dropdown for instance, usage, and MCP is now built from cards, with usage grouped per provider, a colored status line and ping per host, and MCP servers together in one card.
- Desktop: switching to a host that was already checked happens straight away.
- Devices: a paired phone or desktop is named after the server's hostname, and the name you type when creating the link labels the device in the server's list.
- Chat: Mermaid diagrams have zoom controls (thanks to @c-w-xiaohei).
- Chat/Tools: an expanded file-edit or patch result has a button per file to open the diff or jump to the first changed line in the editor.
- Context Panel: raw message rows keep their token and time columns aligned and no longer show shortened message IDs.

### Fixes

- Desktop: host statuses stay put between openings and no longer flash "Unknown".
- Devices: re-pairing a device or re-entering its password updates the entry it already has instead of adding a duplicate.
- Chat/Thinking: reasoning parts stay separate and in the order they happened, and a collapsed preview no longer ends with empty HTML comments.
- Chat: with Sticky User Header on, a user message no longer floats over earlier messages in a long conversation.
- Chat: a message that timed out or lost the connection after OpenCode accepted it stays in the conversation instead of being marked failed.
- Mobile: files picked from the composer are attached even when the composer switches between its compact and expanded layouts while the picker is open.
- Browser: a link clicked inside an embedded browser tab keeps the tab on the page it navigated to.
- Server: remote clients with non-ASCII characters in a project path can connect again (thanks to @FanFan4204).
- UI: closing the right sidebar after resizing no longer leaves its old width behind.

## [1.14.1] - 2026-07-07

### New

- **Chat:** a finished reply can show a short recap and a suggested next message. Each one has its own setting.
- Settings: a Small Model setting picks the model that writes recaps, suggestions, and other helper text.
- Voice: read-aloud can summarize long text with the Small Model before speaking it.
- Chat: the timeline dialog loads older messages when the session history is not fully fetched yet.

### Improvements

- Notes/Todos: adding selected chat text to a note summarizes it with the Small Model.
- Git/GitHub: commit messages and pull-request text are written by the Small Model from settings.
- Chat: file references with a line range like `src/file.ts:10-20` are clickable (thanks to @Catan).
- Mobile: the dictation transcript grows the composer the same way typed text does.

### Fixes

- Git/Diff: opening a changed file jumps to the first changed line.
- Mobile: the composer keeps focus when the keyboard opens.
- Mobile: iOS PWA safe areas, keyboard overlays, and the connection check on app resume behave correctly.
- Desktop: a password-protected instance opened from the desktop app or a browser gets the right unlock screen.
- VS Code: favorite models stay saved after the extension restarts (thanks to @Catan).
- VS Code: closing Settings returns to the view you came from (thanks to @Catan).

## [1.14.0] - 2026-07-05

### New

- **Voice: dictate straight into the composer.** The mic shows a live transcript with a volume meter and timer while you speak. When you stop, you can cancel it, insert the text, or insert and send.
- **Mobile: a compact composer.** While the keyboard is closed the composer shrinks to a single bar, with a round new-session button beside it. Tap the bar to expand it and open the keyboard, or tap the mic to dictate.
- Voice: speech-to-text runs on your machine. Pick a model in Settings → Voice and it downloads on demand: Parakeet for English and 25 European languages, or Whisper for a lighter multilingual option.
- Voice: dictation can use any OpenAI-compatible Whisper endpoint instead of a local model.
- Voice: a shortcut turns dictation on and off, mod+alt+v by default, and you can change it.
- Voice: read-aloud can speak with a local Kokoro voice, in any of 11 English voices.
- Voice: a new "Enable voice input" toggle in Settings → Voice hides the composer mic.
- Mobile: drag the handle above the composer to write in a fullscreen editor. Swipe down to shrink it back or to dismiss the keyboard.
- Mobile: the attachment menu and the new-session project and branch pickers open as bottom sheets with search.
- Mobile: a button at the top of a long conversation loads older history, and it goes away once everything is loaded.

### Improvements

- Voice: read-aloud starts speaking a long reply after about a sentence.
- Voice: the Voice settings page is simpler. One read-aloud toggle owns all the playback options.
- Mobile: the model and agent selectors sit in a row above the message text.
- Mobile: the slash-command, file, agent, skill and snippet autocompletes are sized for touch. They can grow up to the top of the chat, row icons line up, and picking a command keeps the keyboard open.
- Mobile: loading older messages keeps your scroll position steady, on every platform.
- UI: long lists across the app scroll more consistently.
- Desktop: the app uses your own OpenCode install when you have one. The bundled CLI runs only when no OpenCode is installed anywhere on the machine.

### Fixes

- **Desktop: a local instance with a UI password and LAN access opens again.** It no longer gets stuck on "Auth required" and an unreachable-server screen, including when the server is bound to 0.0.0.0.
- Chat: the stop button aborts a session running in a different project or worktree. Those aborts used to do nothing at all.
- Windows: OpenCode installed via npm launches from paths with spaces such as C:\Program Files\nodejs, a binary path pasted with quotes around it works, and the app also looks in the system-wide npm prefix and Scoop's shims.
- Voice: a failed transcription keeps its audio, so you can retry it or accept the partial text.
- Mobile: a phone browser on a password-protected instance shows the password unlock page again, after 1.13.9 broke it.
- Mobile: the branch and worktree picker on the new-session screen lists every worktree right after a cold start.
- Mobile: the GitHub connection is recognized without re-running the connect flow.
- Mobile: returning to the app no longer flickers the session list.
- Mobile: the chat and composer ride the keyboard in one smooth motion, long conversations included.
- Mobile: bottom sheets slide in cleanly while the keyboard dismisses.
- Mobile: the text cursor stays where you left it when the keyboard opens.
- Mobile: starter suggestions on the new-session screen step aside while the keyboard is up.
- Mobile: switching instances clears the previous instance's sessions from the list.
- Mobile: scrolling an autocomplete list no longer bounces the page behind it.
- Mobile: in a phone browser the composer stays above the keyboard on the new-session screen and in the fullscreen editor.
- Mobile: opening the app shows the logo while it connects, with no flash of an unreachable-server error.

## [1.13.9] - 2026-07-02

### New

- **Mobile: the native iOS and Android apps are in the repo**, ahead of the mobile release. This round polished saved connections, password unlock, QR-code connection scanning, push notifications, iOS widgets, app resume, and native layout details.
- Desktop: the app ships with an OpenCode CLI, and you can point it at your own CLI path in settings instead.
- Desktop: a remote OpenChamber instance can carry custom headers, which is what Cloudflare Access-style setups need. Settings and environment variables still win over them.
- Desktop: a Keep awake setting stops the computer from sleeping while the app is running.

### Fixes

- Desktop: an SSH remote instance with a saved UI password opens straight after the tunnel connects, with no second trip through the unlock screen.
- Chat: late-loading tool content, subagent content and streaming Thinking blocks no longer pull the conversation away from the latest message or fight your scrolling.
- Chat: an embedded JSON example in a message stays text and no longer renders as a generated-result card.
- Sync: a chat wakes up properly after an idle reconnect, instead of leaving sessions stuck as busy.
- VS Code: clearing an optional agent field removes it from the agent config, where it used to save a `null`.
- VS Code: the extension looks past OpenCode desktop app installs when it hunts for the standalone OpenCode CLI.

## [1.13.8] - 2026-06-29

### New

- **Chat: choose what Enter does mid-reply.** A Follow-up behavior setting in Settings → Chat either steers your message into the agent's current turn or queues it until the turn finishes. It takes over from the old queue-mode toggle (thanks to @bashrusakh).

### Improvements

- Sessions: deleting a worktree group from the sidebar, or permanently deleting an archived session, now takes its subagent sessions with it (thanks to @bashrusakh).

### Fixes

- **Startup: the app is usable right away.** Launching it no longer hangs for around 20 seconds before you can open a session, load a diff, or send a message. GitHub pull request status checks were holding the connection to the server.
- **OpenCode: your own OpenCode is left alone.** When one is already running, whether the TUI, `opencode serve`, or a daemon on port 4096, the app starts its own server. This clears the "OpenChamber could not finish initialization" error and stops the app from opening or closing your OpenCode as it starts and quits.
- OpenCode: to connect to an external OpenCode on purpose, set `OPENCODE_HOST`, `OPENCODE_PORT`, or `OPENCODE_SKIP_START`.
- Sessions: clicking a session inside a worktree group keeps it selected, with no jump to the project's first session while the sidebar catches up (thanks to @bashrusakh).
- Sync: a connected but quiet session, say an agent running a long tool call, stops kicking off a background refresh every 15 seconds (thanks to @tomzx).

## [1.13.7] - 2026-06-28

### Improvements

- Mobile: the model and agent buttons in the composer are borderless and cleaner, show the provider logo beside the model name, and cut long names with an ellipsis.
- Mobile: in the model picker the thinking-variant control is plain text with a chevron, and each row's controls line up.

### Fixes

- **CLI: `openchamber update` works again.** A missing helper had broken the command.
- Providers: the Add provider form stays open while provider data refreshes or you pick a model in the background. It used to snap back to an existing provider.
- Chat: with tool calls such as Bash and Edit expanded by default, scrolling no longer twitches, and slow scrolling no longer jumps past several messages.
- Mobile: in a long conversation, older messages load before you reach the very top, and fast scrolling no longer leaves blank gaps where messages vanish until you scroll back.
- Mobile: interface labels, including the model and agent selectors, are back to their old size after 1.13.6 shrank them too much.

## [1.13.6] - 2026-06-28

### New

- **Desktop/macOS: the Dock icon can carry a badge** counting chats with unseen activity. A new Appearance setting turns it off.

### Improvements

- Chat: scrolling stays steady while you send, queue, stream, switch sessions, and load older messages.
- Context Panel: a chat tab is named after the session, and the chat you are looking at is marked as seen.

### Fixes

- Chat: picking a skill you installed from the slash command menu runs the skill and pulls in its content. It used to drop the skill name in as plain text.
- Context Panel: the Browser and Preview tabs stop piling up duplicate auth tokens in their URLs after reloads or navigation.

## [1.13.5] - 2026-06-27

### Fixes

- CLI: a global web install starts again instead of crashing as soon as a tunnel command loads ngrok.
- CLI: `openchamber update` works again.
- CLI: starting a tunnel works again with managed-local setup prompts, with a port picked for a second instance, and with a server the CLI started for you.
- GitHub: OpenChamber finds the upstream of a forked repository again.
- Usage: Google quota is shown again.

## [1.13.4] - 2026-06-27

### New

- **Reviews:** the Review changes dialog can run a review loop on its own. A banner in the chat opens the review sessions it starts, or stops them.
- Japanese: the interface is available in Japanese (thanks to @yuchi0531).
- Japanese: the documentation is available in Japanese (thanks to @yuchi0531).
- Chat: drag a queued message to move it up or down the queue (thanks to @makeittech).
- Shortcuts: you can pick your own key for opening the model selector (thanks to @makeittech).

### Improvements

- Models: the model picker keeps your provider groups open and in the order you put them, and Shift+Delete drops a model from recents (thanks to @makeittech).
- Git: a commit message or pull request written from a draft session now comes from the real chat session (thanks to @bashrusakh).
- CLI: startup and status commands check the port before treating a running process as your OpenChamber server.

### Fixes

- Chat: sending a message closes an open question, so the composer no longer keeps the answered prompt on screen (thanks to @tomzx).
- Chat: a conversation pinned to the bottom stays still after you send, and opening an older session lands on the latest message right away.
- Worktrees: a message sent to a brand new worktree session waits for the session and arrives (thanks to @bashrusakh).
- Agents: editing an agent on an external OpenCode server no longer says it saved when it did not (thanks to @makeittech).
- Providers: the add-provider form keeps the provider you picked (thanks to @IbrahimKhan12).

## [1.13.3] - 2026-06-24

### New

- **Git:** a Git identity can sign your commits with SSH.
- Agents: agent settings have thinking variant, temperature, and top-p controls (thanks to @bashrusakh).

### Improvements

- Agents: clearing temperature or top-p removes the override (thanks to @bashrusakh).
- Git: pushing from the Git view syncs first, so fewer pushes come back rejected.
- Settings: your font size and padding apply inside the VS Code extension too (thanks to @Sin991114).

### Fixes

- Chat: picking one of your own skills from the slash menu runs the skill instead of typing its name into the message (thanks to @IbrahimKhan12).
- Chat: a code block in your own message keeps characters like `<` and `->` (thanks to @bashrusakh).
- Chat: Arrow Up opens prompt history again when the cursor sits at the start of the composer.
- Chat: pasting text with an `@` in it no longer pops up file mentions (thanks to @charpeni).
- Chat: switching sessions or loading older messages no longer jumps the conversation backward or makes it wobble (thanks to @herjarsa).
- Sessions: a new session stays with the project or folder you picked (thanks to @bashrusakh).
- Sessions: pinned sessions and folders stay in the sidebar when a session list comes back empty (thanks to @bashrusakh).
- Settings/Models: per-model visibility and sibling model choices stay saved (thanks to @attilaszasz).
- Settings/Skills: the skills catalog reloads after you change catalog settings (thanks to @gokulkgm).
- Providers: disconnecting a provider from settings works.
- Usage: MiniMax M3 and Token Plan usage read the provider's current responses again (thanks to @baruchvitorino).
- Files: downloading a file with non-Latin characters in its name keeps the name (thanks to @FanFan4204).
- Startup: managed OpenCode processes left over from a crash are cleaned up on the next start.
- CLI: a leftover server PID file no longer makes the CLI treat an unrelated process as OpenChamber.
- Mobile: subagent chevrons no longer sit on top of a long session title (thanks to @weixiang1862, @lilyzhaun).
- Mobile: sessions are grouped by their exact folder (thanks to @weixiang1862, @lilyzhaun).

## [1.13.2] - 2026-06-18

### Improvements

- **Chat:** long conversations and big session lists stay smooth while a reply streams in (thanks to @bashrusakh).
- Startup: the app starts faster, it no longer waits for the default OpenCode config.

### Fixes

- Chat: the last words of a streamed reply are no longer cut off (thanks to @IbrahimKhan12).
- Chat: paragraphs in a reply have space between them again (thanks to @foundryseven).
- Files: HTML, image, and PDF previews stay open instead of asking for authentication every minute or so (thanks to @bashrusakh).
- Startup: your manual and per-folder model choices survive a restart.

## [1.13.1] - 2026-06-17

### New

- **Scheduled Tasks:** the task editor takes Cron expressions. It checks the expression as you type, offers example chips, and shows the next four runs (thanks to @tomzx).
- Chat: click a Mermaid diagram in a message to open it fullscreen and pan or zoom around it.
- Security: a self-hosted instance keeps search engines out with noindex headers and a robots.txt.

### Improvements

- Chat: pinned welcome starters are on screen as soon as a new draft session opens.
- Chat: the context usage indicator is a round progress ring, with the same colors, in every workspace header.
- Chat: embedded chat views and context panel previews follow your theme.
- Files: the file editor, Plan View, and the Skills page highlight more languages.
- Startup: providers and agents load faster.
- Right Sidebar: switching tabs redraws less of the rest of the screen (thanks to @bashrusakh).

### Fixes

- Chat: an amount like `$50` stays an amount. Only `$$...$$` and `\(...\)` are read as math.
- Chat: a reply full of code no longer freezes the page while it highlights.
- Chat: on Android, the session status button responds to taps.
- Sessions: the app no longer crashes at startup when you have many sessions in folders.
- Agents: deleting a built-in agent leaves it in place and explains why, instead of quietly disabling it.
- Agents: deleting an agent whose definition is missing shows an error instead of doing nothing.
- Notifications: desktop notifications no longer arrive twice.
- Notifications: reasoning text is left out of the notification body.
- Sessions: the session list loads steadily with Windows paths and with several requests at once.
- Diagnostics: duplicate health-check URLs are gone.

### Misc

- CLI: the installer needs Node.js 22, and it says what to do when it cannot read your version.

## [1.13.0] - 2026-06-15

### New

- Files: added dedicated PDF files previews mode.
- Files: added an optional docked files editor toolbar (thanks to @robertoberto).
- Git/Diff: individual diff hunks can now be staged, unstaged, or discarded directly from the Changes view via `git apply`.
- Git/Diff: added a review flow for starting a review from current changes.
- GitHub: GitHub settings can now use credentials from the `gh` CLI when available (thanks to @tomzx).
- Desktop: you can now open developer tools from the Help menu.
- Sessions: new draft sessions now start from the default model and agent instead of inheriting the previous session's selection, and fall back to OpenCode's own `default_agent` (and its model) when no OpenChamber default is set.
- Startup: the model and agent now appear faster on the initial draft — config loads under the project key up front (no reload when the draft opens) and the agent list is fetched once instead of per consumer.

### Improvements

- Security: LAN and remote browser access now require a UI password before the server will start.
- Desktop: if LAN access was enabled without a password, the app now starts locally and asks for a password before turning LAN access back on.
- Chat: file paths inside fenced code blocks are now clickable, including line and column targets (thanks to @robertoberto).
- Chat: context breakdowns now show message previews and cache hit rates (thanks to @robertoberto, @raz123).
- Chat/Performance: long conversations now use virtualized rendering to keep large histories responsive.
- Chat: custom-answer question textareas resize more steadily while typing (thanks to @bigcoder84).
- Chat/Input: Arrow Up moves the cursor inside multi-line drafts again instead of always opening prompt history.
- Files: file operations now use the active workspace directory more consistently (thanks to @tomzx).
- Sessions: session menus now include a delete action (thanks to @ShogunPanda).
- Sessions: selected rows now highlight across the full sidebar gutter.
- Comments: inline file/diff comment drafts now stay in place when focus changes.
- Git/Diff: redesigned the Changes diff view with faster multi-file rendering, expandable hunk separators, a full-file loading toggle, compact responsive controls, and a unified changed/staged context panel workflow.
- Settings/MCP: importing MCP snippets from OpenCode config works again (thanks to @youzini).
- Notifications: notification streams now stay connected more reliably behind proxies (thanks to @kostazol).
- Mobile: the empty Changes view keeps a close control visible (thanks to @lilyzhaun).
- Security: file previews and downloads now reject paths outside the allowed workspace unless access has been granted.
- Startup: cached settings and session state now appear earlier while the live API finishes connecting.
- VSCode: the extension opens faster with cached sessions, models, providers, and projects, then refreshes in the background.
- VSCode: sessions are now grouped under their workspace, with cleaner session rows and an archived-sessions toggle.

### Fixes

- Chat/Input: tab-completing a mention no longer changes the selected agent (thanks to @Quat3rnion).
- Chat/Mobile: collapsed tool cards now keep their tool icon visible, and reasoning/tool text no longer clips descenders.
- Sessions: deleting a parent session no longer brings deleted child sessions back into the sidebar (thanks to @panzeyu2013).
- Sessions: switching sessions no longer leaves the chat area blank in some cases (thanks to @panzeyu2013).
- Sessions: fixed a bug where a running session would briefly flicker as idle (in the sidebar, the send/stop button, and the status row) when the app is protected by a password.

## [1.12.4] - 2026-06-11

### New

- Chat: added `/handoff-review` to open a linked review session for the current workspace changes, with actions to send review feedback and implementation replies between the sessions.
- Chat/UI: added a setting to collapse long user messages.
- Chat: Mermaid diagrams can now be opened in a dedicated diagram editor (thanks to @nerdosaurus).
- Worktrees: creating a single new worktree session now opens the session immediately while worktree setup continues in the background.
- Settings: added search across settings pages.
- Files: added an editor Vim mode setting (thanks to @Champii).
- Desktop/macOS: added a menu bar tray with live session status, Mini Chat access, and a provider usage submenu.
- Desktop/macOS: added an optional vibrancy effect for the left sidebar.
- Mobile: refreshed session controls, worktree deletion flow, MCP controls, update flow, and usage tracking for new layout.
- Usage: added Cursor quota tracking.
- UI/Localization: added French interface translations and French documentation (thanks to @pascalandr).
- VSCode: added an action to archive all sessions from the extension (thanks to @jjdubski).
- VSCode: added multi-root workspace support, including workspace folder switching in the extension (thanks to @mmospanenko).

### Improvements

- Chat: `@agent` mentions in rendered messages now use the primary accent color.
- Chat: table copy actions now include a Markdown format option (thanks to @kjhq).
- Models: hidden models now stay hidden in multi-model selection controls (thanks to @kjhq).
- Multi-Run: creating isolated runs now opens sessions immediately while worktree setup continues in the background.
- Sessions: chat folder assignments now stay in place after reloads.
- Sessions: session, folder, project, and worktree rows now have right-click menus for their available actions.
- Settings/Agents: agent prompt and permission edits now stay saved after changes.
- Files: writes are now safer when saving through temporary files (thanks to @nerdosaurus).
- Git: changed-file folders now have a revert action (thanks to @kostazol).
- GitHub: issue and pull-request pickers now use server-side search for larger repositories (thanks to @tomzx).
- Voice: Plan and file preview markdown now include text-to-speech buttons, with a setting for reading selected text or the full document (thanks to @yangyaofei).

### Fixes

- Preview: inline module scripts are now rewritten in proxied HTML responses, fixing more Vite preview pages (thanks to @mdbetancourt).
- Desktop/macOS: startup no longer opens unnecessary folder prompts.
- Terminal/Mobile: touch scrolling in the terminal no longer conflicts with terminal input as often (thanks to @kostazol).

## [1.12.3] - 2026-06-05

### Improvements

- Startup: OpenCode health checks now work with OpenCode 1.15.x.

### Fixes

- Windows/Startup: WSL OpenCode installs are no longer detected or launched; install OpenCode natively on Windows and configure `opencode.cmd` or `opencode.exe` instead.
- Files: file trees now show directory loading errors with a retry action instead of leaving the folder empty, and slow Git ignore checks no longer block directory listings indefinitely.

## [1.12.2] - 2026-06-05

### New

- **Desktop/Windows: the Windows app is now available publicly, with full functionality parity across the app.**
- Projects: the Add Project directory picker now starts with hidden files off each time it opens.

### Improvements

- Tunnels: switching between Cloudflare and ngrok quick tunnels now replaces the active quick tunnel instead of reusing the previous provider.
- Tunnels: ngrok startup failures now show the ngrok or authtoken error returned during startup.
- Chat: prompts sent while creating or switching target sessions now stay attached to the intended project directory.
- VSCode: the extension now detects more Windows OpenCode installs from PATH, npm, Scoop, and Chocolatey.

## [1.12.1] - 2026-06-03

### New

- Chat: completed turns can now show changed-file chips with per-file additions and deletions, controlled by a new Chat setting.
- Sessions: recent sessions now stay visible inside project groups, and new or worktree sessions stay in the correct project/worktree group on desktop, mobile, and VS Code.

### Improvements

- Chat: LSP tool calls now show the operation, file, and cursor position more clearly, and JSON tool output can be toggled between formatted and raw views or copied.
- Chat: streaming messages now appear correctly after startup, and activity/status rows show for the active session.
- Chat/UI: sticky user-message headers are now off by default.
- Sessions: session titles update from live session events, and the app now consistently loads all existing OpenCode sessions.
- Settings/OpenCode: OpenCode CLI path, update-notification preference, keyboard shortcuts, and protected-session settings now stay saved after changes.
- UI/Time: the 12-hour/24-hour time preference now applies to chat timestamps, usage reset times, scheduled tasks, tunnels, passkeys, Git history, and pull-request dates.
- Settings/Files: the default file preview setting now lives with the Chat appearance settings and applies immediately to open file tabs.
- Desktop: Desktop tunnels now serve the full app UI instead of the headless page.
- Desktop: removed the legacy Tauri desktop path; Electron is now the only desktop runtime.

### Fixes

- Chat: completed responses no longer lose late-arriving summaries, token counts, errors, structured output, or changed-file details.
- Chat: question cards now show an error or no-longer-pending message when submit or dismiss fails instead of silently doing nothing.
- Chat: the first prompt in a new session no longer gets stuck before sending.
- Preview: embedded previews now rewrite inline module imports, fixing Vite React preview pages that load root-relative modules.
- Desktop: quitting the Desktop app now stops managed OpenCode processes more reliably, reducing leftover OpenCode processes after exit.

## [1.12.0] - 2026-06-03

### New

- Mobile: added a new mobile UI as the default, with an option in Settings to switch back to the previous layout; this is the foundation for the upcoming mobile app and is available to try now.
- Chat: added customizable draft welcome starters from commands and skills, including guided commands for planning, catch-up, debugging, and exploration.
- Chat: assistant answers now have a dialog for starting a new session from that answer.
- Web/Browser: added a Browser feature for opening websites in the web app and sharing annotations with screenshots to agents.
- Web/Remote Instances: added a headless web app mode, and remote instance switching now changes the OpenChamber API endpoint without loading the full remote UI.
- UI/Themes: added JetBrains Light and JetBrains Dark themes, and VS Code chat colors now map more closely to the active editor theme.

### Improvements

- Chat/UI: markdown-rendered user messages now preserve line breaks.

### Fixes

- Chat/Input: queued messages no longer auto-send before the active session is ready, and thinking-variant choices are preserved for generated messages.

## [1.11.7] - 2026-05-27

### New

- Git: commit history now includes a branch graph and commit-row actions in the history modal (thanks to @ermanhavuc).
- Desktop: added a launch-at-startup setting, and collapsed browser windows now keep their webview state.
- UI/Localization: added Traditional Chinese interface translations (thanks to @Jia35).
- Usage: added a setting to hide prediction rows on usage cards (thanks to @ermanhavuc).

### Improvements

- Notes/Todos: completed todos stay at the end of the list, and the send-to-session dialog has a cleaner model picker (thanks to @kostazol, @rghamilton3).

### Fixes

- Chat/Input: selecting an agent now switches to that agent's configured model, and malformed tool diffs no longer break chat rendering (thanks to @Adrian-Eckardt).
- Sessions: inline session renaming no longer exits immediately after focus changes (thanks to @youfch).
- VSCode: restored live streaming in the extension.

## [1.11.6] - 2026-05-25

### New

- Settings/Plugins: added a Plugins page for managing opencode plugins, with npm update checks and user/project scopes (thanks to @Quat3rnion).
- Tunnels: added Ngrok as a quick tunnel provider in the CLI and Desktop tunnel settings, with readiness checks (requires Ngrok cli and auth).
- Desktop: added optional password setting in OpenChamber sessions settings for the local Desktop server.
- Multi-Run: new multi-run sessions now appear in the session list immediately, and slash-command prompts are sent to the created run sessions correctly.

### Fixes

- Mobile: restored the new-session action in the session sidebar header.

## [1.11.5] - 2026-05-25

### New

- Sessions: session titles can now be renamed inline with a double-click (thanks to @robertoberto).
- Files: file search now shows the number of matches in the editor panel, and directory rows include a quick-add button (thanks to @attackonryan, @tomzx).
- Voice: OpenAI-compatible custom speech providers can now use API keys (thanks to @yangyaofei).

### Improvements

- Chat/Input: pending image attachments now show previews, sent image attachments can be cited from assistant messages, and markdown source mode highlights formatting while you type.
- Chat: queued messages now send to the session they were queued from, even if you switch sessions before they are sent.
- Git: changed files are split into staged and unstaged sections, and Git operations work correctly from repository subdirectories (thanks to @ShogunPanda, @kostazol).
- Settings/Skills: installed skills are discovered more accurately, skill files opened from tool messages now load correctly, and snippet names keep their canonical casing (thanks to @jkker, @isanchez404).
- Mobile/PWA: long-press tooltips work on touch screens, fullscreen panels keep the right header state, deleted or long-named files behave better in file lists, and Android PWA dialogs stay visible (thanks to @kostazol, @lilyzhaun).

### Fixes

- Chat/UI: chats keep following the latest response after final task summaries, activity reasoning no longer flashes before settling, and assistant timestamps stay visible on narrow layouts.

## [1.11.4] - 2026-05-22

### New

- Chat: added reusable snippets with `#` autocomplete in the composer and a Snippets settings page for global and project snippets with [opencode-snippets](https://github.com/JosXa/opencode-snippets) plugin compatibility.
- Multi-Run: runs can now be split into separate prompt/model groups, and Multi-Run prompts support command, file, agent, and snippet autocomplete (thanks to @tomzx).

### Improvements

- Desktop: Electron is now the desktop release target, with updated macOS menu actions for the right sidebar and terminal dock.
- UI: refreshed the desktop workspace shell with a full-width header, framed chat area, and smooth left/right sidebar open and close states.
- Chat: completed reasoning blocks stay collapsed without replaying the collapse animation when you reopen a session.
- Files: file search and mention results avoid mixing entries from similar query/cache keys (thanks to @isanchez404).
- VSCode: switching between chat sessions is less likely to stall on very large conversations.
- UI/Localization: refreshed Simplified Chinese terminology across the interface (thanks to @luojiyin).

### Fixes

- Voice: preview audio now stops and cleans up correctly when you stop playback or leave Voice settings (thanks to @isanchez404).

## [1.11.3] - 2026-05-19

### New

- Chat: slash command autocomplete now includes skills and clearer command/type badges.
- Updates/PWA: OpenCode update and PWA install prompts can now be dismissed without reappearing repeatedly (thanks to @robertoberto).

### Improvements

- Chat: question cards now include copy buttons for Markdown and JSON (thanks to @robertoberto).
- Chat: slash, file, skill, and agent autocomplete selection now stays steadier when using the keyboard or mouse.
- Chat: external links in messages now show favicons with better contrast, and skill links render correctly in user message rendered as markdown.
- Chat: multi-file tool diffs now render safely, including files with mixed line endings.
- Sessions: archived session lists handle large archives better, and sub-session expansion is kept separate between Recent and project sections (thanks to @vhqtvn).
- Sessions: deleting or archiving a parent session now shows a descendant count that matches what will actually be removed (thanks to @vhqtvn).
- Git: reverting a chat message now refreshes the Git changes view afterward.
- Terminal/Mobile: the terminal viewport now stays above the mobile keyboard more consistently (thanks to @Dav1dch).

### Fixes

- Notifications: browser and VS Code notifications work without duplicate alerts.
- Usage: added Wafer.ai quota tracking and removed the duplicate Zhipu usage provider entry (thanks to @bowber).

## [1.11.2] - 2026-05-18

### New

- Chat: thinking blocks can now be collapsed, and expanding tool details feels smooth (thanks to @ermanhavuc).
- Git: commit history can now show file diffs inline (thanks to @ermanhavuc).

### Improvements

- Chat: reverting or forking messages now keeps file attachments in place, with clearer undo/redo controls (thanks to @youfch, @ermanhavuc).
- Notes/Todos: context panel sizes are remembered, and todos can be reordered with drag and drop (thanks to @ermanhavuc).
- Git: branch history works better for local-only branches, and branch search fields accept typing again (thanks to @ermanhavuc).
- Sessions: root project sessions now show up correctly in the session switcher (thanks to @isanchez404).
- Skills: installed skills now match OpenCode's own skill list more closely.

## [1.11.1] - 2026-05-15

### New

- Multi-Run: added fusion for multi-run sessions.
- Multi-Run: added optional isolation and support for non-Git projects.
- Chat/Sessions: added a header session switcher with project, branch, diff, active, unread, and sub-session context.
- Desktop/Mini Chat: added session switching and the new-session shortcut to Mini Chat, while preserving user-selected sessions during startup.
- Updates/Usage: added a setting to disable OpenCode update notifications, and quota reset times now display in your local timezone.

### Improvements

- Chat/Subagents: opened subagent sessions read-only in the context panel and made subagent chats read-only.
- Chat/Shortcuts: made the agent-switching shortcut configurable and usable from the chat input/model picker.
- Preview: improved embedded preview proxying for absolute same-origin requests and WebSocket URLs, and avoided launching unrelated project actions when no dev-server action is detected.
- Chat/UI: sorted-mode tool paths animate consistently, and tooltip rendering is guarded defensively.
- Git: large change lists now display reliably, and branch selection stays hidden for non-Git draft sessions.
- Settings/Skills: the skills catalog now keeps the selected source label visible when switching sources (thanks to @kjhq).

## [1.11.0] - 2026-05-14

### New

- Updates/OpenCode: added in-app OpenCode update checks and upgrade actions.
- Voice: added local Whisper speech-to-text.

### Improvements

- Chat/Input: queued messages now auto-send one at a time in FIFO order, and model/agent selections persist across reloads (thanks to @lyxxx708, @chutastic).
- Chat/Performance: virtualized more timeline content, deferred heavy tool output, and improved scroll-to-bottom behavior.
- VSCode: improved chat sidebar command handoff, active-editor context updates, SSE cleanup, Agent Manager settings sync, and archived-session bulk delete reliability in the extension (thanks to @isanchez404, @jjdubski).
- Git: generalized repository provider handling beyond GitHub and made commit/PR generation more tolerant of JSON wrapped in assistant text.
- Terminal: rejected file paths as terminal working directories, preserved UTF-8 replay chunks, and cleaned up WebSocket/SSE listeners reliably during shutdown and reconnects (thanks to @isanchez404).
- Usage/Reliability: guarded quota percentages and reset timestamps defensively.

### Fixes

- Voice: synced speech recognition settings across devices and let server transcription finish processing audio when voice input stops (thanks to @kostazol).
- Chat/Permissions: restored `@agent` mentions in sent messages and parent-session auto-accept for child-session permissions.
- UI/Reliability: added smaller fixes for chunk-load recovery, locale retry behavior, stale attachment reads, scheduled tasks, session folders, and accessible Git/session controls (thanks to @isanchez404).

## [1.10.4] - 2026-05-09

### New

- Git/Worktrees: pull-request worktrees can now reuse an existing local branch when it matches the PR head.
- Settings/UI: improved keyboard and screen-reader support for resizable Settings navigation and collapsible sidebar groups (thanks to @isanchez404).

### Improvements

- Desktop/Mini Chat: improved Mini Chat session controls with current context usage in the compact header and a single header action that opens either the active session or current draft in Mini Chat.
- Chat/Input: model, variant, and agent labels collapse better on narrow widths.
- Terminal: cleaned up idle WebSocket connections and scoped SSE connection-open handling per retry attempt.
- Reliability/Sync: preserved message part update ordering (thanks to @isanchez404).

### Fixes

- Git: deduplicated lightweight and full status refreshes separately, preventing stale or mismatched Git updates during background polling (thanks to @isanchez404).
- Files: ignored stale file loads, guarded pending navigation, and stopped switching files when save fails.

## [1.10.3] - 2026-05-08

### New

- Desktop/Electron: added Mini Chat windows for focused conversations without the full workspace shell, including session/draft handoff back to the main window, always-on-top pinning, and quick access from the header, session list, command palette, and keyboard shortcuts.

### Improvements

- Desktop/Startup: show the splash window earlier while the local runtime starts.
- Chat/Scrolling: rebuilt auto-follow behavior for active responses.
- Chat/UI: tightened scroll-to-bottom behavior and code-block scrolling handoff.

### Fixes

- Chat/Scrolling: saved scroll positions restore consistently after session switches, hydration, and draft-to-session transitions.
- Chat/Input: fixed attachment-only queued sends, stale attachment restores, stale file-search results, autocomplete tab handling, and focusable removal controls (thanks to @isanchez404).
- Reliability/Sync: reduced stale and duplicate live-state updates across request arrays, retry metadata, streaming indicators, and session status events, cutting unnecessary rerenders and stuck activity states during long-running chats (thanks to @isanchez404).
- Files/Skills: ignored stale directory refreshes and outdated skills catalog/repo scans.
- Git/Terminal/Desktop: fixed sandbox database loading in ESM, forwarded lightweight Git status mode across runtimes, preserved Electron SSH desktop hosts when saving instances, and made terminal UTF-8 locale fallbacks platform-aware (thanks to @isanchez404, @liyiopener).
- UI/Reliability: added smaller polish fixes for mobile Settings Escape handling, Multirun model limits, text-selection cleanup, and upstream event-stream cancellation (thanks to @isanchez404).

## [1.10.2] - 2026-05-07

### New

- Projects: added repository cloning to the Add Project flow.

### Improvements

- Chat/Reliability: stabilized live turn rendering and session sync caches.
- Terminal: improved Android tablet keyboard handling, including control-key shortcuts, and kept app shortcuts from stealing focus while typing in the terminal (thanks to @Dav1dch).
- Terminal: set a UTF-8 locale for terminal sessions (thanks to @liyiopener).
- Usage: OpenRouter credit balances now avoid misleading percentage displays and use clearer labels across usage views (thanks to @zerone0x).
- Preview: improved embedded preview proxying with cleaner URL rewriting, fewer false-positive dev-server errors, steady navigation, and theme-aware preview frames.
- Notifications: suppressed inherited subagent completion notifications.
- VSCode: split the extension into a dedicated app root.

## [1.10.1] - 2026-05-06

### New

- Git: added one-click Sync and stash management, including stash access from a clean worktree.
- UI/Localization: added Polish interface translations, expanding language support for Polish-speaking users (thanks to @levy52).
- Sessions: added a quick archive action directly on session rows (thanks to @zoubenr).
- Files: added a manual save mode to the file editor.
- Chat/Timeline: added full-text timeline search across user, assistant, and tool messages in a session.
- Mobile/Terminal: added an opt-in keyboard resize mode and steady touch terminal input.

### Improvements

- Chat/Reliability: pending questions now survive session switches and directory eviction.
- VSCode/Reliability: aligned session status parsing and reconnect reconciliation (thanks to @vhqtvn).

### Fixes

- Git: improved sync safety and feedback with latest remote refs, clearer progress banners, less flicker during refresh, cleaner header controls, and better unavailable pull-request states.
- Terminal: restored focus back to terminal input after Ghostty element blur events.
- Startup/Reliability: configured OpenCode CLI paths are now validated before managed startup, with clearer errors for missing, non-executable, or app-bundle paths.
- Performance/Reliability: reduced duplicate app initialization, deferred heavier views, lowered local server status overhead, optimized markdown file-link detection, reduced sync recovery payloads, and suppressed expected missing-directory noise.

## [1.10.0] - 2026-05-05

### New

- Preview: added an embedded dev-server Preview pane for loopback apps, with authenticated proxying, Vite/HMR support, same-origin API request handling, and safer local dev-server shutdown (thanks to @wpbiggs).
- Preview: added preview console capture, DOM element inspection, annotation context, and Electron screenshot attachments.
- Projects/Terminal: added Auto-discover for local dev servers, background terminal startup, action-linked Preview reopen controls, and cleaner terminal tab styling (thanks to @wpbiggs).
- Settings/Behavior: added a dedicated Behavior page with global `AGENTS.md` configuration and response style presets.
- VSCode/Chat: added the currently open editor file to chat context (thanks to @daveotero).
- Onboarding/Updates/Mobile: added OpenCode CLI auto-detection during onboarding, cross-checks update prompts against npm, and improved iPad/tablet controls for fewer false update notices and smooth touch use (thanks to @IslamNofl).

### Improvements

- UI/Settings: improved settings scrolling, empty states, and button/overlay polish (thanks to @Yabuku-xD).
- GitHub/Git: improved fork-aware issue and pull-request listing, PR status handling, startup loading feedback, remote MCP headers, and long model ID handling (thanks to @corrm, @ricautomation, @yart).

### Fixes

- Chat/UI: added a wide layout option, steady scroll position across sessions and generated prompts, less flicker during streaming, and safer rendering for malformed message parts (thanks to @jwcrystal, @pasta-paul).
- Reliability/Streaming: reconnects now recover immediately after OS wake-from-sleep, long agent sessions avoid streaming hangs, concurrent sessions sharing the same provider are throttled more safely, and model metadata refreshes after OpenCode restarts (thanks to @jwcrystal, @pasta-paul, @Yabuku-xD).

## [1.9.10] - 2026-04-28

### New

- UI/Localization: added Korean interface translations and default new installs back to English when no language has been chosen (thanks to @An-jinu).
- VSCode/Windows: normalized Windows drive-letter paths in extension webviews and added MiniMax/Ollama quota support.

### Improvements

- Chat/Models: unified the model picker across desktop and mobile with a cleaner selection flow (thanks to @daveotero).
- Projects: improved the project directory picker with expandable pinned folders and better file/path handling.
- Chat/UI: improved split-response action placement, error-message alignment, tab close affordances, and overscroll behavior.

### Fixes

- Sessions/Sidebar: fixed stale session, folder, project, and worktree state after mutations, and polished pinned-session indicators (thanks to @corrm, @Yabuku-xD).
- Reliability/Startup: hardened managed OpenCode startup, preserved shell PATH reliably, ignored stale downgrade update prompts, and improved stream/proxy recovery with heartbeat support.

## [1.9.9] - 2026-04-26

### New

- UI/Localization: added a localization foundation with translated interface strings for Spanish, Brazilian Portuguese, Ukrainian, and Simplified Chinese.
- Settings/Appearance: added selectable interface and code fonts with 10 choices each.
- Chat/Workflow: added keyboard turn navigation, widened chat content, and introduced local workspace review and summarize slash commands.
- Files/Editor: added an "Open files in preview mode" setting and improved multi-file edit/diff safety (thanks to @daveotero).
- Desktop/Web/Mobile: improved Electron update restart behavior, PWA service-worker notifications, mobile keyboard handling, and the Add Project panel flow (thanks to @Jovines, @vhqtvn).

### Improvements

- Chat/Mobile: improved mention and autocomplete behavior with complete results, clearer active-tab scoping, and less context-switching while drafting prompts.
- Chat/Tasks: todo list progress now updates live as task status changes, and task/model status hints are steady during active runs (thanks to @Yabuku-xD).
- Reliability/Performance: improved cold start and streaming responsiveness with lazy-loaded heavy components, chunk-load recovery, lower re-render churn, and safer reconnect/local-stream recovery (thanks to @Yabuku-xD, @jwcrystal, @vhqtvn).

## [1.9.8] - 2026-04-22

### New

- Chat/Commands: added `/summary` slash command for a non-destructive session summary - optional topic hint after the command focuses the output, and the prompt is customizable under Settings: Magic Prompts.

### Improvements

- Settings/Sync: settings updates now sync reliably across clients, and sidebar session pagination is steady in larger workspaces.
- Sessions/Folders: folder changes now persist through server-backed endpoints.
- Notifications: permission notifications are now suppressed when auto-accept is enabled.
- UI: improved the bottom scroll shadow and hid the tasks row when there is no active work.
- Reliability/Desktop: improved live event-stream recovery after transient stalls, wait briefly before failing chat actions during reconnects, and persist Electron server logs for easier disconnect debugging.

### Fixes

- Sessions/Reliability: fixed parent-child session sync during reconnects and navigation (thanks to @jwcrystal).
- Chat/Files: improved changed-files handling in chat and restored quick file-open flows from pending changes (thanks to @jwcrystal).
- Desktop/macOS: System color mode now tracks OS theme changes, traffic-light controls stay visible after dock restore, and update restart/changelog handling is more reliable.

## [1.9.7] - 2026-04-22

### New

- Desktop: added an Electron desktop runtime in parallel with the current Tauri app, with Electron planned to become the default path in an upcoming release.
- Plans/Notes/Todos: added editable project plans from assistant messages, external plan upload, configurable planning magic prompts, and quicker note/todo handoff into new sessions or worktrees.
- Chat/Files: you can now drag files and folders from the file tree into chat, with improved `@folder` autocomplete (thanks to @youfch).
- Files/Git: added a file-change summary bar and auto-refresh for open files changed outside the app.

### Improvements

- Settings/MCP: improved MCP auth flow with better remote-config support and clearer diagnostics, and aligned config resolution with OpenCode behavior (thanks to @daveotero, @cyan).
- Reliability/Chat: hardened bootstrap and stream-connection recovery, preserved session/connect state, and reduced streaming UI churn.

### Fixes

- Sessions/UI: added bulk session selection in the sidebar and fixed pinned sessions (thanks to @yart).
- Git/Worktrees: improved branch/worktree reliability by allowing checkout with uncommitted changes, tightening worktree cache invalidation, and reducing incorrect remote prefetches (thanks to @jwcrystal, @jasonalsing).
- Web/PWA: added install orientation controls and fixed loopback-origin handling for web push notifications in local setups (thanks to @vhqtvn, @yart).

## [1.9.6] - 2026-04-17

### New

- Reliability/Streaming: switched live message events to a WebSocket-first transport with SSE fallback, added response compression, and hardened proxy/compression handling (thanks to @geekifan, @jwcrystal).
- Sessions/Scheduled Tasks: added scheduled task creation and management with locale-aware scheduling.
- Files: added a full Go to Line workflow (toolbar + shortcut + dialog) and a new Copy Relative Path action (thanks to @coldbrow).
- Chat/Export: added export session as Markdown and improved empty-state/export behavior (thanks to @coldbrow).
- Desktop: added quick open and a LAN access toggle, plus safer quit behavior around scheduled tasks (thanks to @An-jinu).
- Chat/Markdown: added LaTeX rendering support for clearer math and technical notation in messages (thanks to @ricautomation).

### Improvements

- Sessions/Worktrees: enforced session worktree isolation and tightened session-switch safety.
- Files: file trees now auto-refresh when files change outside the app (thanks to @jwcrystal).
- Settings/Skills: skills are now sorted within groups (thanks to @tomzx).

### Fixes

- Chat/Requests: restored blocking request visibility in sub-sessions, scoped auto-approve to the active session tree, and reduced noisy auto-approved notifications during multi-session work.

## [1.9.5] - 2026-04-14

### New

- Security/Auth: added passkey sign-in for protected instances and new 1-week/30-day session expiration options (thanks to @daveotero, @pm0u).
- Voice: added OpenAI-compatible custom server support for both text-to-speech and speech-to-text, including configurable TTS model/pitch/volume and stricter custom URL validation for safer setup (thanks to @ablepharus).

### Improvements

- Sync/Performance: optimized multi-session streaming with per-directory queues, event coalescing, and parts-gap recovery to keep live updates smooth under heavy activity (thanks to @jwcrystal).
- Sessions/UI: kept active sessions visible in Recent, auto-expanded parent groups when opening subagent sessions, and hid empty archived/folder sections (thanks to @jwcrystal).

### Fixes

- Chat/Tool Output: added an interactive tree viewer for structured outputs and fixed JSON quote rendering (thanks to @yaozhenghangma).
- Chat/Reliability: fixed question-tool content disappearing after refresh and hardened subagent/session recovery paths.
- Git/UI: restored Git changes panel visibility and sidebar sync (thanks to @jwcrystal).
- Desktop/Startup: delivered a more guided first-launch and smart recovery flow, plus startup and remote-window interaction fixes to reduce early-session friction (thanks to @jwcrystal).
- Usage: added Zhipu AI Coding Plan tracking and restored model-variant compatibility with older OpenCode runtimes (thanks to @cainiao1992, @Chi-square-test).

## [1.9.4] - 2026-04-07

### Improvements

- Chat/Performance: reduced streaming render churn across the app.
- Chat/Tool Output: LSP diagnostics now render directly in tool output (thanks to @yulia-ivashko).
- Usage: refreshed MiniMax CN coding-plan quota data (thanks to @nzlov).

### Fixes

- Settings/Magic Prompts: added a dedicated Magic Prompts page with editable templates for commit/PR generation, PR and issue reviews, failed-check/comment analysis, and merge/cherry-pick conflict resolution.
- Chat/Scrolling: fixed jumpy follow behavior and restored stable bottom-resume/live-compaction updates.
- Reliability/Streaming: improved reconnect, retry, and directory-aware event routing to reduce stuck session/subagent states after transient disconnects (thanks to @jwcrystal, @daveotero).
- Models: added defensive handling for missing model pricing/capability metadata (thanks to @Chi-square-test).
- Desktop/Performance: removed costly window translucency and reduced duplicate notification triggers for a cooler, less noisy desktop experience.
- Startup/Remote: restored remote provider startup behavior and tightened host/port detection to reduce false startup failures.

## [1.9.3] - 2026-03-01

### New

- VSCode/Files: added file stat support in the extension bridge (thanks to @geekifan).
- Chat/Models: added arrow-key navigation for thinking-mode selection in model controls (thanks to @daveotero).
- Files: added HTML preview support in the file viewer (thanks to @nguyenngothuong).
- Chat/JSON: added an interactive JSON tree viewer with collapse/expand controls and richer color cues for easier inspection of large structured outputs (thanks to @nguyenngothuong).

### Improvements

- Security/Chat: user messages now escape raw HTML by default (thanks to @kalac2232).
- Desktop/Performance: reduced Tauri shell CPU/GPU overhead during longer sessions.
- Sessions/Drafts: draft chat config now stays synced with the selected draft target directory.
- Chat: improved error message readability with clearer styling and safer word-wrapping (thanks to @nguyenngothuong).
- Desktop/Settings: window vibrancy now correctly controls macOS window transparency, and settings copy now clarifies when full transparency changes take effect.
- Reliability/Proxy: hardened OpenCode proxy header handling (including identity-encoding normalization, compression-header cleanup, hop-by-hop response-header stripping) and suppressed expected SSE close noise.
- Terminal/Reliability: switched terminal transport to a pure WebSocket path with fallback handling.

### Fixes

- Mobile/Settings: fixed lingering settings drawers and removed extra top spacing for a cleaner, less obstructed mobile layout (thanks to @Jovines).
- Git/Worktrees: fixed worktree detection and reset stale integration state when switching contexts.
- Reliability/Proxy: restored proxied chat event streaming.
- Usage/Providers: added ZhipuAI quota tracking and fixed MiniMax coding-plan and GitHub Copilot overusage calculations (thanks to @kalac2232, @baruchvitorino, @ebrainte).

## [1.9.2] - 2026-03-31

### New

- Worktrees/Multi-Run: added instant draft-first worktree creation and redesigned the multi-run launcher with a cleaner, faster flow for parallel runs.
- CLI/Server: added `--foreground` for process-manager deployments, made managed server hostname configurable, and added an explicit `--host` option with safer localhost defaults (thanks to @colinmollenhour, @rapidrabbit76, @yulia-ivashko).

### Improvements

- Chat/Performance: rebuilt live session sync and streaming updates to cut render churn, reduce CPU spikes, and keep long-running chats smooth and more stable across runtimes.
- VSCode/UI: polished the extension chat and sidebar with improved spacing, tooltips, a resizable sessions pane, and file-to-chat mention flows from Explorer.
- Models/Providers: improved custom provider model metadata loading and caching (thanks to @ZeppLu).
- Docker/Deployments: improved container defaults, including UID 1000 user behavior, non-fatal SSH key generation, and better localhost detection in container networking (thanks to @yulia-ivashko).

### Fixes

- Web/PWA: fixed manifest behavior behind Cloudflare Access (thanks to @arthurfiorette).

## [1.9.1] - 2026-03-20

### New

- Usage: added MiniMax Weekly quota provider support (thanks to @nzlov).

### Improvements

- Chat/GitHub: linked issues and pull requests now appear as user-message attachments and open reliably across runtimes.
- Settings/MCP: adding MCP servers now consistently respects user vs project scope, preventing user-scope entries from being written into project config files.
- VSCode/Reliability: managed server startup now imports login-shell environment values and normalizes Windows workspace paths.
- Sessions: sidebar lists now keep sessions visible in both Recent and Project sections for easier discovery (thanks to @nguyenngothuong).
- Files: file trees now refresh incrementally after create/rename/delete actions (thanks to @nguyenngothuong).
- Sessions/Worktrees: draft sessions now resolve the correct project when opened from worktree paths (thanks to @yulia-ivashko).

### Fixes

- Sessions/UI: restored Project Notes access in the sidebar, polished notes/todo editing, and fixed project action overlap.
- Desktop: improved stale server-process cleanup on startup and fixed external link opening behavior (thanks to @jwcrystal).

## [1.9.0] - 2026-03-20

### New

- Chat/Permissions: added a session-based permission auto-accept toggle and polished permission-shield visuals for quicker, clearer approval workflows.
- Git: refreshed history visuals and added clearer branch-boundary markers.
- Git: added remote removal from sync workflows and stabilized polling to reduce noisy background refreshes (thanks to @yulia-ivashko).
- Files: added debounced editor auto-save (thanks to @nguyenngothuong).

### Improvements

- UI/Navigation: delivered a major sidebar redesign with clearer hierarchy, unified action patterns, and improved session organization (thanks to @yulia-ivashko).
- Chat: reduced streaming CPU usage and background churn with steady turn rendering, debounced updates, and less storage thrash during long runs.
- Panels/UI: softened panel resize affordances and tightened service dropdown/layout spacing for a cleaner, less distracting workspace.
- Files: reworked search UI for searching in files.
- Desktop/macOS: lowered the minimum supported macOS version to Ventura (13.0), expanding compatibility on older systems (thanks to @craigharman).
- Updates/Reliability: unified update-check behavior across runtimes.

### Fixes

- Chat: fixed scroll-to-latest and timeline tracking behavior.
- Settings/UI: fixed settings scrolling on mobile, made outside-click closing immediate, and reduced settings load churn/CPU spikes.
- Reliability/Platform: improved Windows path/process behavior and restored macOS PTY/microphone compatibility.

## [1.8.7] - 2026-03-13

### Improvements

- CLI: hardened entrypoint detection across direct, symlinked, and shim-based launches to keep startup behavior consistent across package managers (thanks to @shekohex).
- Deployment/Docker: improved `docker run` startup behavior and entrypoint handling (thanks to @nzlov).

### Fixes

- CLI: fixed a startup regression in global npm/bun installs where wrapper or symlinked `openchamber` entrypoints could exit without output on commands like `--version` or `status`.
- Windows/Web: daemon startup and Git operations no longer flash extra console windows (thanks to @SergioChan).

## [1.8.6] - 2026-03-13

### New

- Chat/Settings: added richer chat render controls, including sorted/live behavior, compact live Activity previews, and options to keep Bash/Edit outputs open by default.
- Sessions/GitHub: overhauled sidebar session loading and GitHub PR tracking, and added a new minimal sidebar sessions mode on Desktop/Web.

### Improvements

- Tunnel/CLI: rebuilt tunnel workflows around clearer managed modes and provider-aware lifecycle commands, with safer startup checks, improved diagnostics, and cleaner CLI output for everyday remote access (thanks to @yulia-ivashko).
- Chat: completed a turn-based rendering pipeline that keeps streaming, activity rows, and tool progress more stable in long runs, with smooth auto-follow and fewer jumpy updates.
- Sessions: worktrees with active sessions now surface earlier in the sidebar (thanks to @GhostFlying).
- Projects/Desktop: project action inputs now submit with Enter, and Desktop settings now include a spell-check toggle for writing comfort (thanks to @DocterZed).
- Mobile/PWA: install metadata now honors orientation lock consistently.

### Fixes

- Chat: fixed narrow-layout send behavior for modified Enter shortcuts (thanks to @eengad).
- Chat: fixed queue-button behavior and focus-mode composer sizing.

## [1.8.5] - 2026-03-04

### Improvements

- Desktop: startup now opens the app shell much earlier while background services continue loading.
- VSCode: edit-style tool results now open directly in a focused diff view.
- UI/Theming: unified loading logos and startup screens across runtimes, with visuals that better match your active theme.
- Projects/UI: project icons now follow active theme foreground colors consistently.
- Reliability: improved early startup recovery.
- Mobile/PWA: respected OS rotation lock by removing forced orientation behavior in the web app shell (thanks to @theluckystrike).

### Fixes

- Desktop/macOS: fixed early title updates that could shift traffic-light window controls on startup.
- VSCode: cleaned up extension settings by removing duplicate display controls and hiding sections that do not apply in the editor environment.
- Chat: fixed focus-mode composer layout.
- Tunnel/CLI: fixed one-time Cloudflare tunnel connect links in CLI output for `--try-cf-tunnel` (thanks to @plfavreau).

## [1.8.4] - 2026-03-04

### New

- Chat: added clickable file-path links in assistant messages (including line targeting) (thanks to @yulia-ivashko).
- Chat: added a new `Changes` tool-output mode that expands edits/patches by default while keeping activity readable (thanks to @iamhenry).
- Chat/GitHub: added Attach menu actions to link GitHub issues and PRs directly in any session.
- Shortcuts/Models: added favorite-model cycling shortcuts (thanks to @iamhenry).
- Sessions: added active-project session search in the sidebar, with clearer match behavior and easier clearing during filtering (thanks to @KJdotIO).
- Mobile/Projects: added long-press project editing with a bottom-sheet panel and drag-to-reorder support (thanks to @Jovines).
- Web/PWA/Android: added improved install UX with pre-install naming and manifest shortcut updates (thanks to @shekohex).

### Improvements

- Chat: in-progress tools now appear immediately and stay live in collapsed activity view (thanks to @nelsonPires5).
- Chat: improved long user-message behavior in sticky mode with bounded height, internal scrolling, and cleaner action hit targets.
- Chat/Files: improved `@` file discovery and mention behavior with project-scoped search and more consistent matching.
- Worktrees/GitHub: streamlined worktree creation with a unified flow for branches, issues, and PR-linked sessions, including cleaner validation and faster branch loading.
- Files/Desktop: improved `Open In` actions from file views/editors, including app selection behavior and tighter integration for opening focused files (thanks to @yulia-ivashko).
- UI: interactive controls now consistently show pointer cursors.
- Security/Reliability: hardened terminal auth, tightened skill-file path protections, and reduced sensitive request logging exposure for safer day-to-day usage (thanks to @yulia-ivashko).

### Fixes

- Chat/Files: restored user image previews/fullscreen navigation and improved text-selection action placement on narrow layouts.
- Worktrees/Git: fixed branch/PR source resolution (including slash-named branches and fork PR heads).
- Git: fixed a PR panel refresh loop that could trigger repeated updates and unstable behavior in the PR section (thanks to @yulia-ivashko).

## [1.8.3] - 2026-03-02

### New

- Chat: added user-message display controls for plain-text rendering and sticky headers.
- Chat: model picker now supports collapsible provider groups and remembers expanded state between sessions.

### Improvements

- Chat/UI: overhauled the context panel with reusable tabs and embedded session chat (_beta_).
- Git: refined Git sidebar tab behavior and spacing, plus bulk-revert with confirmations for easier cleanup.
- Settings: reorganized chat display settings into a more compact two-column layout.

### Fixes

- Chat: improved code block presentation with cleaner action alignment, restored horizontal scrolling, and polished themed highlighting across chat messages and tool output (thanks to @nelsonPires5).
- Diff: added quick open-in-editor actions from diff views that jump to the first changed line.
- Git: fixed commit staging edge cases by filtering stale deleted paths before staging.
- Git/Worktrees: restored branch rename/edit controls in draft sessions when working in a worktree directory.
- Mobile/UI: fixed session-title overflow in compact headers (thanks to @iamhenry).

## [1.8.2] - 2026-03-01

### New

- Chat: added a new "Share as image" action (thanks to @Jovines).

### Improvements

- Updates: hardened the self-update flow with safer release handling and fallback behavior.
- Chat: improved message readability with cleaner tool/reasoning rendering and less noisy activity timing in busy conversations (thanks to @nelsonPires5).
- Desktop/Chat: permission toasts now include session context and a clearer permission preview (thanks to @nelsonPires5).
- Notifications/Voice: consolidated TTS and summarization service wiring for steady text-to-speech and summary flows (thanks to @nelsonPires5).

### Fixes

- VSCode: fixed live streaming edge cases for event endpoints with query/trailing-slash variants.
- Reliability: improved event-stream/session visibility handling when the app is hidden or restored.
- Windows: fixed CLI/runtime path and spawn edge cases to reduce startup and command failures on Windows (thanks to @plfavreau).
- Deployment: fixed Docker build/runtime issues (thanks to @nzlov).

## [1.8.1] - 2026-02-28

### Fixes

- Web/Auth: fixed an issue where non-tunnel browser sessions could incorrectly show a tunnel-only lock screen; normal auth flow now appears unless a tunnel is actually active.

## [1.8.0] - 2026-02-28

### New

- Desktop: added SSH remote instance support with dedicated lifecycle and UX flows (thanks to @shekohex).
- Projects: added project icon customization with upload/remove and automatic favicon discovery from your repository (thanks to @shekohex).
- Projects: added header project actions on Web and Mobile.
- Desktop: added dynamic window titles that reflect active project and remote context (thanks to @shekohex).
- Remote Tunnel: added tunnel settings with quick/named modes, secure one-time connect links (with QR), and saved named-tunnel presets/tokens (thanks to @yulia-ivashko).
- UI: added an expandable project rail with project names, a settings toggle, and saved expansion state for easier navigation in multi-project setups (thanks to @nguyenngothuong).
- UI/Files: added file-type icons across file lists, tabs, and diffs (thanks to @shekohex).
- Files: added a read-only highlighted view with a quick toggle back to edit mode (thanks to @shekohex).
- Deployment: added Docker deployment support with safer container defaults and terminal shell fallback (thanks to @nzlov).
- Usage: added MiniMax coding-plan quota provider support (thanks to @nzlov).
- Usage: added Ollama Cloud quota provider support (thanks to @iamhenry).

### Improvements

- Projects/Desktop: project actions can also open SSH-forwarded URLs.
- UI: expanded sprite-based file and folder icons across Files, Diff, and Git views (thanks to @shekohex).
- Files: markdown preview now handles frontmatter more cleanly.
- Chat: improved long-session performance with virtualized message rendering, smooth scrolling, and more stable behavior in large histories (thanks to @shekohex).
- Chat: enabled markdown rendering in user messages for clearer formatted prompts and notes (thanks to @haofeng0705).
- Chat: edit tools now use the same diff style as the dedicated Diff view (thanks to @shekohex).
- Chat: pasted absolute paths are now treated as normal messages.
- Chat: upgraded Mermaid rendering with a cleaner diagram view plus quick copy/download actions (thanks to @shekohex).
- Notifications: improved child-session notification detection to reduce missed or misclassified subtask updates (thanks to @Jovines).
- Reliability: improved Windows compatibility across git status checks, OpenCode startup, path normalization, and session merge behavior (thanks to @mmereu).

### Fixes

- Chat: fixed queued sends for inactive sessions.

## [1.7.5] - 2026-02-25

### New

- Web: added `OPENCODE_HOST` support (thanks to @colinmollenhour).

### Improvements

- UI: moved projects into a dedicated sidebar rail and tightened the layout.
- Sessions: reduced session-switching overhead to make chat context changes feel more immediate.
- Reliability/Auth: migrated session auth storage to signed JWTs with a persistent secret.
- Mobile/Chat: refined message spacing and removed the top scroll shadow for a cleaner small-screen reading experience (thanks to @Jovines).

### Fixes

- Chat: fixed an issue where messages could occasionally duplicate or disappear during active conversations.
- Mobile: pending permission prompts now recover after reconnect/resume instead of getting lost mid-run (thanks to @nelsonPires5).
- Web/Mobile: fixed in-app update flow in containerized setups.

## [1.7.4] - 2026-02-24

### New

- Chat: added fullscreen Mermaid preview, persisted default thinking variant selection, and hardened file-preview safety checks for a safer, more predictable message experience (thanks to @yulia-ivashko).
- Settings: added an MCP config manager UI to simplify editing and validating MCP server configuration (thanks to @nguyenngothuong).
- Files: added C, C++, and Go language support for syntax-aware rendering in code-heavy workflows (thanks to @fomenks).

### Improvements

- Settings: redesigned the settings workspace with flatter, more consistent page layouts.
- Settings: improved agents and skills navigation by grouping entries by subfolder for easier management at scale (thanks to @nguyenngothuong).
- Chat: draft text now persists per session, and the input supports an expanded focus mode for longer prompts (thanks to @nguyenngothuong).
- Sessions: expanded folder management with subfolders, cleaner organization actions, and clearer delete confirmations (thanks to @nguyenngothuong).
- Git/PR: moved commit-message and PR-description generation to active-session structured output.
- Chat Activity: improved Structured Output tool rendering with dedicated title/icon, clearer result descriptions, and more reliable detailed expansion defaults.
- Notifications/Voice: moved utility model controls into AI Summarization as a Zen-only Summarization Model setting.
- Mobile: refreshed drawer and session-status layouts (thanks to @Jovines).
- Desktop: improved remote instance URL handling (thanks to @shekohex).

### Fixes

- Chat: improved streaming smoothness and stability with buffered updates and runtime fixes.

## [1.7.3] - 2026-02-21

### New

- Settings: added customizable keyboard shortcuts for chat actions, panel toggles, and services (thanks to @nelsonPires5).
- Sessions: added custom folders to group chat sessions, with move/rename/delete flows and persisted collapse state per project (thanks to @nguyenngothuong).

### Improvements

- Notifications: improved agent progress notifications and permission handling to reduce noisy prompts during active runs (thanks to @nguyenngothuong).
- UI: unified clipboard copy behavior across Desktop app, Web app, and VS Code extension.
- Reliability: improved startup environment detection by capturing login-shell environment snapshots.
- Reliability: refactored OpenCode config/auth integration into domain modules for steady provider auth and command loading flows (thanks to @nelsonPires5).

### Fixes

- Diff/Plans/Files: restored GitHub-style inline comments (thanks to @nelsonPires5).
- Terminal: restored terminal text copy behavior (thanks to @shekohex).

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
- Maintenance: removed deprecated GitHub Actions cloud runtime assets and docs to reduce setup confusion (thanks to @yulia-ivashko).

### Fixes

- Mobile: fixed accidental abort right after tapping Send on touch devices.

## [1.7.0] - 2026-02-17

### New

- UI: added a context overview panel with token usage, cost breakdown, and raw message inspection to make session debugging easier.

### Improvements

- Chat: improved live streaming with part-delta updates and smarter auto-follow scrolling.
- Chat: Mermaid diagrams now render inline in assistant messages, with quick copy/download actions for easier sharing.
- Sessions: project icon and color customizations now persist reliably across restarts.
- Reliability: managed local OpenCode runtimes now use rotated secure auth and tighter lifecycle control across runtimes.
- Git/GitHub: improved backend reliability for repository and auth operations (thanks to @nelsonPires5).

## [1.6.9] - 2026-02-16

### New

- Sessions: added a persistent project notes and todos panel (thanks to @gsxdsm).
- Sessions: introduced the ability to pin sessions within your groups for easy access.
- Settings: added a configurable Zen model for commit messages generation and summarization of notifications (thanks to @gsxdsm).
- Usage: added NanoGPT quota support and hardened provider handling (thanks to @nelsonPires5).

### Improvements

- **UI: redesigned the workspace shell with a context panel, tabbed sidebars, and quicker navigation across chat, files, and reviews.**
- UI: compact model info in selection (price + capabilities) (thanks to @nelsonPires5).
- Diff: improved large diff rendering and interaction performance for smooth reviews on heavy changesets.
- Worktrees: shipped an upstream-first flow across supported runtimes (thanks to @yulia-ivashko).
- Git: improved pull request branch normalization and base/remote resolution to reduce PR setup mismatches (thanks to @gsxdsm).
- Reliability: startup now auto-detects and safely connects to an existing OpenCode server.

### Fixes

- Chat: fixed file attachment issues and added exceeded-quota information.
- Desktop: restored desktop window geometry and position (thanks to @yulia-ivashko).
- Mobile: fixes for small-screen editor, terminal, and layout overlap issues (thanks to @gsxdsm, @nelsonPires5).

## [1.6.8] - 2026-02-12

### New

- Chat: added drag-and-drop attachments with inline image previews.

### Improvements

- Chat: improved agent/model picking with fuzzy search across names and descriptions.
- Usage: corrected Gemini and Antigravity quota source mapping and labels (thanks to @gsxdsm).
- Usage: when using remaining-quota mode, usage markers now invert direction to better match how remaining capacity is interpreted (thanks to @gsxdsm).

### Fixes

- Sessions: fixed a sidebar issue where draft input could carry over when switching projects.
- Chat: improved quick navigation from the sessions list by adding double-click to jump into chat and auto-focus the draft input; also fixed mobile session return behavior (thanks to @gsxdsm).
- Desktop: fixed project selection in opened remote instances.
- Desktop: fixed opened remote instances that use HTTP (helpful for instances under tunneling).

## [1.6.7] - 2026-02-10

### New

- Voice: added built-in voice input and read-aloud responses with multiple providers (thanks to @gsxdsm).
- Git: added multi-remote push selection and smarter fork-aware pull request creation to reduce manual branch/remote setup (thanks to @gsxdsm).
- Usage: added usage pace and prediction indicators in the header and settings (thanks to @gsxdsm).
- Desktop: added multi-window support with a dedicated "New Window" action for parallel work across projects (thanks to @yulia-ivashko).

### Improvements

- UI: refreshed header and settings layout, improved host switching, and upgraded the editor for smooth day-to-day navigation and editing.

### Fixes

- Diff/Plans: fixed comment draft collisions and improved multi-line comment editing in plan and file workflows (thanks to @nelsonPires5).
- Notifications: stopped firing completion notifications for comment draft edits to reduce noisy alerts during review-heavy sessions (thanks to @nelsonPires5).
- Settings: added confirmation dialogs for destructive delete/reset actions to prevent accidental data loss.
- Reliability: fixed message loading edge cases, stabilized voice-mode persistence across restarts, and improved update flow behavior across platforms.

## [1.6.6] - 2026-02-09

### New

- Desktop: added an `Open In` button to open the current workspace in Finder, Terminal, and supported editors with remembered app preference (thanks to @yulia-ivashko).
- Git: added push/pull with remote selection, plus in-app rebase/merge flows with improved remote inference and clearer conflict handling (thanks to @gsxdsm).
- Notifications: added smarter templates with concise summaries (thanks to @gsxdsm).

### Improvements

- Desktop: redesigned the main workspace with a dedicated Git sidebar and bottom terminal dock.
- Header: combined Instance, Usage, and MCP into one services menu.
- Git: reorganized the Git workspace with improved in-app PR workflows.
- Files: improved editing with breadcrumbs, better draft handling, smooth editor interactions, and more reliable directory navigation from file context (thanks to @nelsonPires5).
- Sessions: improved status behavior, faster mobile session switching with running/unread indicators, and clearer worktree labels when branch name differs (thanks to @Jovines, @gsxdsm).
- Terminal: improved input responsiveness with a persistent low-latency transport for steady typing (thanks to @shekohex).

### Fixes

- Usage: added per-model quota breakdowns with collapsible groups, and fixed provider dropdown scrolling (thanks to @nelsonPires5, @gsxdsm).
- Mobile: fixed chat input layout issues on small screens (thanks to @nelsonPires5).
- Reliability: fixed OpenCode auth pass-through and proxy env handling to reduce intermittent connection/auth issues (thanks to @gsxdsm).

## [1.6.5] - 2026-02-06

### New

- Settings: added an OpenCode CLI path override.
- Chat: added arrow-key prompt history and an optional setting to persist input drafts between restarts (thanks to @gsxdsm).
- Diff/Plans: added inline comment drafts (thanks to @nelsonPires5).
- Sessions: you can now rename projects directly from the sidebar, and issue/PR pickers are easier to scan when starting from GitHub context (thanks to @shekohex, @gsxdsm).
- UI: added Vitesse Dark and Vitesse Light theme presets.

### Improvements

- Chat: thinking/reasoning blocks now render consistently, and justification visibility settings now apply reliably (thanks to @gsxdsm).
- Worktrees: improved worktree flow reliability, including cleaner handling when a worktree was already removed outside the app (thanks to @gsxdsm).
- Terminal: improved Android keyboard behavior and removed distracting native caret blink in terminal inputs (thanks to @shekohex).
- Reliability: improved OpenCode binary resolution and HOME-path handling across runtimes for steady local startup.

## [1.6.4] - 2026-02-05

### New

- Chat: select text in messages to quickly add it to your prompt or start a new session (thanks to @gsxdsm).
- Diff/Plans: add inline comment drafts (thanks to @nelsonPires5).
- Git: improved macOS SSH agent support for smooth private-repo auth (thanks to @shekohex).

### Improvements

- Desktop: switch between local and remote OpenChamber instances, plus a thinner runtime.
- Mobile: split Agent/Model controls and a quick commands button with autocomplete (Commands/Agents/Files) for easier input (thanks to @Jovines, @gsxdsm).
- Terminal/Syntax: font size controls and Phoenix file extension support (thanks to @shekohex).
- Usage: expanded quota tracking with more providers (including GitHub Copilot) and a provider selector dropdown (thanks to @gsxdsm, @nelsonPires5).
- GitHub: PR description generation supports optional extra context (thanks to @nelsonPires5).

### Fixes

- VSCode: improved Windows PATH resolution and cold-start readiness checks to reduce "stuck loading" for sessions/models/agents.
- Web: fixed missing icon when installing the Android PWA (thanks to @nelsonPires5).

## [1.6.3] - 2026-02-02

### Improvements

- Web: improved server readiness check to use the `/global/health` endpoint.
- VSCode: improved server health check with the proper health API endpoint and increased timeout for steady startup (thanks to @wienans).

### Fixes

- Web: added login rate limit protection to prevent brute-force attempts on the authentication endpoint (thanks to @Jovines).
- Settings: dialog no longer persists open/closed state across app restarts.

## [1.6.2] - 2026-02-01

### New

- Usage: new multi-provider quota dashboard to monitor API usage across OpenAI, Google, and z.ai (thanks to @nelsonPires5).
- Terminal: added tabbed interface to manage multiple terminal sessions per directory.
- Files: added multi-file tabs on desktop and dropdown selector on mobile (thanks to @nelsonPires5).
- UI: introduced a token-based theming system, 18 themes with light/dark variants, and custom user themes from `~/.config/openchamber/themes`.

### Improvements

- Settings: now opens in a windowed dialog on desktop with backdrop blur.
- Diff: optimized stacked view with worker-pool processing and lazy DOM rendering for smooth scrolling.
- Worktrees: workspace path now resolves correctly when using git worktrees (thanks to @nelsonPires5).

### Fixes

- Projects: fixed directory creation outside workspace in the Add Project modal (thanks to @nelsonPires5).

## [1.6.1] - 2026-01-30

### New

- UI: update dialog now includes the changelog.
- Terminal: added optional on-screen key bar (Esc/Ctrl/arrows/Enter) for easier terminal navigation.
- Notifications: added "Notify for subtasks" toggle to silence child-session notifications during multi-run (thanks to @Jovines).
- Worktrees: starting new worktree sessions now defaults to HEAD when no start point is provided.
- Git: commit message generation now includes untracked files and handles `git diff --no-index` comparisons reliably (thanks to @MrLYC).

### Improvements

- Mobile: revamped chat controls on small screens with a unified controls drawer (thanks to @nelsonPires5).
- Reliability: improved event-stream reconnection when the app becomes visible again.
- Desktop: improved macOS window chrome and header spacing, including steady traffic lights on older macOS versions (thanks to @yulia-ivashko).

### Fixes

- Chat: added Stop button to cancel generation mid-response.

## [1.6.0] - 2026-01-29

### New

- Chat: added message stall detection with automatic soft resync.

### Improvements

- Git: PR picker now validates local branch existence and includes a refresh action.
- Git: worktree integration now syncs clean target directories before merging.
- VSCode: session activity status now updates reliably even when the webview is hidden.
- Web: session activity tracking now works consistently across browser tabs.

### Fixes

- Chat: fixed "Load older" button behavior in chat with proper pagination implementation.
- Diff: fixed memory leak when viewing many modified files; large changesets now lazy-load for smooth performance.
- Reliability: plans directory no longer errors when missing.

## [1.5.9] - 2026-01-28

### New

- UI: Files, Diff, Git, and Terminal now follow the active session/worktree directory, including new-session drafts.

### Improvements

- Worktrees: migrated to the OpenCode SDK worktree implementation; sessions in worktrees are now completely isolated.
- Git: integrate worktree commits back to a target branch with commit previews and guided conflict handling.
- Files: toggle markdown preview when viewing files (thanks to @Jovines).
- Files: open the file viewer in fullscreen for focused review and editing (thanks to @TaylorBeeston).
- Plans: switch between markdown preview and edit mode in the Plan view.

### Fixes

- Web: plan lists no longer error when the plans directory is missing.

## [1.5.8] - 2026-01-26

### New

- Plans: new Plan/Build mode switching support with dedicated Plan content view with per-session context.
- Web: iOS safe-area support for the PWA header.
- Activity: added a text-justification setting for activity summaries (thanks to @iyangdianfeng).

### Improvements

- GitHub: sign in with multiple accounts and smooth auth flow.
- Chat/UI: linkable mentions, better wrapping, and markdown/scroll polish in messages.
- Skills: ClawdHub catalog now pages results and retries transient failures.
- Mobile: improved layout for attachments, git, and permissions on small screens (thanks to @nelsonPires5).

### Fixes

- Diff: fixed Chrome scrolling in All Files layout.
- Reliability: file lists and message sends handle missing directories and transient errors better.

## [1.5.7] - 2026-01-24

### Improvements

- GitHub: PR panel supports fork PR detection by branch name.

### Fixes

- GitHub: Git tab PR panel can send failed checks/comments to chat with hidden context; added check details dialog with Actions step breakdown.
- Web: GitHub auth flow fixes.

## [1.5.6] - 2026-01-24

### New

- Sessions: start new sessions from GitHub issues with seeded context (title, body, labels, comments).
- Sessions: start new sessions from GitHub pull requests with PR context baked in (including diffs).

### Improvements

- GitHub: connect your account in Settings with device-flow auth to enable GitHub tools.
- Git: manage pull requests in the Git view with AI-generated descriptions, status checks, ready-for-review, and merge actions.

### Fixes

- Mobile: fixed CommandAutocomplete dropdown scrolling (thanks to @nelsonPires5).

## [1.5.5] - 2026-01-23

### Improvements

- Navigation: URLs now sync the active session, tab, settings, and diff state for shareable links and reliable back/forward (thanks to @TaylorBeeston).
- Settings: agent and command overrides now prefer plural directories while still honoring legacy singular folders.
- Skills: installs now target plural directories while still recognizing legacy singular folders.
- Web: improved push subscription handling across multiple windows.

### Fixes

- Web: push notifications no longer fire when a window is visible, avoiding duplicate alerts.

## [1.5.4] - 2026-01-22

### New

- Chat: new Apply Patch tool UI with diff preview for patch-based edits.
- Web: added Background notifications for PWA.

### Improvements

- Files: refreshed attachment cards and related file views for clearer context.
- Settings: manage provider configuration files directly from the UI.
- UI: updated header and sidebar layout for a cleaner, tighter workspace fit (thanks to @TheRealAshik).

### Fixes

- Diff: large diffs now lazy-load to avoid freezes (thanks to @Jovines).
- Reliability: connect to external OpenCode servers without auto-start and fixed subagent crashes (thanks to @TaylorBeeston).

## [1.5.3] - 2026-01-20

### New

- Settings: new memory limits controls for session message history.
- Chat: new Activity view in collapsed state, now shows latest 6 tools by default.

### Improvements

- Files: edit files inline with syntax highlighting, draft protection, and save/discard flow.
- Files: toggles to show hidden/dotfiles and gitignored entries in file browsers and pickers (thanks to @syntext).
- Chat: smooth session switching with more stable scroll anchoring.
- Git: generated commit messages now auto-pick a gitmoji when enabled (thanks to @TheRealAshik).
- Performance: faster filesystem/search operations and general stability improvements (thanks to @TheRealAshik).

### Fixes

- Chat: fixed message copy on Firefox for macOS (thanks to @syntext).
- Appearance: new corner radius control and restored input bar offset setting (thanks to @TheRealAshik).

## [1.5.2] - 2026-01-17

### New

- Sessions: added branch picker dialog to start new worktree sessions from local branches (thanks to @nilskroe).
- Sessions: added project header worktree button, active-session loader, and right-click context menu in the sessions sidebar (thanks to @nilskroe).
- Git: added gitmoji picker in commit message composer with cached emoji list (thanks to @TaylorBeeston).
- UI: added one-click diagnostics copy in the About dialog.

### Improvements

- Sessions: improved worktree delete dialog with linked session details, dirty-change warnings, and optional remote branch removal.
- Chat: optimized message loading for opening sessions.
- VSCode: tuned layout breakpoint and server readiness timeout for steady startup.
- Reliability: improved OpenCode process cleanup to reduce orphaned servers.

## [1.5.1] - 2026-01-16

### Fixes

- Desktop: fixed orphaned OpenCode processes not being cleaned up on restart or exit.
- OpenCode: fixed a crash when reloading configuration.

## [1.5.0] - 2026-01-16

### New

- UI: added a new Files tab to browse workspace files directly from the interface.
- Git Identities: added "default identity" setting with one-click set/unset and automatic local identity detection.
- VSCode: added responsive layout with sessions sidebar + chat side-by-side when wide, compact header, and streamlined settings.

### Improvements

- Diff: enhanced the diff viewer with mobile support and the ability to ask the agent for comments on changes.
- VSCode: improved server management to ensure it initializes within the workspace directory with context-aware readiness checks.
- Web: the server now automatically resolves and uses an available port if the default is occupied.

### Fixes

- Web/VSCode: fixed orphaned OpenCode processes not being cleaned up on restart or exit.
- Stability: fixed heartbeat race condition causing session stalls during long tasks (thanks to @tybradle).
- Desktop: fixed commands for worktree setup access to PATH.

## [1.4.9] - 2026-01-14

### New

- VSCode: added session editor panel to view sessions alongside files.
- Diff: added stacked/inline diff mode toggle in settings with sidebar file navigation (thanks to @nelsonPires5).

### Improvements

- VSCode: improved server connection reliability with multiple URL candidate support.
- Upload: increased attachment size limit to 50MB with automatic image compression to 2048px for large files.

### Fixes

- Mobile: fixed iOS keyboard safe area padding for home indicator bar (thanks to @Jovines).

## [1.4.8] - 2026-01-14

### New

- Git Identities: added token-based authentication support with ~/.git-credentials discovery and import.
- Settings: consolidated Git settings and added opencode zen model selection for commit generation (thanks to @nelsonPires5).
- Web Notifications: added configurable native web notifications for assistant completion (thanks to @vio1ator).
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

### Fixes

- Web: fixed issues in terminal.

## [1.4.6] - 2026-01-09

### New

- Chat: added question tool support with a rich UI for interaction.

### Improvements

- VSCode/Web: switched OpenCode CLI management to the SDK.
- Input: removed auto-complete and auto-correction.
- Shortcuts: switched the agent cycling shortcut from Shift+Tab back to Tab.

## [1.4.5] - 2026-01-08

### New

- Chat: added support for model variants (thinking effort).
- Skills: added autocomplete for skills on "/" when it is not the first character in input.
- Autocomplete: added scope badges for commands/agents/skills.
- MCP: added the ability to dynamically enable or disable configured MCP servers.
- Web: refactored the Add Project UI with autocomplete.

### Improvements

- Shortcuts: switched the agent cycling shortcut from Tab to Shift+Tab.
- Compact: changed `/summarize` to `/compact` and moved compaction to the SDK.

## [1.4.4] - 2026-01-08

### New

- Agent Manager: added "Copy Worktree Path" action in the more menu (thanks to @wienans).
- Worktrees: added session creation flow with loading screen, auto-create worktree setting, and setup commands management.
- Settings: added the ability to create new sessions in worktrees by default.
- Git view: added branch rename for worktree.
- Projects: added multi-project support with per-project settings for agents/commands/skills.
- Tunnel: added QR code and password URL for Cloudflare tunnel (thanks to @martindonadieu).

### Improvements

- Agent Manager / Multi Run: select agent per worktree session (thanks to @wienans).
- Agent Manager / Multi Run: worktree actions to delete group or individual worktrees, or keep only selected one (thanks to @wienans).
- Session sidebar: refactored the unified view for sessions in worktrees.
- Event stream: improved SSE with heartbeat management, permission bootstrap on connect, and reconnection logic.

### Fixes

- Chat: fixed IME composition for CJK input to prevent accidental send (thanks to @madebyjun).
- Model selector: fixed dropdowns not responding to viewport size.

## [1.4.3] - 2026-01-04

### New

- VS Code extension: added Agent Manager panel to run the same prompt across up to 5 models in parallel (thanks to @wienans).
- Added permission prompt UI for tools configured with "ask" in opencode.json, showing requested patterns and "Always Allow" options (thanks to @aptdnfapt).
- Added "Open subAgent session" button on task tool outputs to quickly navigate to child sessions (thanks to @aptdnfapt).

### Improvements

- VS Code extension: improved activation reliability and error handling.

## [1.4.2] - 2026-01-02

### New

- Added timeline dialog (`/timeline` command or Cmd/Ctrl+T) for navigating, reverting, and forking from any point in the conversation (thanks to @aptdnfapt).
- Added `/undo` and `/redo` commands for reverting and restoring messages in a session (thanks to @aptdnfapt).
- Added fork button on user messages to create a new session from any point (thanks to @aptdnfapt).

### Improvements

- Desktop app: keyboard shortcuts now use Cmd on macOS and Ctrl on web/other platforms (thanks to @sakhnyuk).
- Migrated to OpenCode SDK v2 with improved API types and streaming.

## [1.4.1] - 2026-01-02

### New

- Added the ability to select the same model multiple times in multi-agent runs for response comparison.
- Model selector now includes search and keyboard navigation.
- Added revert button to all user messages (including first one).
- Added HEIC image support for file attachments with automatic MIME type normalization for text format files.
- VS Code extension: added Git backend integration for UI access (thanks to @wienans).
- Web app: terminal backend now supports a faster Bun-based PTY when Bun is available, with automatic fallback for existing Node-only setups.

### Improvements

- VS Code extension: only shows the main Worktree in the Chat Sidebar (thanks to @wienans).
- Terminal: improved terminal performance and stability by switching to the Ghostty-based terminal renderer, while keeping the existing terminal UX and per-directory sessions.

### Fixes

- Terminal: fixed several issues with terminal session restore and rendering under heavy output, including switching directories and long-running TUI apps.

## [1.4.0] - 2026-01-01

### New

- Added the ability to run multiple agents from a single prompt, with each agent working in an isolated worktree.
- Worktrees: new branch creation can start from a chosen base; remote branches are only created when you push.
- Web app: added Cloudflare Quick Tunnel support for simpler remote access (thanks to @wojons and @aptdnfapt).

### Improvements

- Git view: improved branch publishing by detecting unpublished commits and automatically setting the upstream on first push.
- VS Code extension: default location is now the right secondary sidebar in VS Code, and the left activity bar in Cursor/Windsurf; navigation moved into the title bar (thanks to @wienans).
- Sidebar: improved readability for sticky headers with a dynamic background.

### Fixes

- Mobile: improved keyboard/input bar behavior (including Android fixes and better keyboard avoidance) and added an offset setting for curved-screen devices (thanks to @auroraflux).
- Chat: now shows clearer error messages when agent messages fail.

## [1.3.9] - 2025-12-30

### New

- Added skills management to settings with the ability to create, edit, and delete skills (make sure you have the latest OpenCode version for skills support).
- Added Skills catalog functionality for discovering and installing skills from external sources.
- VS Code extension: added right-click context menu with "Add to Context," "Explain," and "Improve Code" actions (thanks to @wienans).

## [1.3.8] - 2025-12-29

### New

- Added Intel Mac (x86_64) support for the desktop application (thanks to @rothnic).
- Added queued message mode with chips, batching, and idle auto‑send (including attachments).
- Added queue mode toggle to OpenChamber settings (chat section) with persistence across runtimes.

### Improvements

- Build workflow now generates separate builds for Apple Silicon (arm64) and Intel (x86_64) Macs (thanks to @rothnic).
- Improved dev server HMR by reusing a healthy OpenCode process to avoid zombie instances.
- Refactored Agents/Commands management with ability to configure project/user scopes.

### Fixes

- Fixed scroll position persistence for active conversation turns across session switches.

## [1.3.7] - 2025-12-28

### New

- Added mobile-friendly drill-down navigation for settings.
- Added responsive tab labels in settings header (icons only at narrow widths).
- Introduced enhanced VSCode extension settings with dynamic layout based on width.

### Improvements

- Redesigned Settings as a full-screen view with tabbed navigation.
- ESC key now closes settings; double-ESC abort only works on chat tab without overlays.
- Improved session activity status handling and message step completion logic.

## [1.3.6] - 2025-12-27

### New

- Added the ability to manage (connect/disconnect) providers in settings.

### Improvements

- Adjusted auto-summarization visuals in chat.

## [1.3.5] - 2025-12-26

### New

- Added Nushell support for OpenCode CLI operations.
- Added Discord links in the about section.
- Added settings for choosing the default model/agent to start with in a new session.

### Improvements

- Improved file search with fuzzy matching capabilities.
- Enhanced mobile responsiveness in chat controls.
- Improved provider loading reliability during workspace switching.

### Fixes

- Fixed workspace switching performance and API health checks.
- Fixed session handling for non-existent worktree directories.

## [1.3.4] - 2025-12-25

### Improvements

- Diff view now loads reliably even with large files and slow networks.
- VS Code extension: improved type checking and editor integration.

### Fixes

- Fixed getting diffs for worktree files.

## [1.3.3] - 2025-12-25

### New

- VS Code extension: added an animated loading screen and introduced command for status/debug output.

### Improvements

- Updated OpenCode SDK to 1.0.185 across all app versions.
- Chat UI: improved agent activity status behavior and reduced image thumbnail sizes.

### Fixes

- VS Code extension: fixed startup, more reliable OpenCode CLI/API management, and stabilized API proxying/streaming.
- Fixed session activity tracking.
- Fixed directory path handling (including `~` expansion) to prevent invalid paths and related Git/worktree errors.
- Chat UI: improved turn grouping/activity rendering and fixed message metadata/agent selection propagation.

## [1.3.2] - 2025-12-22

### Improvements

- Updated OpenCode SDK to the latest version.

### Fixes

- Fixed new bug session when switching directories.

## [1.3.1] - 2025-12-22

### New

- The app opens to a new chat by default.
- Updated app identity with new logo and icons across all platforms.

### Fixes

- New chats no longer create a session until you send your first message.
- Fixed mobile and VSCode sessions handling.

## [1.3.0] - 2025-12-21

### New

- Added revert functionality in chat for user messages.

### Improvements

- Polished mobile controls in chat view.
- Updated user message layout/styling.
- Improved header tab responsiveness.
- Adjusted VSCode extension theme mapping and model selection view.
- Polished file autocomplete experience.

### Fixes

- Fixed bugs with new session creation when the VSCode extension initialized for the first time.

## [1.2.9] - 2025-12-20

### New

- Added session auto-cleanup with configurable retention across app versions, including the VSCode extension.
- Added web package updates from the mobile/PWA settings view.
- Added several optimizations for long sessions.

## [1.2.8] - 2025-12-19

### New

- Added a web update flow that does not require CLI interaction.
- Added a web install script with package manager detection.

### Improvements

- Web server update/restart now reuses previously set parameters like port or password.

## [1.2.7] - 2025-12-19

### New

- Introduced keyboard shortcuts help menu and quick actions menu.

### Improvements

- Comprehensive macOS native menu bar entries.
- Redesigned directory selection view for web/mobile with improved layout.
- Improved theme consistency across dropdown menus, selects, and command palette.

## [1.2.6] - 2025-12-19

### New

- Added write/create tool preview in permission cards with syntax highlighting.

### Improvements

- More descriptive assistant status messages with tool-specific and varied idle phrases.
- Polished Git view layout.

## [1.2.5] - 2025-12-19

### Improvements

- Polished the chat experience for longer sessions.
- Improved inactive-state handling in the Desktop app.
- Redesigned Git tab layout with improved organization.
- Smoother session rename experience.

### Fixes

- Fixed file links from Git view to Diff.
- Fixed untracked files in new directories not showing individually.

## [1.2.4] - 2025-12-18

### New

- Added macOS app menu entries for Check for Update and bug/request reports in Help.

### Fixes

- Mobile: added settings, improved terminal scrolling, and fixed app layout positioning.

## [1.2.3] - 2025-12-17

### New

- Added image preview support in Diff tab (shows original/modified images instead of base64 code).

### Improvements

- Improved diff view visuals and aligned styling across widgets.
- Optimized Git polling and background diff/syntax pre-warming for faster Diff tab opening.
- Optimized reloading unaffected diffs.

## [1.2.2] - 2025-12-17

### Improvements

- Agent Task tool now renders progressively with live duration and completed sub-tools summary.
- Unified markdown rendering between assistant messages and tool outputs.
- Reduced markdown header sizes.

## [1.2.1] - 2025-12-16

### Improvements

- Todo task tracking: collapsible status row showing AI's current task and progress.
- Switched "Detailed" tool output mode to only open the 'task', 'edit', 'multiedit', 'write', 'bash' tools.

## [1.2.0] - 2025-12-15

### Improvements

- Favorite & recent models for quick access in model selection.
- Tool call expansion settings: collapsed, activity, or detailed modes (thanks to @theblazehen).
- Font size & spacing controls (50-200% scaling) in Appearance Settings (thanks to @theblazehen).
- Settings page access within VSCode extension (thanks to @theblazehen).

## [1.1.6] - 2025-12-15

### Improvements

- Optimized diff view layout with smaller fonts and compact hunk separators.
- Improved mobile experience: simplified header, better diff file selector.
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
- Enhanced VSCode extension theming with editor themes.

### Fixes

- Fixed mobile view model/agent selection.

## [1.1.3] - 2025-12-14

### New

- Added line wrap toggle in diff view with dynamic layout switching (auto-inline when narrow).

### Improvements

- Replaced Monaco diff editor with Pierre/diffs.

## [1.1.2] - 2025-12-13

### New

- Added feedback messages for "Restart API Connection" command.

### Improvements

- Moved VS Code extension to activity bar (left sidebar).
- Removed redundant VS Code commands.
- Enhanced UserTextPart styling.

## [1.1.1] - 2025-12-13

### Improvements

- Adjusted model/agent selection alignment.

### Fixes

- Fixed user message rendering issues.

## [1.1.0] - 2025-12-13

### New

- Added assistant answer fork flow.
- Added OpenChamber VS Code extension with editor integration: file picker, click-to-open in tool parts.
- Added git polling backoff optimization.

### Improvements

- Improved scroll performance with force flag and RAF placeholder.

## [1.0.9] - 2025-12-08

### New

- Added directory picker on first launch to reduce macOS permission prompts.
- Show changelog in update dialog from current to new version.
- Added macOS folder access usage descriptions.

### Improvements

- Improved update dialog UI with inline version display.

## [1.0.8] - 2025-12-08

### New

- Added fallback detection for OpenCode CLI in `~/.opencode/bin`.
- Added window focus after app restart/update.

### Improvements

- Adapted traffic lights position and corner radius for older macOS versions.

## [1.0.7] - 2025-12-08

### Improvements

- Optimized OpenCode binary detection.
- Adjusted app update experience.

## [1.0.6] - 2025-12-08

### Improvements

- Enhanced shell environment detection.

## [1.0.5] - 2025-12-07

### Improvements

- Disabled devtools and page refresh in production builds.

### Fixes

- Fixed "Load older messages" incorrectly scrolling to bottom.
- Fixed page refresh getting stuck on splash screen.

## [1.0.4] - 2025-12-07

### Improvements

- Optimized desktop app start time.

## [1.0.3] - 2025-12-07

### Improvements

- Updated onboarding UI.
- Updated sidebar styles.

## [1.0.2] - 2025-12-07

### Improvements

- Updated macOS window design.

## [1.0.1] - 2025-12-07

### New

- Initial public release of OpenChamber web and desktop packages in a unified monorepo.
- Added GitHub Actions release pipeline with macOS signing/notarization, npm publish, and release asset uploads.
- Introduced OpenCode agent chat experience with section-based navigation, theming, and session persistence.
