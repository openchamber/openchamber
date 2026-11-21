# UI hooks

## Ownership

`packages/ui/src/hooks` holds React hooks that connect shared surfaces to app state: session activity and status, the chat timeline's scroll ownership, TTS and dictation playback, URL routing, keyboard shortcuts, directory and project resolution, worktree resolution, background synchronization, and the desktop tray bridge.

A hook here owns the lifetime of what it subscribes to. Mechanics that another module already documents stay there: chat scroll detail in `components/chat/lib/scroll/DOCUMENTATION.md`, read-aloud playback in `lib/voice/DOCUMENTATION.md`, URL semantics in `lib/router/DOCUMENTATION.md`, worktree reads in `lib/worktrees/DOCUMENTATION.md`, and provider registries in `lib/source-control/DOCUMENTATION.md`.

## Invariants

### Session activity and queued sends

- A pending permission or a form that still holds the turn makes a session idle, so the send button stays a send and the user can supersede the prompt. A form whose tool call has ended holds nothing, and the turn keeps Stop and Queue.
- The trailing assistant message is a transient fallback only until the directory's status snapshot arrives. OpenCode lists only running sessions, so once the snapshot has landed an omitted status means idle. A turn OpenCode was stopped under keeps its assistant message incomplete forever, and must not read as busy.
- A running background subagent does not hold the prompt queue: the parent session is idle and accepts a prompt, as the server queue does.
- The queue re-reads its state at dispatch time instead of trusting the render-time snapshot, and keys in-flight sends by session rather than directory, so a session that moves mid-send cannot start a second send from its new directory.
- A queued message is delivered as captured: mentions resolved, attachments kept, and the send configuration recorded at queue time. Legacy items without captured configuration retry until configuration hydration finishes instead of being stranded.
- OpenCode v2 writes the provider and model on the assistant message, and a send switches the session record before the prompt goes out. The session record therefore names the next turn's model before any answer exists, and the composer's model only counts before the first answer.
- A provider's rate-limit reset comes from the 429 body, top level or under `error`, as an ISO date or epoch seconds or milliseconds. OpenCode caps a retry at 15 minutes, so a limit that lifts later otherwise shows a retry bound to fail again. Reset headers stay inside OpenCode and never reach the client.
- The tray merges status by session: a missing or idle entry from one store never overwrites a busy or retry entry from another. A session counts as active when either the synced child stores or the cross-project status map says so.

### Agent memory

- The client memory store feeds the Project notes panel, the Work status memory count and OpenChamber tools settings. What a session is told about memory is decided server-side by `packages/web/server/lib/session-knowledge`, so this store is not the session index.
- The session directory is resolved to its project before the store is keyed. A session in a worktree carries the worktree's path, and keying by it files memories under a project nothing reads.
- The directory is a parameter, not a read of `useEffectiveDirectory`: the hook runs above `SyncProvider`, and that hook throws outside the sync context, which blanked the whole app.
- The store reloads on `agent-memory-changed`, because the agent writes mid-turn through its own tool.

### Terminal keepalive

- Terminals are touched once per directory. A terminal inside an isolated space is touched in that space, so its own runtime sees the activity and does not idle-reap a session whose tab is still open.

### Catalog reads

- A failed catalog or model-list request keeps the previous answer. An empty successful answer and a failed request are different states and never look the same.
- Model lists are re-read when the provider catalog changes, on a provider login and on a runtime switch. A panel restored at launch otherwise keeps the empty answer OpenCode gave while it was still starting.
- Directory-scoped lists name the current directory. Without one, the answer describes OpenCode's own working location, which need not hold the project's models.

### Live readouts

- One shared clock drives every live readout and waiting indicator. Spinners step on a 250 ms beat; everything else changes on every fourth beat. A page with only a counter or a blink draws one frame a second, and a page with no indicator draws none.

### Chat timeline scroll

- `useChatTimelineScroll` decides which of two modes is active, `following-end` or `free-scrolling`, and issues one deterministic scroll command for the list. The list's own `maintainScrollAtEnd` stays off so only one writer moves the viewport.
- Opting out of automatic movement follows real gestures (wheel, touchmove, pointerdown, key, frame scroll, row expand), not inferred intent from scroll positions. Each gesture bumps a generation counter; in-flight automatic movement compares its captured generation and aborts when they differ. There are no guard, settle or entry-stick timers.
- A remembered reading position is captured before the list is hidden, because ref cleanup can run after the hide when nothing measurable is left. An unknown at-end measurement never clears the record, and a hidden container never overwrites it.
- A message link is an explicit request: it loads history until the message is found or the history ends. A remembered position is a convenience and gives up after a few batches.

### List scroll memory

- `useListScrollMemory` covers a list that leaves the screen together with its scroller: a file preview, a diff tab. It records the offset per key from the scroller's own scroll events and restores it in a layout effect, so a short replacement cannot clamp the browser's restore to its own height. Lists opt in through `ScrollableOverlay`'s `memoryKey` and `memoryReady` props or `ChangesPanel`'s for its own scroller; only a raw scroller outside those primitives (`ReceivedPagesTab`) binds the hook itself.
- Content that is not the key's own (a list still loading, a loading placeholder, a failed read or search, rows a previous query left on screen) neither restores nor records (`ready`), or an offset the browser clamped to the placeholder would be saved as the list's. A binding restores once: a later `ready` flip must not move a list already on screen, which would yank it under the user. A null key is a view without a list and starts at its top; an undefined key keeps no memory and attaches no scroll listener. Each folder, search, mode and repository is its own key. A key carries what makes a list its own (runtime, directory, session, query, filter) and nothing it shares with another list; a list that refreshes keeps its rows on screen rather than a placeholder.
- A list that aligns a row of its own, the directory picker's highlighted row, does that only when the selection moves. Alignment on every content change lands after the restore and takes the position back.
- The offset map is module-level, so an offset outlives the panel that held the list. `memory` exists for a caller that needs its own map, such as a test, and must be stable: a map created per render rebinds the scroller's listener on every render.
- A virtualizer computes its first offset while rendering, before the scroller mounts, and writes it on attach; it takes the saved offset as `initialOffset` (`savedListScrollOffset`).
- The other shape, one scroller that stays mounted while a preview swaps its content, is `usePreviewReturnScroll` in `components/references`; it restores on the same node only.

### Read-aloud, TTS and dictation

- Mobile Safari only unlocks audio inside a user gesture. Playback uses one shared `AudioContext`, resumes it when suspended, and plays a silent buffer to unlock; preparation must happen before the first asynchronous step.
- Local TTS synthesizes sentence chunks in a pipeline: the first chunk plays while the next synthesizes. Only the first chunk gets a clause split; splitting every sentence would chop prosody once playback hides synthesis time.
- Dictation streams microphone chunks while recording and keeps the server's partial transcript plus the audio segments so a failed dictation can be salvaged or retried instead of recording again.
- Cancelling dictation dismisses the overlay immediately. Tearing down the audio graph can take about a second on mobile WebViews and must not delay the visible response.

### Polling and control-stream synchronization

- The live event stream is authoritative for the session list. The timed snapshot only finds deletions the stream could not report, and runs while the app is visible.
- On desktop a hidden window still reports the document as visible because background throttling is off, so the poll follows the shell's own visibility events. A queried starting state can leave a window that starts hidden stopped for good.
- After a stream gap the head of the list is read, because sessions created during the gap arrive in no event. Deletions wait for the next full sweep.
- Hooks that mirror server-owned catalogs (guests, marks, source control, trackers, quota providers) re-read after a control-stream reconnect. A change made during the gap was announced to nobody.
- The server owns the browser provider choice. When the chosen extension is paused, removed or loses approval, the server writes `builtin` back and announces a reset; the hook mirrors that into the store and tells the user.
- Notifications read the app's control stream; a separate `EventSource` would consume another HTTP/1.1 connection slot in every browser tab.
- A hook that only reads a store leaves catalog loading and runtime switching to the surface that owns it.
- A search drops an answer to anything but the current request. `useConversationSearch` never shows content from an earlier key, while `useMessageSearch` keeps the previous hits visible while the next query loads so the list does not flash empty.

### Read-aloud automation

- Every finished answer present when a session opens belongs to the baseline. Opening a conversation never starts playback, and trimming back to an older answer does not read it for the first time.
- A reply claimed in one window is not read by another.

### Routing

- A route write is suppressed while a route is being applied, and only the latest applied request may normalize the current history entry.
- The session named in the URL is retained until directory and message bootstrap catch up. A route that startup would drop is not acknowledged.
- An empty route supersedes pending startup and closes Settings.

### Directories and projects

- Directory priority is session, worktree attachment or metadata, draft override, chat root, then the global directory. The hook and the imperative resolver share this one ordering.
- A managed chat never falls back to the active project, because that project's files, commands and skills would leak into the chat, and project actions would run inside the chat folder.
- A concrete directory that resolves to no project owns nothing. Falling back to the active project there shows one project's knowledge under another project's name; the fallback exists only for states with no directory at all.
- Settings has its own project selector and never activates a project, so reading another project's MCP servers does not relocate the rest of the app.

### Worktrees and git surfaces

- A secondary worktree is probed at its toplevel, not the active subdirectory, so worktree operations receive a valid root.
- A cached "not a repository" answer goes stale when a terminal or agent runs `git init`, and a cached "no commits yet" goes stale at the first commit. Opening the surface probes again; it does not poll.
- Repository discovery runs per opening because a submodule added outside the app leaves no event behind.
- A selected repository that no longer resolves is dropped and discovery runs again. Repositories that already failed a probe are not auto-picked again, which would loop probe and discovery.
- An established root keeps its own data and offers its submodules in the picker. Only a root with no repository auto-selects a nested one. That guess is not persisted and yields once the root has its own commit.
- A worktree whose creation has not finished looks dirty: its setup commands and initial git reset are still running. Surfaces that report uncommitted changes consult the pending state and show nothing instead of reporting bootstrap noise.

### Keyboard, focus and window behavior

- Shortcut handling is scoped by surface: VS Code, the phone shell and the desktop app each receive only the chords their UI can act on.
- A completion key typed into an editable target is a deliberate sequence only when the prefix was armed from that same target. Otherwise it is typing and must not be swallowed.
- Double Escape from a chat's composer stops that chat's run; the first press arms the prompt and the second within three seconds stops it. An Escape already prevented was spent by the composer itself.
- The Shift flag follows `shiftKey` on every keyboard and pointer event rather than pairing Shift keydown with keyup, because a keyup can be swallowed. Window blur resets it.
- The document root never scrolls. Chromium still scrolls hidden-overflow ancestors programmatically, most visibly to reveal a textarea caret, so root scroll is snapped back to zero.

### Desktop and mobile platform

- The tray and dock badge admit only sessions with a sidebar row. Sessions from unconfigured directories cannot be opened or cleared from there, and pending approvals follow the same rule.
- Tray status comes from the status map, not the session list: a session can have a live status before it appears in a list, and several stores can list it. A session is active when either the synced child stores or the cross-project map says so.
- Push visibility on the native app follows `App.appStateChange`. Web visibility signals are unreliable in a WKWebView, where `hasFocus()` can report false while the app is active, which leaked push notifications.
- iOS grants `navigator.wakeLock` only inside a tap, so the native app uses its own idle-timer plugin. Android drops the wake lock when the app leaves the screen, so it is requested again on visibility.
- In-flight archive retries stay quiet and never open a trust prompt from a background pass.

## Decisions

### Why the chat timeline uses gesture generations and not timer windows

Timer windows had to infer whether a scroll write came from the hook or the user. A generation counter records the user's gesture directly, so in-flight automatic movement can abort on its next frame. This removed the guard, settle and entry-stick timers.

### Why a form whose tool call ended no longer holds the turn

The permission and form indicators take priority so the user can answer a blocking prompt. Using the mere presence of a form as a hold kept the status idle after the tool call had ended, which took Stop and Queue away from a running turn (#5391).

### Why the queue falls back to the trailing assistant message

A missed busy event leaves no status entry while a turn still streams. The trailing in-flight assistant message is live evidence of that turn, so the queue treats it as busy and drains when the message completes or an idle status lands.

### Why Settings reads a project without activating it

Selecting a project in Settings used to call `setActiveProject`, which moves chat, sessions, files and git. Reading another project's MCP servers silently relocated the user, so Settings keeps its own selected project and leaves activation to the rest of the app.

### Why a chat draft never inherits the app's project directory

The chat root is managed by the server and is not the project the user was last in. Inheriting the active project exposed its files, commands and skills inside a managed chat. Until the server names the root, the draft has no directory.

### Why the native app uses `appStateChange` for push visibility

`document.visibilityState` and `hasFocus()` are unreliable in a WKWebView. The app reported itself hidden while foregrounded, and the server's focus gate stopped suppressing push. The shell event is authoritative.

### Why local TTS splits only the first chunk at a clause boundary

A long opening sentence delays the first audio. Splitting it at a comma or semicolon helps only there; clause splits inside every sentence chop prosody, and later chunks are hidden by playback of the previous one.

### Why the timeline loads a message link until the message or the history start

A link is an explicit request, so a typo or a reverted message has to be ruled out rather than silently leaving the reader at the end. A remembered reading position is a convenience and stops after a few history batches.

### Why `useOnDemandComponent` exists instead of `React.lazy` and `Suspense`

React keeps content that replaces a fallback hidden for at least 300 ms. Loading the module before rendering shows no fallback, so the first open of an on-demand surface is not held back.

### Why the provider logo glob is failable

Vite rewrites `import.meta.glob` at build time; a runtime without that transform, such as the Bun test runner, throws on the call. Keeping the call failable lets the hook fall back to the remote logo URL.

### Why old worktree archive failures retry quietly

One toast per failing worktree is enough. A background pass also never opens the trust prompt, which belongs to a foreground action.

### Why the tray counts only sessions with a sidebar row

A session without a row cannot be opened or removed from the tray, and its dock count could never be cleared. It would also take one of the tray's limited slots.

### Why the tray reads the cross-project status map and not `/session/status`

The per-directory endpoint creates an OpenCode instance for every directory it is asked about. The host's seeded map covers the same startup gap without those instances, and live events keep it current.

### Why agent memory is keyed by project and not by session directory

A worktree session directory is not where memories are stored. The sync resolves the session to its project first, using the same authority as the Project notes panel; keying by the worktree path files memories under a project nothing reads.

### Why a failed model-list request keeps the previous answer

An empty list reads as "nothing available" and leaves a restored walkthrough picker broken. A transport failure is not an answer, so the known list stands until a read succeeds.

### Why one clock drives every live readout

Each indicator with its own timer drew on its own schedule, and a page with many indicators produced a frame for each. One clock puts them in the same frames: a spinner beat every 250 ms, and one second for counters and blinks.
