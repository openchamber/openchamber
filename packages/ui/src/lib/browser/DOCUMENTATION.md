# Browser surface client

## Ownership

This folder is the UI half of the in-app browser and of agent browser control. The server half, the transport from the agent's tool call to a client, lives in `packages/web/server/lib/browser-control`. The desktop driver that clicks, types and runs scripts in a page lives in `packages/electron/browser-panel-driver.mjs`; this folder decides what an action means and composes the driver steps.

- `contract.ts` owns the vocabulary shared by every runtime: navigation status, annotation payloads and their guards. It validates payloads that come from a page we do not control.
- `controlClient.ts` owns the client side of agent control: which mounted or sleeping tab serves a request, the claim that grants one client the right to act, and the panel's opener and closer registrations.
- `pageDriver.ts` composes agent actions from driver steps. `pageActions.ts` holds the self-contained scripts those steps evaluate inside a page.
- `annotationOverlay.ts`, `annotationSession.ts`, `annotationPrompt.ts`, `annotationScreenshot.ts`, `overlayTheme.ts` and `previewFrameHost.ts` own annotation: the overlay injected into a page, one session from overlay to screenshot, the prompt the agent reads, the image drawn on the capture, theme resolution for the overlay, and the parent half of the preview-frame bridge. `annotationScreenshotStore.ts` keeps each annotation's screenshot where every window of the app and a reload can read it; `hooks/useAnnotationScreenshots.ts` puts it into the composer that shows the draft.
- `devServers.ts`, `announcedServers.ts`, `hiddenDevServers.ts`, `devServerWait.ts`, `devTunnel.ts` and `mobileDevTunnel.ts` own dev-server discovery, the wait for a server that is starting, and tunnelling a remote loopback server into a local origin.
- `crashRecovery.ts`, `liveTabs.ts`, `history.ts`, `url.ts`, `viewport.ts`, `uploads.ts` and `hostCapability.ts` own one policy each.

## Invariants

- The browser surface has one vocabulary. Code in this folder does not branch on whether the view is a Chromium `<webview>` or an iframe.
- Every field an annotation consumer dereferences is checked by `isBrowserAnnotationPayload` at the boundary. The overlay script, the prompt formatter and the screenshot renderer never assume a field is present because another one looked right.
- The annotation overlay runs in a page we do not control. It imports nothing, reads no OpenChamber CSS variable, keeps every piece of chrome in one closed shadow root, and receives every color and label already resolved and translated.
- Annotation marks the page as it is; a session never modifies the document.
- The overlay tears itself down and waits for a repaint before resolving, so the capture taken afterwards contains the page and none of the overlay.
- A page action script is a self-contained expression. An input reaches it only through `JSON.stringify`, and every script resolves to `{ ok, ... }` and never throws.
- A snapshot's numbers belong to one document and one snapshot. A later snapshot of the same frame invalidates the earlier numbers, and a frame that navigates takes its numbers with it.
- A JavaScript dialog holds the page until answered. An action that opens one returns it, and later actions refuse until `browser.dialog` answers it.
- Every answer from the desktop driver and from a page script is parsed at the boundary before a caller reads it.
- Dictation in an annotation goes through the app's binding in the overlay's isolated world. The page can neither start a recording nor answer in the app's place, and the overlay has no microphone without that world.
- Only a client holding the server's grant touches a page. A refusal and a failed claim are normal outcomes for the client that lost the race.
- An action without `tabId` runs in the calling session's tab, or in the user's shown tab when it is in the session's project. Another session's tab is never chosen for it, and acting in a background tab does not switch the user to it.
- `browser.close` removes only a tab the calling session opened. A null session owns no tab and is refused.
- Session-to-tab memory is module state only. After a reload a session falls back to its newest registered tab.
- A dev-server wait retries only a loopback address with a connection-stage error. A tab restored from saved state never retries, and a tab nobody watches holds its retry without loading a page in the background.
- Dev-server wait keys carry the directory, because tab ids repeat across projects as `browser:<url>`.
- A link opened in a new panel tab (user, background or agent tab) sends the opening page's referrer, under that page's referrer policy, on the tab's first load. The referrer is kept in memory for the tab the link created and dropped when the tab mounts. A link to an address that already has a tab reveals that tab; when that tab is still blank or failed and loads the address again, that load sends the link's referrer under the link's policy, and a tab that shows a page is not reloaded. The referrer is not kept for that tab, a restored tab never gets one, and opening the address any other way drops one a never-mounted tab left behind. An open-tab event without a referrer, from an older desktop shell, opens the tab without one.
- A tab opened from a link has one history entry once its first load commits or fails, so Back never returns to the blank page it attached at. That first commit or failure also restarts the dev-server wait, as a load someone asked for does, so settling on the blank page first does not end the wait for a local dev server's gateway.
- Announcements carry the base path of an app; discovery carries the ports that actually listen. When discovery is available it decides which servers exist, and an announcement supplies the path for its port. When discovery returns nothing, announcements stand alone.
- A tunnel failure is reported. The original loopback URL is never loaded as a fallback.
- A crash recovery policy allows a bounded number of reloads within a window. Once the attempts are spent, the panel reports the crash.
- Viewport scaling changes only how the page is drawn. The page lays out at the chosen size.
- Agent tabs sit outside the user's live-tab count and sleep after their idle period. The user's tabs keep their page while among the most recently used up to the configured limit.

## Decisions

### Why a navigation status carries its URL

`loading` and `failed` name the URL they describe, so a late event from a superseded navigation is discarded by comparing addresses. A bag of booleans cannot tell the current failure from the previous one.

### Why annotation payloads are validated field by field at this boundary

The payload is produced by a script inside a page we do not control. A partially valid payload would otherwise throw much later, in prompt formatting or screenshot cropping, far from its origin. Rejecting it at the boundary keeps the failure local and explainable.

### Why the overlay lives in a closed shadow root

Page CSS cannot restyle a closed shadow root and page scripts cannot walk into it. The overlay also must not disturb the document it lands in, so all of its chrome sits on one host element and goes away with it.

### Why the overlay's chrome is two pieces and not one bar

The tools stay at the top of the page and the comment box follows what was just marked. One bar pinned to an edge covers the part of the page people most often want to point at.

### Why the annotation body is English and only the intro is translated

The body is prompt content the agent reads, so it stays English whatever the UI locale. The intro is echoed back to the user in the composer, and that line follows the locale.

### Why the screenshot shows the whole visible page with marks on top

A crop around each target answers what the element looks like and loses where it is and what sits next to it, which is the more useful half of pointing at something. The marks are drawn on the full capture instead.

### Why an annotation's screenshot is stored in IndexedDB under its draft and not only attached

The inline-comment draft is shared by every window, but an attached file lives in one window's memory, so an annotation filed from another window (a context panel in its own window) or before a reload reached the composer with its prompt saying a screenshot is attached and no image. The bytes go to IndexedDB, keyed by the draft's id, before the draft is added, so a window that sees the draft can already read them; localStorage was rejected because a screenshot is large and every write there reaches every window as a `storage` event. Each composer brings a missing screenshot back from the store and keeps one attached locally stored, which also covers a failed send that restores its drafts. A record goes when its draft leaves the store or loses its screenshot, in whichever window that happens, and a window that held the file drops it too; records without a draft older than a minute are pruned at startup, since the draft is added only after the record is written.

### Why the screenshot scales by the measured capture ratio

The capture arrives in device pixels and the payload rectangles are in CSS pixels. Deriving the ratio from the two measured sizes stays correct when the page is zoomed, where `devicePixelRatio` does not.

### Why a translucent fill is resolved by the caller and never derived from the accent color

Theme colors are not necessarily hex, and appending an alpha suffix produces an invalid canvas color. Canvas then keeps its default opaque black and paints over the element the screenshot is meant to show.

### Why the overlay's colors come from a probe element

The page has its own `:root`, so the overlay cannot read OpenChamber's CSS variables. Theme tokens can also be authored in any color space, which makes string manipulation unsafe. A probe element carries the token, and `getComputedStyle` returns a concrete color the overlay uses verbatim.

### Why page action scripts are self-contained strings

They are evaluated in a frame of the page, where nothing from this module exists at runtime. `JSON.stringify` keeps a selector or a typed value from ending the expression and becoming code.

### Why the element registry lives on `window`

On desktop the scripts run in an isolated world of each frame, where `window` is the scripts' own and the page can neither see nor change the registry. On the page's own world the same registry makes a snapshot result usable by the next action.

### Why a snapshot numbers only visible interactive elements

The caps bound the cost by the size of the answer. A page with ten thousand nodes returns the same shape as one with two hundred, and whatever the caps drop is reported so a partial answer never reads as complete.

### Why a snapshot can be scoped to a subtree

A long page truncates against the caps no matter how they are tuned. Asking about the part that matters sidesteps the caps and answers the agent directly.

### Why file inputs are listed even when hidden

Pages commonly hide the input behind a styled button, and an upload needs the real input element.

### Why a click refuses when something covers the point

A real click would land on the cover, such as a cookie banner or an open menu. Reporting success would hide that the page is in the way.

### Why a scroll reports only after the position moved

Pages often set `scroll-behavior: smooth`, so a position read straight after a programmatic scroll is the position before it. Reporting the scroll limits too makes a scroll already at the end distinguishable from one that failed.

### Why a quiet-page wait ignores attribute changes

Hover classes and live styles change on a finished page all the time and would hold every wait to its limit. DOM and text changes end the wait, and a running animation that will finish counts as a change because a splash fades out by style alone.

### Why every driver and page-script answer is parsed at the boundary

The answers cross from a page we do not control and from a separate Electron process. Parsing them where they arrive turns a malformed answer into a named failure instead of an opaque error inside a later action.

### Why dictation needs the isolated world

The microphone is the app's. The overlay asks for it through `ANNOTATION_BINDING`, a function the desktop shell exposes only to the isolated world the overlay runs in. Inside the page's own world that function does not exist, so the overlay opens without a microphone rather than exposing the app's recorder to the page.

### Why a prompt parser still reads a `Comment:` block

Prompts written before the comment moved out to the draft's own text still carry that block. Reading it keeps those prompts editable, and a prompt this module wrote puts the comment in the draft instead.

### Why a dropped control result is reported

A dropped result looks the same as an unreachable browser to the agent. Reporting the failure is what turns a silent twenty-second timeout into an explainable error, which is how a missing body parser was found.

### Why waiting for a view polls and does not subscribe

Registration is a plain assignment made by whichever pane mounts. A callback would have to be maintained by every caller of `registerBrowserController` for one waiter.

### Why an HTML drag runs as the page's own events

A real drag starts the system drag session in the app's window. Links and images are draggable by default, so the page gets synthetic `dragstart`, `dragenter`, `dragover`, `drop` and `dragend` events sharing one `DataTransfer`.

### Why preview-frame messages name no origin

The preview page has an opaque origin, so there is no origin to name. The message carries only the annotation overlay code, which the page is allowed to see.

### Why hidden dev-server ports are stored per runtime

Each machine has its own listening ports and its own noise. The hidden list follows the runtime the panel is connected to.

### Why a dev server's HTTP status is checked

A gateway in front of a dev server answers before the app behind it is up and returns a 5xx page. The browser sees a successful load, so the navigation status cannot tell that the server is still starting.

### Why the preset list stays short

A long list is harder to pick from than it is useful. Anything missing can be typed as a custom size.

### Why a request is claimed before it is served

The server broadcasts a browser request to every connected client because it cannot know which one shows the panel. Deciding by whose result arrives first would be too late, since every client has already acted by then.

### Why `browser.open` is handled without an attached view

Opening a tab is what creates a view. The view that appears then takes over the rest of the same request, so a layout applied while opening does not cost the agent a second call.

### Why a client without the named tab waits before answering

The wait gives the client that holds the tab time to claim it. Without it, a client with the panel mounted would answer "no such tab" while another client could still have served the action.

### Why a tab opened with an address is remembered only until it mounts

A tab opened with an address makes its first load on purpose. The key is dropped once the tab has mounted, so a later remount of the same tab counts as a restore and does not retry.

### Why a tab opened from a link loads after `dom-ready`

Every other tab is created with its final URL in `src`: a hidden view loses an imperative navigation, and a changed `src` is not reliably honoured. `src` cannot carry a referrer policy, though, and a view without `src` never attaches. So `hooks/useBrowserTabReferrer.ts` attaches a tab opened from a link at `about:blank` and calls `loadURL` with `httpReferrer` once the guest fires `dom-ready`. Chromium still sends `Sec-Fetch-Site: none` for that load; the panel does not rewrite fetch-metadata headers.

The blank history entry is cleared on the first main-frame `did-navigate`, or on the first main-frame `did-fail-load` other than `ERR_ABORTED`, because an error page commits without `did-navigate`. `ERR_ABORTED` means another navigation took over, and that navigation's commit clears it instead. A link that turns into a download starts a navigation and stops loading without a commit; the tab then stays at the blank page and behaves like an empty tab, with no history clearing or dev-server rearm waiting for a later address. A guest that crashes before the first page also stops loading without a commit, and only `render-process-gone` after it tells the two apart. Crash recovery reloads the blank page; that blank commit does not count, and its `dom-ready` asks for the address again with the referrer. Electron reports a crash's `did-stop-loading` before `render-process-gone`, so the hook asks `isCrashed()` when loading stops: a load that stopped in a living guest was handed off (a download), and a later crash of the idle blank page does not ask for the address again, so the download is fetched once. The listeners capture, so the history is one entry long by the time the navigation hook reads it for the same event.

### Why the tab a link opened is found by comparing tab ids

The panel store's open actions return nothing for user tabs, and the tab a link opens is the one that did not exist before the call. Comparing the directory's tab ids around the call finds it without a new store contract, and finds nothing when the link only revealed an existing tab. For the same reason the link's referrer reaches an existing tab's load request through `openWithBrowserTabLinkReferrer`, which holds it for the duration of the synchronous open call, instead of a referrer option on every open action.

### Why a stopped mobile tunnel listener needs no explicit stop

iOS reclaims the listening sockets of a suspended app, so the listener can be gone without a stop event. A generation counter makes an open that started before a close-all give up, and the last bytes queued for the native socket are written before the connection closes.

### Why an old Android WebView changes the preview frame

Android's Capacitor opens native plugins to every frame on an old WebView, which breaks the preview. The check keeps the frame closed to plugins there.

### Why a restored tab is listed as sleeping and woken on demand

A tab from a previous run has no view until something needs it. Listing it keeps it nameable, and waking it after the claim lets an action land in the tab it names without loading every tab at startup.

### Why an open without `tabId` creates a new background tab

Replacing the page the user is on would lose their place. The answer carries the new tab's id, so the agent keeps working there.

### Why close is panel state and not a page action

No page view can remove its own tab. The panel registers a closer, and the ownership check happens before the closer sees the tab.

### Why open reports whether the client can also drive the page

The same per-client fact is declared to the server on the event stream. Reporting it with every successful open means the agent learns a page is display-only before its next action fails.

### Why a restored load is never retried

Nobody asked for that load; it happens at app launch or when a project's panel is shown again, and its server is usually just not running. Retrying would hammer a closed port for the whole wait, often in a panel nobody is looking at.

### Why the retry pause grows with the time the wait has run

The first retries stay quick, so a server that is only restarting is back on screen at once. Every retry is a load and a log line, and a fixed 600 ms pause produced about 65 of each per tab while a server was down. Growing with elapsed time also means deciding again about the same failure gives the same answer.

### Why a tab that is not watched holds its retry

Loading a page in a hidden tab costs a process and a request for nobody. The retry waits and runs as soon as the tab is watched again, even if the wait ran out meanwhile.

### Why retries continue briefly after a project action stops

A start script can bring its servers up in the background and exit before they listen. Without the short continuation, the retry pending at exit would be the one never made.

### Why discovery decides existence while an announcement supplies the base path

An announcement knows the base path an app is served under, which a listening socket cannot reveal. A listening port is ground truth, while a terminal can wrap a line and turn half a URL into a plausible address on a port where nothing runs.

### Why announced servers are kept in memory only

They describe one run of one command. A stored copy is the kind of stale address that sends the panel to the wrong page.

### Why the server list is ordered around the panel's folder

Discovery lists everything listening on the machine, and most of it belongs to the OS or other apps. The folder a process runs in separates the user's dev servers from that noise, and the panel's own folder comes first. A server whose folder is unknown stays in, and so does one that announced itself.

### Why a port that serves no web page is listed only on request

Windows discovery (`netstat`) reports no folder, so the folder test above cannot separate anything there, and the list used to be every listening port. The server asks each port for its root page (`packages/web/server/lib/dev-servers`): one that answered with something else is set aside behind "show hidden ports", next to the ones started outside every project. A port that has not answered yet, or a server too old to ask, stays in the list, as does an announced server, so a slow first compile never hides the app being started. A page's title and favicon name the row, and the port stays beside them.

### Why a failed tunnel is reported and the original URL is not loaded

On a remote instance the original loopback address points at a different machine, so the user would see whatever runs on that port here, possibly another application, under the address they asked for. Discovery errors, a port the host does not offer and rejected authentication are authoritative refusals and must not look like a page.

### Why loopback navigations inside a tunnelled page are retargeted

A page served through a tunnel can send the view to another local port, such as a docs server behind a dev gateway. That navigation happens inside the view, where nothing resolved it. Without retargeting, the address is looked for on the user's machine, where it is either absent or a different application. A URL already pointing at a tunnel port is left alone.

### Why a loaded URL is mapped back to the requested address

The tunnel's random local port would otherwise appear in the address bar and be persisted as the tab's target, where it means nothing after a restart.

### Why cached tunnels are dropped on a runtime switch

The shell's listeners belong to the previous endpoint. Their ports stay valid as keys but no longer reach the host the user has left.

### Why `isRemoteWebLoopbackUrl` treats every isolated space as remote

A space's loopback is inside its container, on a local instance as on a remote one. Only the desktop or native-mobile tunnel reaches it. A hosted browser tab's `localhost` is its own machine.

### Why only the Electron renderer can drive a page

Only Electron hosts the Chromium view that exposes frames, scripts and real input. Web, hosted mobile and Capacitor render a display-only iframe.

### Why crash recovery is a pure function of state and time

Nothing else in the view's lifecycle reports a lost renderer: no load fails and no navigation happens, so the panel would stay blank with no way back. The policy is pure so it can be reasoned about and tested without crashing a real renderer.

### Why a crash long after the previous one starts a new window

Counting it against a stale window would refuse to recover from the first crash of an otherwise healthy session. Attempts also back off exponentially so a page that crashes on load does not reload in a tight loop.

### Why an agent tab sleeps after its idle period

Agent tabs run unthrottled, so one left behind by a finished session keeps a busy Chromium process. Asleep, it loads its last address on the next action; page state that lived only in memory is gone by then.

### Why schemeless input defaults to `https:` except on loopback

Dev servers overwhelmingly speak plain HTTP. Defaulting `localhost:5173` to HTTPS turns the most common address in the panel into a connection error.

### Why typed text that is no address becomes a Google search

The address bar is the panel's only input, so text such as `react hooks` is a search. Text counts as an address when its host could be a site: a dotted name, an IP, a loopback name or any name with an explicit port. A bare word is a search, and so is any text with a space. An explicit scheme other than http(s), with or without `//`, still gives a blank page. In the iframe runtime the frame loads the search with `igu=1`, the flag Google needs before it allows framing; the address bar shows the plain search address.

### Why retry uses a wider localhost test than the tunnel

Browsers resolve every name under `.localhost` to this machine, and local proxies give projects their own names there. The tunnel stays on an exact hostname list because it also rewrites the address it hands to the shell.

### Why a restored visit with no title keeps the old title

A page often reports its address before its name. Revisiting moves an address up the list, because a second copy would turn a list of places into a list of events.

### Why history is per project

The addresses that matter belong to the work in progress, and each project has its own list. Ranking and matching are pure functions so the behaviour can be exercised without a store or a keyboard.

### Why a rotated preset becomes a custom viewport

An iPhone on its side is no longer the entry in the preset list. Keeping the preset id would make the picker claim a size that is not on screen.

### Why viewport fitting never enlarges

Enlarging a small viewport to fill a large panel would misrepresent the very thing the user asked to see. The scale is applied with a transform, so the page never learns it is being scaled.

### Why uploads travel as data through the shell

The page may run on a different machine than the server. The server checks the paths the agent named and holds the files under a one-time token; the client fetches them and the desktop shell writes them where the page's file input can read them.

### Why a preview URL's grant is stripped from the prompt

The grant is a credential for the page's folder. The path is what the agent can act on, and it is what the prompt carries.
