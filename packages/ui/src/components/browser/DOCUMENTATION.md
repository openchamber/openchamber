# Browser panel

## Ownership

This module owns the rendered browser panel, its navigation lifecycle, agent-action integration, focus protection, viewport layout, server picker and annotation-to-composer handoff. Browser policies, transport and annotation protocols belong to [the browser client library](../../lib/browser/DOCUMENTATION.md). The Electron shell owns guest sessions, proxy setup and page input.

## Invariants

- `directory` identifies the panel and composer destination; `siteDirectory` identifies the browsed folder, history and servers. They can differ while a draft shows an isolated space.
- A space's view attaches only after the shell configures its in-memory session proxy, including for saved public addresses. Its partition name matches the shell's contract, and external-browser opening stays unavailable because that browser lacks the space's proxy restrictions.
- Agent tabs use their own persistent profile unless the user enables shared logins. Links opened from an agent tab retain its owner, so they retain its profile and stay outside the user's tab strip.
- A webview's initial URL is captured once so prop updates cannot reset page-owned history.
- Effects that attach webview listeners depend on the mounted element in state. A stable ref alone cannot signal that the element appears after the effect first runs.
- Navigation status reflects main-frame results. A terminal failure survives a later stop-loading event, and `about:blank` cannot turn an empty or unattached view into a ready page. Crash-recovery state survives element reattachment so repeated crashes cannot reset its budget.
- Desktop history records successful loads and page titles. The display-only iframe records requested addresses because it cannot inspect the page's navigation or title.
- Agent action callbacks read current viewport state through a ref. Snapshots identify their viewport and include a bounded, per-document warning/error record so page failures and layout differences are visible to the agent.
- Only the current annotation run changes panel state or attaches its result. Cancellation also reaches an overlay still starting, and leaving the tab clears overlays and live style overrides.
- Annotation dictation ends with its annotation. Transcript delivery precedes the idle-state message; a failed recording preserves partial text and leaves a waiting submit unsent for review. Model-download status appears in the overlay while recording continues.
- A frame annotation captures only the visible area clipped by the window and scrolling ancestors, after overlay teardown and repaint. Hosts without desktop capture attach the annotation without an image.
- Iframe tunnel resolutions are generation-scoped. A later navigation, return to discovery or teardown invalidates an older resolution so it cannot replace the selected page.

## Decisions

### Why the iframe exposes fewer controls than the webview

Cross-origin iframe pages are opaque to the app. Inspection, console and page annotation controls require the Chromium host and stay absent on the display-only fallback.

### Why the webview mounts with its resolved source

A background view can lose an imperative initial navigation or ignore a later source mutation. Tunnel resolution completes before the element mounts; a failed resolution supplies a blank source with an explicit error so the panel can finish mounting without loading the wrong machine's page. A tab opened from a page's link is the one exception: `src` cannot carry a referrer policy, so it mounts at `about:blank` and loads its address with the page's referrer once the guest is ready ([why](../../lib/browser/DOCUMENTATION.md#why-a-tab-opened-from-a-link-loads-after-dom-ready)).

### Why opening waits for both loading and rendering

Lazy chunks can replace a splash after loading completes, so agent answers wait for page quiet as well as document readiness. The waits are bounded inside the server action budget, with an app-side timer for pages whose own timers stop; a continuously loading stream can return `settled: false` without making the open fail.

### Why hidden actions reveal the stage through styles

Hidden, clipped and off-window webviews can lack a composited surface and fail capture with `UnknownVizError`. A fixed, transparent stage inside the window provides a drawable surface without moving the node, which would reload its webview; input additionally enables pointer events underneath app content so cross-origin presses reach the page without exposing it to the user's pointer.

### Why frame waits distinguish a stopped compositor from a busy thread

Capture and real input require 2 drawn frames. A timely interval with no frames reports that drawing is unavailable; partial frame progress or a late timer restarts the wait because either can occur while the app is still drawing.

### Why agent input preserves user focus

Focus emulation keeps page pickers and clipboard operations working while the user types in the app. If emulation is unavailable, real focus is held only during input and released before navigation waits; focus the user already placed in the page, or deliberately moves during the action, remains theirs.

`browser.type` and `browser.press` are the exception: they always hold real focus on the page, in a hidden tab too, because Chromium sends keyboard input to the focused widget even under emulation, so emulated focus let typed text land in the chat composer. The hold starts once the input stage is drawn and ends when the action finishes or its deadline passes, then focus returns to where the user had it when the hold started; keys the user types meanwhile go to the page. A window has one keyboard focus, so keyboard actions in different tabs of one window take turns: the next one takes focus only after the previous one released it, and an action whose deadline passed while it waited never takes it. The rejected alternative is keeping emulation for keyboard actions, which reports success while the text goes elsewhere. This stays until the browser moves to its own `WebContentsView`.

### Why keyboard input carries one deadline

The keyboard action's drawn stage owns the deadline (`usePageDrawn`) and passes it explicitly to the page driver, so the driver's own dialog check cannot open a fresh one; the driver refuses to focus a target once it passed, and every step of a keyboard action (the `Delete`, the inserted text, the optional `Enter`) carries that same time, and the shell refuses any key event past it, a key release included. A timed-out action keeps running in the background, and a later action may have focused the page again, so a per-step deadline or a focus check alone would let its late input type into the next action or the user's draft.

### Why the focus guard extends beyond the action

A navigation started by an action can autofocus after the action returns. The guard remembers the initial deep active element, checks window blur on the next task because guest focus can skip app `focusin`, and protects app focus through the settling interval.

### Why agent dialogs are enabled before document readiness

A dialog opened during loading blocks `dom-ready`, so waiting for readiness before answering it deadlocks. Dialog handling begins with an attached view, runs actions serially because answers belong to the whole tab, and rejects blocked non-snapshot actions before focus emulation; default rejection avoids holding the user's window open as a sheet.

### Why viewport changes wait before answering

The device bar opens when the agent changes layout so the new size is visible to the user. Resizes and input-triggered navigations get time to land before the response, keeping the next snapshot tied to the resulting page.

### Why fill-mode page width is pinned during layout motion

Every webview resize waits for the guest process to paint and can stall the app's animation. Width is pinned before the first animation frame, takes the known final size when growing, and grows in spare-width steps only when necessary; the observer rechecks a target published a render late, while the bottom zone's height never becomes a width target.

### Why dragging catches up at short rests

A drag has no known final width, but holding an old width until release looks broken and resizing on every pointer frame stalls movement. The page catches up after a short rest and publishes stage size when layout settles; explicit device viewports keep their chosen layout size and only change visual scale.

### Why gateway waiting has a separate short budget

A listening gateway can return a 5xx while its app starts. Waiting applies only before the first good load and stays short so genuine build failures become visible; the probe uses HTTP status rather than site-specific error-page text.

### Why error pages wait only while a project action runs

A local proxy such as portless listens before the app behind it and answers 404 until the app registers, so the page loads and never fails. The webview's own document status, from `did-navigate`, covers `*.localhost` names the host probe refuses. A 404 is also a real app's answer, so it is retried only while the action that opened the page runs and for at most 2 minutes; without the cap, an app whose start page is a 404 would reload for as long as its action lives.

### Why gateway probes use the original host address

Probing runs on the server, where a client's ephemeral tunnel port has no meaning. Isolated-space addresses are also outside the host's probe boundary, so their loaded pages count as served without a host probe.

### Why retry visibility preserves the waiting state

Agent-owned or agent-driven tabs count as watched even in the background, and a running project action can still be bringing its server up. A paused retry and a navigation in progress keep the waiting screen to prevent flashes of the error page; restored-load classification persists across visibility changes until its actual settled load is accounted for.

### Why redirect recovery has a per-address budget

Links can be retunnelled before navigating, but redirects are already loading when reported and recover through their failure. Each address recovers once so a genuinely missing port fails; an explicit user request resets that budget while an automatic retry preserves it.

### Why the server picker polls only while shown

Servers start seconds apart, so one discovery snapshot is insufficient. Each poll inspects listening ports, making hidden-panel polling wasteful; a stopped space yields an empty list without requesting it and resumes discovery when the space runs again. Discovery failure remains distinct from an authoritative empty list.

### Why announced servers bypass hidden-port filtering

An announcement represents a server the user just started and makes that port relevant. Servers outside known projects remain behind the hidden-list affordance, and opening a candidate clears its announcements so old offers do not remain behind the loaded page.

### Why only the server list scrolls

A centered column that overflows can clip its own top beyond scroll reach. Keeping the surrounding panel fixed and letting only the shrinking server list scroll preserves access to every row; unavailable rows use `aria-disabled` so their explanatory marks retain pointer tooltips.

### Why address suggestions select on pointer down

Address-field blur closes the list before a click can select a row. Pointer-down selection preserves the choice; the toolbar owns keyboard selection, resets it when the address or focus changes, and cycles through an unselected state so the typed address stays reachable.

### Why annotation images attach before prompt text

An upload can fail, so the prompt describes only an image that actually landed. The screenshot belongs to the annotation row, and the user's comment stays in the draft's editable text; the completed draft is accepted as written because the overlay is already gone and refusal would lose the marks and comment.

### Why frame annotations probe and tear down without waiting for a reply

A navigated frame or a page whose CSP blocks the bridge can never answer, so startup has a bounded probe. Cancellation posts teardown before disposing the listener because a departed page cannot acknowledge it; Escape also works from the app because focus can leave the page.

### Why microphone levels bypass the transcript queue

Transcript and state messages require ordering, but microphone levels become stale while queued. A level send already in flight is allowed to finish while new samples accumulate into the next peak, bounding traffic without delaying the transcript.

### Why overlay dictation has a narrower shortcut contract

The overlay matches physical letter and digit keys in a single chord, so other shortcuts remain unavailable there. VS Code has no OpenChamber dictation server behind its bridge and exposes no annotation microphone.

### Why mobile Back uses a frame-history guard

The opaque iframe's internal history belongs to the WebView and takes priority over leaving the preview. Walking off the guard triggers the preview's own history step; the handler avoids reading the reported state because WebKit can report the departed guard's state after crossing a full load. Reload resolves a phone-local tunnel listener again because background suspension can reclaim the previous listener.
