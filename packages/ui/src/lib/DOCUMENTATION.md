# Hosted surface selection

## Ownership

`runtimeSurface.ts` owns the choice between the mobile and desktop app shells in a hosted browser. It stamps the answer on `window` at boot, and every `isMobileSurfaceRuntime()` caller reads that answer. Capacitor, Electron and VS Code have fixed surfaces and skip the heuristic. The live tablet layout inside the mobile shell belongs to `useTabletLayout` in `device.ts`.

## Invariants

- An explicit stamp or `?surface=` override wins over the heuristic, and an override stops the resize watcher.
- Rotating a phone never changes its surface, so it never reloads the document.
- Tablets and fine-pointer touch desktops follow the viewport width: a coarse-pointer tablet is mobile up to 768 CSS px wide, so rotating it can still reload into the other shell.

## Decisions

### Why a phone is recognized by the screen's short side and not by the viewport width

A rotated phone's viewport and `screen.width` both report the long side, so a width check flips during rotation and the resize watcher reloads into the desktop shell. The short side stays the same in both orientations.

### Why the short-side rule stops at 600 CSS px and not at 768

768 would move small tablets to the mobile shell in landscape, where they get the desktop shell today. 600 is the line `useTabletLayout` already uses for tablets, so one constant decides both.

### Why the short-side rule reads only `(pointer: coarse)` and not the wider touch check

`hover: none` and touch points also match touch laptops driven by a mouse. On those the short side would keep the mobile shell at full width, so they stay on the viewport width rule.

# OpenChamber control stream

## Ownership

`openchamberEvents.ts` owns the authenticated server control stream and its renderer subscriptions. `appearanceEvents.ts` parses theme and settings change hints at the stream boundary. Runtime HTTP owns credentials and routing; settings and theme consumers own reconciliation.

## Invariants

- Desktop and relay streams use `runtimeFetch`, preserving instance headers and aborting on unsubscribe or runtime change.
- Web and hosted mobile retain EventSource. Capacitor retains its header-aware fetch path. VS Code does not open the server-only stream.

## Decisions

### Why desktop uses HTTP authentication rather than the realtime URL proxy

HMR can serve the UI and API from different origins while its local proxy URL token is unavailable. A URL-only stream can then miss file changes even though settings reads work. The existing fetch stream uses the same authenticated transport as those reads without changing the server's auth gates.

# On-demand imports

## Ownership

`chunkLoadRecovery.ts` owns import retries and recovery navigation; callers own their fallback.

## Invariants

Imports retry once by default. Browser failures can reload; VS Code never navigates. `reloadOnFailure: false` preserves retries and errors while leaving navigation to the caller.

## Decisions

### Why detached work can opt out of recovery navigation

Image capture still needs the page after its source fallback succeeds, so detached loading preserves the page. Screen recovery stays unchanged.

# Native session notifications

## Ownership

`nativeNotifications.ts` removes the Android and iOS apps' delivered banners for sessions the user has seen, without waiting for the server's clearing push. The desktop shell clears its own through Electron IPC (`desktop.ts`); a browser has no delivered list. `notification-store.ts` checks `nativeSessionBannersAvailable` before it computes any session ids, so web, desktop, VS Code and hosted mobile do no native-only work.

## Invariants

- A banner is removed only when its push names a session, the server that sent it (`serverId`) equals the active connection's push identity (`apps/mobilePushIdentity.ts`), and it carries its push id (`nid`). Pull-request alerts, banners from another paired server sharing or cloning the session, and banners whose server cannot be told stay.
- Opening a session removes the banners of that session and of every known session it owns by the server's rules (`web/server/lib/session-lineage.ts`): OpenCode's `parentID`, and the `metadata.openchamber.parentID` of workflow agents and operator children, nested, through archived records too. Its dock shows the requests they wait on. A review session links to its original through other metadata and keeps its banners.
- "Mark all as read" clears the banners of every session this runtime's store knows, including one with no unread mark such as a permission request, and the mobile menu offers it while such a banner shows, asking again as sessions load (`hooks/useHasNativeSessionBanners.ts`).
- Removal names each banner by its slot (tag and id) and the push it showed. Android reuses the slot for a newer push about the same thing, so a push that replaced a listed banner before the removal stays, including one the system has not shown yet: posts and removals share a lock and the removal checks the push the slot last got (`PushBannersPlugin.java`, `SeenBanners.java`). iOS keeps the identifier (the collapse id) for a newer push, so its removal reads the list again and takes an identifier only while it still carries the listed `nid` (`ios/App/App/PushBanners.swift`); iOS offers no lock against delivery, so a push that lands between that read and the removal can go with it.
- Android keeps the push id in the extras as `openchamber.nid`; iOS keeps the push's own `nid` in `userInfo`.
- A list read that fails before push registration completes is harmless on Android; the next view clears what this one missed. iOS lists through the app plugin, which needs no registration.
- The session ids and the server identity belong to the same runtime: a clear or check whose runtime was switched away while the native bridge loaded does nothing.

## Decisions

### Why Android lists through the push plugin and an app plugin removes

The push plugin already returns each delivered banner with its notification extras, into which Android's `SealedPushMessagingService` copies `sessionId`, `serverId` and the push id. Its removal cancels by tag and id only, which would also take a replacement, so `PushBanners.remove` cancels a banner only while it still shows the listed push.

### Why iOS lists through the app plugin and not the push plugin

On iOS the push plugin rejects `getDeliveredNotifications` until APNs registration has been attempted in this launch, and the app registers only after the server reports a push target. A cold start while the server is unreachable, the case this clear exists for, would therefore never read the list. `PushBanners.list` reads `UNUserNotificationCenter` directly and returns each banner's identifier and `userInfo`, the shape the push plugin returns. `nativeNotifications.ios.plugin.test.ts` runs the clear through the real proxy with the push plugin refusing.

### Why the loader returns functions and not the plugin

A Capacitor plugin is a proxy that turns every property into a native call, `then` included. A promise resolved with it calls `PushNotifications.then()`, which never settles on a device, so the clear never reads the list. The loader resolves to plain functions that call the plugins, and `nativeNotifications.plugin.test.tsx` runs the session actions through the real proxy.

# Shared library contracts

## Ownership

The library owns shared session metadata readers, runtime transport and credentials, project API clients, file and selection helpers, and device-local coordination. Subfolder documents own their specialized contracts. The OpenChamber server owns stored project data and execution; the native shells own privileged device operations; sync owns authoritative session and transcript state.

## Invariants

### Session identity and side conversations

- A btw panel belongs to its parent's metadata link and survives reloads. Its inherited-history boundary is located in transcript order by identity because message IDs can roll over or come from different client clocks.
- A btw fork replaces the inherited OpenChamber namespace so source-owned review and side-conversation links cannot leak into it. Its marker lands before local insertion so it never flashes as an ordinary sidebar session.
- A side question forks the conversation without switching the main chat. Every send carries position-independent boundary instructions so the inherited task stays reference material without discarding earlier side-question turns.
- Promotion carries a revocation notice on every send because persisted boundary parts remain in history and are read again on each turn.
- A mid-turn fork inherits only settled records. The first question receives a fresh server-read text snapshot of the unfinished step so it has current context without unanswered tool calls.
- A forked session's canonical directory is the prompt's directory. Directory-child insertion normalizes Windows paths and remains necessary alongside the global metadata upsert.
- A btw fork without its first question is unusable and is unlinked before deletion. Destruction unlinks first so a failed deletion cannot keep the parent's panel open; rename failure alone does not invalidate the fork.
- Ordinary user forks drop source-owned links and scheduled-run markers, retain content metadata, and pause active goals so two sessions cannot pursue the same goal unattended. File-backed objectives are copied only while the fork still owns the same goal; repair failure leaves the already usable fork intact.
- Forks map inherited context pins to copied messages when complete reads identify an unambiguous match. A temporary page-read failure gets one retry on the same runtime. If the read still fails, the pins stay untouched.
- Work hints and assists describe only the latest idle turn and remain hidden during live work. Revert invalidates the assist, and a later idle timestamp retires stale hints even when a clearing event is missed.
- Stored turn duration applies only to the idle transition it names. Metadata and session-record caches rely on immutable replacement; cached parsed data is shared read-only.
- Display lineage follows same-folder work origins with cycle protection; plain forks and multi-run lanes remain roots. VS Code uses OpenCode parentage alone, and display lineage never changes server subsession semantics.
- Session titles belong to the user's explicit choice, independently of a worktree's task name. Generated titles use user-attached context and the final assistant response, skip plugin plumbing, and describe the work behind housekeeping requests; the initial-title server prompt shares that style.
- Session pins are scoped by runtime, directory and session. A moved pin keeps its original time; pinning closes work membership without creating work metadata on a session that never had it.
- Session and message links address the same accessible instance and grant no public access. Link parsing stays DOM-free for Markdown workers, and scanning addresses stays linear to avoid backtracking over long text.
- Linked items store display snapshots so issue bodies and state retain their provider's lifetime. Relinking refreshes the snapshot; source-control identity includes the instance, with github.com's legacy bare form preserved.
- Discussions use canonical external-link records and tracker links retain the legacy Linear stored kind so older clients preserve them when rewriting the list. Repository-thread identity deduplicates agent, extension and attached links; a provider URL that disagrees with an attached kind or number is not fetched as that thread.
- Goal objectives live in session-keyed files to keep metadata fanout small. Oversized audit objectives distill to completion criteria or a head-and-tail excerpt because the working agent already receives the full prompt. Goal edits preserve accounting; explicit resume grants a fresh continuation allowance, and pause or removal also stops the current turn.
- Review handoff waits for an idle parent and all live descendants, then reads a completed assistant record after the prompt. An intermediate completed step can contain text without being the final handoff.
- Review sessions inherit the source permission mode, including `ask`, and the project's standing knowledge. They leave response-style entries alone because feedback reaches the user's own session. Model-specific variants require the same model; a reused review session adopts the newly chosen selection before the server takes over.

### Runtime transport and credentials

- Active-server routes use `runtimeFetch`; explicit candidate probes, app-bundled assets, external origins and data/blob reads use `fetchBypassingRuntimeBridge`. Candidate probes keep their supplied URL and credentials even when another runtime or relay is active.
- An HTTP 401 requires a debounced `/auth/session` confirmation before session expiry is announced because provider credentials can fail through the same proxy. Login and pairing refusals are excluded. Live streams wait for restored authentication, and focus revalidation shares one throttle without periodic polling.
- Runtime URL resolution retains the configured subpath and drops saved address query and fragment data. Repeated `URLSearchParams` keys remain repeated; plain-object query values override by key.
- A space directory travels in query or directory headers, including when a caller otherwise names it only in the body. Caller headers remain intact, and the server rejects conflicting directory identities. Header normalization waits until non-Latin-1 values can be encoded; encoded directory hints carry an explicit marker.
- Custom credentials never follow redirects outside their configured address. Relay requests use the same routing and auth as direct requests, while external URLs use the network. Forwarding an existing `Request` preserves stream bodies without reconstructing a request that needs a duplex option.
- In-flight coalescing shares only overlapping allowlisted GETs and returns independent response clones. Its key includes directory headers; streams and requests with signals stay independent so cancellation cannot affect another reader. Entries disappear on settlement, and direct and relay transports share this policy.
- Fetches captured for a retired runtime use their captured transport and never resolve through the active runtime's replacement bridge. Read ownership survives a transport change within one instance, but not an instance switch away and back.
- Runtime keys use normalized bare-origin spelling and cache only against unchanged raw inputs. Disconnected keys own no persisted client state; VS Code's bridge-only `url:default` is its connected identity. Relay activation precedes token minting because the mint itself needs the tunnel.
- URL auth refresh has one scheduler while consumers exist. Concurrent mints share a request and replace the old token atomically; remaining lifetime avoids device/server clock skew. Guest package tokens are fresh per mount and scoped to one guest because frame scripts can read their URLs.
- Browser-owned assets cannot attach runtime headers or enter the relay. Runtime asset reads bound retained bytes even without a trustworthy content length. Raster images may use blob URLs; SVG uses an opaque-origin data URL because opening a blob SVG could execute with the app's origin beyond the route's CSP.
- Rollback remains assigned to its creating runtime. Disconnected owners retain failed cleanup for their next connection without polling.
- Pairing redeems one one-time secret over the first working transport. Relay trust pins a public P-256 key, retains no private JWK members, preserves endpoint paths, and never persists the one-time infrastructure grant.
- Desktop host probes check an unauthenticated server identity before sending credentials to a learned LAN address because DHCP can assign it to another machine. HTTPS addresses remain unchanged by LAN discovery; empty discovery cannot erase the stored address.
- Relay-capable desktop hosts boot the local UI and race a short direct head start against relay fallback. A late identity-checked direct success changes transport under the same runtime key; an explicit target wins over the default host.
- Relay probes span transient tunnel reconnects within one total deadline and stop on terminal refusal. Successful callers may take ownership of the live tunnel; other results close it. Displayed latency measures a request on the established tunnel, excluding handshake cost.
- Host status outlives the switcher and publishes immutable snapshots. Per-host generations and explicit switch results supersede older probes, each answer publishes independently, and only an authoritative configured-host list removes statuses. Snapshots carry which hosts have a probe in flight; a background recheck marks its hosts pending without counting as probing and without marking the cached result stale for a switch, so a periodic recheck neither locks the Refresh control nor turns an instant switch into a check dialog.
- Local desktop identity comes from the shell's reported server, never the page origin. Relays match by stable runtime key because their virtual API bases share the window origin; unconfigured addresses display only with credential redaction.
- Desktop capabilities depend on trusted local page identity even while a remote API is selected. Mini Chat and notification links preserve the owning instance; queued shell actions are consumed once, and one failure does not block later actions. Pairing changes the default only when none exists.
- Desktop startup waits for a valid native boot outcome, while a usable app shell need not wait for OpenCode initialization. Recovery before the local HTTP origin exists requires native restart. Update install failures propagate their actionable cause, and native update completion verifies its target version after reauthentication.
- Which URL schemes count as links to another app is one rule, `appLinkSchemes.ts`, read by the chat and by the VS Code extension host. Inside VS Code it also excludes `command:`, `vscode:`, `vscode-insiders:`, `vscode-*` and the editor's own URI scheme from the bootstrap config, because the host refuses them; the chat must never offer a link the host refuses.
- Theme and splash colors sent to the desktop shell are device state and never enter shared settings. VS Code bootstrap detection reads the host's early HTML injection before store initialization or runtime API registration.

### Persistence and project APIs

- Server settings adoption waits for Zustand hydration and isolates side-effect failures so one read-only bridge global cannot block store updates. Omitted keys stay unchanged and bootstrap never writes local values back as server defaults.
- Device fields migrate from the server once per runtime and then belong only to local storage. Mid-session save echoes cannot replace this window's workspace or theme choices; VS Code theme adoption has its own gate.
- Auto-save treats adopted server values as its baseline. Last-known server values suppress echo writes, pending intent overlays late reads, and a toggle back cancels its pending write while remaining newer intent for reads already running.
- Settings writes coalesce and flush once at page or native app suspension. Lifecycle flush uses authenticated keepalive fetch because ordinary unload fetches are cancelled and beacons cannot carry the bearer header. Failed writes forget optimistic last-known keys so retry remains possible.
- Settings surface selection travels as a query value to avoid a CORS preflight that older servers and packaged cross-origin shells reject. Browser mirrors exclude secrets and computed flags.
- Persisted directories are startup hints. Home resolves authoritatively on each startup; stale navigation probes cannot overwrite newer choices, and auth or transport failure does not prove that a saved directory is gone.
- Project draft keys distinguish drafts in one folder, with a single-consumer takeover of the legacy folder draft. Btw preparation keys stay in memory because the next side question reuses them, and share-link keys never enter draft storage.
- Attachment chips own send membership so deleting and undoing text removes and restores the corresponding file. Extracted document images follow their cited source; restored legacy drafts gain missing chips. Names are unique and bracket-safe, while persisted attachment names identify unavailable files after reload without persisting bytes.
- Project setup merges shared and personal entries with provenance. Settings edits only the selected source; source marks never travel back in writes. Path-derived storage IDs must agree with the server because settings project IDs are not stable file identities.
- Shared-command trust is bound to the exact command hash so changed repository setup asks again. A teardown prompt keeps its place to avoid leaving a stack running; concurrent removals share its answer. Cancelled creation creates nothing, while irreversible work may skip shared commands. Unreadable teardown blocks removal, and unattended removal cannot approve untrusted commands.
- OpenCode folder trust groups requests under every path spelling. A declined folder stays paused until trusted, deliberate work may ask again, failed saves leave the prompt visible, and configuration changed during confirmation is shown again before admission.
- Authoritative project-context, memory and search reads throw on failure so callers cannot erase valid data with false empty success. Memory distinguishes an explicit disabled response from a missing entry and reads both scopes together; project-setup callers retain their explicit best-effort empty fallback while setup editors use the throwing read.
- Project notes and todos send their storage revision back so a store switch rejects stale whole-list writes. Single-item mutations preserve concurrent agent additions and unrelated fields. Plans travel with their owning project and are addressed by ID, preventing guessed ownership or client-chosen storage paths; a deleted plan is not recreated by an editor save.
- Magic prompts read one current override snapshot per operation so visible prompts and instructions agree. Read failures never substitute built-ins, empty overrides win by presence, maps preserve arbitrary IDs, and split legacy commit prompts fill only missing split keys. Mutations check their captured runtime immediately before dispatch.
- Session knowledge is server-owned and written before sending, including through the space's own server. Knowledge failure cannot cost the user their message. Summary reads share a short cache, and pin changes invalidate even summaries requested before the write.
- Small-model failures preserve verbatim note text where callers permit fallback. The source conversation's provider wins over the composer pick, short selections avoid unnecessary summarization, and trust failures report folder instructions instead of blaming model configuration.
- Model selection uses catalog IDs because derived models can share a provider API name. Effort has 3 states: a named level, explicit Default, and no choice; explicit Default stops fallback, and even a repeated picker choice supersedes an in-flight send. Missing favorites remain stored because catalogs vary by directory.
- Configured default effort belongs only to its configured model. Model references share the server's provider/model/variant spelling; variant readers preserve variant IDs instead of array indices.
- Voice keys migrate to the server only after a confirmed write and then disappear from browser storage. Environment and notification credentials remain server-side; UI reads expose names or set-state only. Secret answers route to the session's server, and remembered-field reads expose names only.
- Memory badges compare entry timestamps against per-scope device marks. Viewing one project's memory cannot acknowledge another's, and newly learned and rewritten entries retain distinct badges.

### Files, Git and interaction

- A registered runtime's omitted Git operation is unsupported; HTTP fallback would call a server it does not run. Successful mutations announce status invalidation once at the owning dispatch or HTTP boundary after payload acceptance, and stale-runtime completions never invalidate the current instance.
- Git batches keep field, runtime and space routing context separate. Cheap checks cannot wait behind expensive status reads, worktree routes retain their space boundary, overflow is chunked, and a switch between admission and flush rejects the batch. Forced reads advance the cache version so older responses cannot refill it.
- Generated Git text samples repository history for its style and prefers the provider's own description template before GitHub-style locations. Free-model setups retain session-based generation when no authenticated small-model provider exists. Per-file diff concurrency accounts for the staged and unstaged request pair.
- Managed network operations recover a lost execute response only by reading the original operation ID because remote acceptance may already have happened. Preconditions run before planning so an unused plan cannot block the repository. Review pushes retain their dedicated refspec and never fall back to an ordinary branch push.
- Worktree session creation locks its draft target before awaiting creation, restores it on cancel, and never selects a preview path that could initialize OpenCode before the checkout exists. A project in a repository subfolder keeps that subfolder inside the new checkout.
- Branch auto-rename preserves an issue's identifying prefix and only relinquishes generated suffixes. Nested-repository selection leaves hidden tooling repositories to the picker, chooses deepest containment for files, and avoids scanning the home directory's unrelated checkouts.
- File autosave refuses incomplete loads, binaries and empty drafts over non-empty files to prevent unattended data loss. Explicit save retains the empty-write action; clean saves remain successful no-ops.
- File moves block saves at the old path while in flight and rebase live drafts on commit before tab stores change, preserving unsaved edits without recreating the old file.
- File-open limits apply before whole-file reads to avoid freezing the app. Office and data viewers have distinct budgets, with the smaller mobile budget retained. Binary extensions and decoded-content checks prevent treating unknown binary data as editable UTF-8; SVG remains text.
- Context-file reads permit referenced paths outside the workspace, keep binaries for their dedicated viewer, and avoid conditional empty-body responses. Git path matching preserves checkout subfolder prefixes; the longest exact suffix wins, with the shortest fallback for symlinked paths. Windows drive roots keep their slash because dropping it changes absolute paths into drive-relative ones.
- OpenCode file watches are shared across clients and expire in memory, so views renew and reconnect without unwatching another window's file. Tree refresh derives from existing tool and step signals, including failed tools that may have written; external changes remain outside that signal. Bursts coalesce and runtime changes drop pending hints.
- Background network lanes share one fixed aggregate budget with reserved session-list capacity so slow Git and discovery reads cannot fill the browser pool and block interactive session opening. Retired work resolves as unavailable, never authoritative empty success.
- Project action selections persist per runtime and project because the panel remounts. A deduplicated terminal response belongs to its creating peer, and directory listings use the same normalized keys as every terminal surface.
- Terminal sockets stay open briefly through tab switches to avoid repeated auth, upgrades and replay. Frame decompression preserves arrival order, adjacent output joins before encoding to retain split surrogates, and accepted resizes update retained snapshot geometry. A failed gzip snapshot retries through a fresh attach without compression; pre-open auth failure discards the stale URL token.
- A browser host terminal with no bearer, extra runtime headers, or relay first checks the resolver's same-origin `/auth/session`; a confirmed tunnel scope opens its same-origin cookie-backed socket without minting a URL token. Other runtimes and space terminals keep URL-token authentication.
- Preview extraction preserves announced paths and offers every announced server because output chunk order cannot decide which app the user meant. Inferred commands require announcements; loose fallback candidates stay local. Portless names replace their underlying loopback port only where those names resolve on the correct machine; server probes remain loopback-only.
- Project-action URL variables distinguish linked worktrees from the primary checkout. An unreadable linked branch fails instead of opening the main app, empty variables remove their separators, and truncated labels use a hash where secure-context crypto exists.
- Code row heights stay on whole pixels across editor and diff views because fractional rows drift under virtualization. Mobile retains its pinned code sizing. Theme-derived agent colors allocate from the complete roster; sparse palettes reuse syntax roles, and legacy migrated `#aaaaaa` means no configured agent color.
- Quote anchors count one joined DOM text stream across mounted message slices and re-find text with surrounding context. Offsets only break ties; ambiguous legacy quotes remain unhighlighted, and partial streams require whatever context they contain. Rendered page bootstraps share anchor context limits and include renderer headers in that stream.
- Code-comment anchors normalize indentation and use neighboring lines to disambiguate repeated code. A patch missing the target lines cannot prove deletion; surviving neighbors determine a stable replacement position.
- Selection overlays use text-node rectangles merged per visual line because block rectangles overlap into dark bands. Native selection clicks and post-long-press clicks cannot activate the underlying row; one press slot survives row re-renders, and nested controls retain their own gestures.
- Editor Escape belongs to the live editor and its overlays, including Vim's mode transitions. The live Vim panel identifies the actual editor configuration. IME composition keeps its native key ownership, and type-to-comment admits a single typed code point without stealing whitespace, shortcuts or editing keys.
- Message entry animation consumes freshness once per detector lifetime so session switches and remounts cannot replay it. Explicit send tracking separates new user intent from asynchronously loaded history.
- Session tab navigation uses only rendered tabs, and closing a tab never deletes its session. The last tab keeps its workspace's draft, moved sessions carry their tab, and initial workspace seeding waits for a complete session list. Completed or removed work navigates away from a directory that may no longer exist.
- Sidebar section claims apply top-down. Project groups own whole projects, an empty filter shows nothing, and unknown chips drop independently. Category chips match any within a category and all populated categories across categories; built-ins absent from saved orders return at their default positions.
- Navigation history stays in memory because it describes this window's route through sessions. VS Code surface attention follows the host because document focus cannot say whether the webview is visible. Server-provided canonical path aliases retain root identity; home and chats roots are never guessed from client paths.
- Native clipboard and sharing use the shell's platform capabilities because WebViews differ from browsers. Clipboard reads stay inside the user's gesture; base64 conversion is chunked to avoid argument limits, and plain-text message copying omits Markdown flavor.
- The file-icon sprite loads on demand and uses in-document symbol IDs for VS Code's origin constraints. Hidden symbol markup avoids expensive iOS focus traversal, while gradients and clips remain in a small rendered SVG so references still paint. Failed loads remain retryable.
- Android IME image declarations apply only to the composer, and changing them refreshes the input connection because the IME may inspect it before activation. Native shortcut requests travel through the app-local plugin, which arbitrary deep links cannot use to send agent prompts; a taken request is delivered even after unsubscribe so StrictMode cannot lose it.
- Mobile surface identity stays stable while tablet size class remains live. Desktop shells use primary-pointer touch detection, and keyboard-driven viewport shrink cannot remount the focused tablet layout. Native hardware-keyboard answers win before first render; inference is transient, and refocusing an already visible soft keyboard cannot count as silence.
- Mobile keyboard insets are non-inherited and written only to their readers because root custom-property writes restyle the entire transcript. Newly mounted readers receive active values. Tablet chat insets use a store for the same reason, keeping portaled overlays centered on the chat without a root restyle.
- Keyboard-following elements share the measured critically damped spring. Compositor-eligible transforms use plain-linear keyframe segments because `linear()` easing stays on WebKit's main thread; older engines retain the cubic fallback for properties that require layout.
- Android Back closes the newest overlay before shell surfaces. Focus-owning Base UI popups receive Escape; unfocused sheets register explicitly. Focus changes settle a task later because transitions between fields pass through the body.
- Mobile workspace preferences keep unavailable extension IDs in their saved positions and add new built-ins in default order. A hidden tab opened by an action stays visible only while active; Pages is transient, preview requires the native tunnel, and an all-hidden saved set falls back to all tabs.
- Layout-animation observers wait until the final drawn frame before measuring widths; pinned transcript end remains frame-aligned. Drag holds extend that interval through release, repeated tasks deduplicate, and the root profiling attribute has no CSS selectors because a root selector would restyle the whole document. Slow-start easing keeps a zone's leading column from appearing as a separate first step.
- `noopener` can produce a null window handle after a successful open, so it cannot prove popup failure. Dangerous and internal URL schemes stay excluded from application links; confirmed custom schemes remain separate from native communication handlers.
- Invisible-text detection applies only to whole text parts so zero-width model output disappears without stripping joiners from emoji or Persian words. JSON tree closing-row keys remain separate from node identities, and only expanded containers with children have closing rows.
- Disabled model providers are read from configuration because they disappear from OpenCode's live catalog. Project legacy theme-key colors keep rendering until the user selects hex; uploaded logos use the server's MIME contract and remain unavailable in VS Code, which has no OpenChamber asset server.
- Plan saves serialize per logical document and revision so debounce and close-time flush preserve edit order without duplicate writes. Reopen waits for outstanding writes and resets the watermark; failure permits retry of the same revision without poisoning later writes or blocking another document.
- Native close-tab routing follows the last-used innermost context zone, with covering surfaces taking priority, because the native menu owns the shortcut. Focus capture includes embedded webviews that emit no pointer event or `focusin`; registration itself counts as use until another surface is selected.
- Exported transcripts include conversation roles and user-attached context while excluding server plumbing, so extensions receive the same content as Markdown export. A default effort sentinel is not a user-selected level and stays unnamed.
- OpenChamber control events identify changed entities and trigger authoritative re-reads instead of copying potentially stale payload data. Connection-ready state replays to late subscribers because the server sends it only once; SSE needs the control stream for app announcements, and native mobile uses authenticated fetch because EventSource cannot attach instance headers. VS Code never opens this server-owned stream.
- Browser capabilities are declared per connection from the actual host because a browser tab can display a page without Chromium control. Agent-opened files on mobile open only for the session on screen; other requests are announced without changing that session.
- Diagnostic exports retain only fixed classifications and numeric positions; sensitive startup text, raw arguments and full local status remain outside the export. An empty send-failure or turn-error list is meaningful evidence of no recorded failure. Directory routing diagnostics prefer ownership records over store containment because a repository store may also hold its worktrees' sessions.
- Scheduled-task candidate validation uses the scheduler's own membership rule and chunks beyond the route cap so the picker cannot disagree with execution. Optional malformed fields drop independently; the run's directory names its actual chat or project location.
- Snippet naming matches the server's case-insensitive ASCII contract and transliterates non-Latin suggestions to retain a readable name. Names and aliases share a collision domain, and restoring a draft starter derives scope from its owning settings or project list.
- System font lists retain ordered fallbacks and strip CSS-breaking characters, allowing mixed-script coverage and unavailable local faces without blank text. Variable font ranges preserve intermediate weights, while VS Code's own chrome justifies its tighter text density.
- The common send guard reports a folder-trust refusal separately from model failure and lets callers suppress only their intended fallback statuses or duplicate notifications. Restart refuses to manage an externally owned OpenCode process. On a shared-service connection it names the terminal command and sends no reload, because a restart would cut off other clients; the connection comes from `/health`, since the saved shared-service setting stays on while `OPENCODE_HOST` overrides it. A failed `/health` read sends no reload, since the connection may be shared, and an instance switch during the read drops the action. Open settings re-read the connection on every `server.connected` (`sync/server-connect.ts`): moving between managed and shared rebinds the server's event stream without a client stream gap, so `sync/stream-gap.ts` misses it. Updater classification preserves unknown installer text so actionable failures remain visible.

## Transport decisions

### Why candidate and asset reads bypass the runtime bridge

Pairing and connection checks address a server before selecting it. Routing them through the active runtime could redeem a secret on the wrong server or attach that runtime's credentials. Bundled assets belong to the local UI build, while external and data/blob URLs retain their own destination. `fetchBypassingRuntimeBridge` preserves these requests without active-runtime URL rewriting or auth injection.

### Why a pairing link is cleaned around its edges and inside `p` only, and not across the whole text

A link moved between machines picks up characters it never holds: line breaks from a wrapped mail or terminal line (a text field turns them into spaces), zero-width spaces and word joiners from chat apps, direction marks, a byte order mark. `parsePairingConnectionPayload` and `parsePairingConnectionPayloadString` drop whitespace, control and format characters around the text and from the decoded `p` value, which also covers the percent-encoded forms macOS hands over (`%0A`, `%E2%80%8B`). Removing them from the whole text was rejected: `& p=A&p=B` would become `&p=A&p=B`, and this parser would read A while the desktop shell, which confirms the server from the text as it came, showed B. The browser's `atob` refuses these characters where Node's `Buffer` skips them, so without the cleaning the shell's confirmation dialog accepts a link the window then rejects.
