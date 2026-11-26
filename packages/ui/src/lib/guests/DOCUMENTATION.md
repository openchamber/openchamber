# Extensions (guests)

## Ownership

This module is the client half of installed extensions: the catalog and its parsers, the one activity gate every surface shares, rail surfaces and the phone's equivalents, actions, commands, items and links, sidebar marks, tool presentations, extension frames (direct, relay, shared-surface socket), install/update/uninstall, device storage, the microphone, and the workspace/shell projections a service reads. The server owns installation, approval records, frame grants, the guest service proxy and the wire schemas in `packages/sdk`; this module only decides what the app shows and what it hands a frame.

## Invariants

- A guest takes part only when it is not paused and every capability its package asks for is approved (`isGuestActive`). Rail icons, attach rows, integration cards, actions, commands, tools, file editors, links, marks, mentions and the pane itself all use that one definition, and the server applies the same test before acting, so what the UI lists is what answers.
- A catalog row this build cannot read is listed in `unreadable` and every other row still loads; only a response without a guest list is a failure. An unknown value inside a known field drops that field only, never the row: a newer server must not hide extensions a build already knows.
- A catalog retry keeps the previous failure available until a new response or a runtime switch. `loading` still signals a pending read when there is no loaded catalog.
- Two extensions claiming the same thing resolve by catalog order: the first wins, including a file editor whose patterns match and a provider logo for one provider id. A link tries exact origins before wildcard ones (`claimGuestUrl`), as a tool presentation tries exact names before wildcards. A guest command name never shadows a local command, an OpenCode command, a skill or an earlier guest's command, and each dropped name warns once.
- Rail surfaces are the active guests with a page or a host-drawn shared surface, in catalog order; the rail and the digit shortcuts must agree on that list. Background-only and tools-only extensions get no surface.
- The phone shows a guest's panel, its live-screen dock and the attach window or dialog only with `panel.mobile`, and the full-screen page only with its own opt-in; host-drawn data, Work Status sections, UI blocks and file editors need no opt-in. A guest that did not opt in opens neither panel nor dialog there, and the drawer follows the chat's folder, so no directory is asked for.
- Only the rail pane (`PluginPane` with `surface="panel"`) reads the item hand-off slot. A block, file editor, page, status section or popover of the same guest can be on screen at once and never takes it; dialog panes receive the item as a prop.
- `host.openSurface` only ever opens. A surface already on screen stays open, and an empty result means the surface is not shown afterwards.
- Every click on a background action owns one temporary frame and one completion. The click is revalidated against the manifest it captured before any UI opens or guest code runs: same runtime, same version, revision, entry and action declaration, still active, still entitled, and phone-approved when it opens a panel. Repeated clicks on the same target collapse into one, keyed without the payload because a session's messages can run to megabytes.
- A failed conversation load reports the failure and opens nothing; a guest never receives an empty conversation that is really a fetch failure. A failed mention search lists no guest rows and leaves the file suggestions in place, and a picked row whose context the extension cannot give produces no chip, because a message with the row's name and none of its content is not what the user chose.
- Only the agent's own replies read as `assistant`; a synthetic message is attached context and stays on the user side. OpenCode's plumbing roles (`system`, `skill`, `shell`, `compaction`, the `*-switched` notices) carry no parts and never become items. Omitted `records` means the action did not ask for the conversation, while an empty list is a real empty conversation; when the JSON would exceed the session cap the oldest messages are dropped and `truncated` is set.
- A mark on a row comes from one list per extension: the session's, the branch's, then the folder's, and the first list that has one wins, in catalog order. A branch target in a folder of no known project shows nowhere. A failed marks read is not "no marks": what was shown stays until a read answers.
- Marks are read one at a time per server, never overlapping, with one follow-up read after a change announced during the read, so a burst of changes shares one read and the last answer is the newest. Retries run at 1 s, 5 s and 20 s after a failure, because the signal that a mark is gone comes once; only a read the timer started advances that count.
- Marks and marks lists that did not change keep their identity, as do the compiled tool rules, link rules, provider-logo map and catalog array. A row whose content is the same does not re-render, and a catalog reload that found nothing new changes nothing.
- Tool rules match on the name OpenCode reports, un-normalized. An exact rule beats a wildcard from any extension; among equals the first extension in the catalog, and its first rule, wins.
- Tool templates are plain text substitution, never evaluation: a missing path renders as an empty string, a root that is not `input`, `output` or `metadata` stays as written, and only own properties are read. A header title falls back to the rule's `name`, then to `null` so the host's own display name shows.
- A card shows only non-blank strings, numbers and booleans; nothing, a blank string, an object and an array are all missing.
- A card link is only an address the host may open: it parses, it is `https`, it carries no user name or password, and it is within the link length cap. The checked string is the one handed to the browser: the function returns the parser's own `href`.
- No representation of a frame contains the runtime's bearer credential. An extension icon is fetched with the runtime's current credentials, not through an expiring token embedded in a CSS URL.
- Secrets stay on the server. The status answer names only the ids of secret fields that have a value, and install diagnostics carry fixed routes and status codes, never credentials or response bodies.
- Active session frames receive only derived context fill and cumulative token counters, never conversation text, through `ready.session` and `onSession`; context becomes unknown after compaction and counters remain cumulative. A frame's context `limit` is the window of the model that answered the measured step, read from the catalog of the frame's session directory (not the active project's), and the frame compares it as a number, so a catalog change that leaves it equal sends nothing; a later a later model switch never re-scales an earlier reading, and a model missing from the catalog gives `limit: null`. Usage stays out of `ready`: a usage-only change reaches the frame as one `session` message, never as a replay of ready, directory, connection, settings or item. The session workspace projection uses the same token-total calculation as the Context view over the record with its pending spend patch applied (`withDeferredGlobalUpdate`), so totals move during a turn while the global sidebar list waits for idle; it keeps its existing bounded live-work context reading. Both contracts use nullable values before usage is known and optional fields for older hosts.
- An extension with `sessions` sees every link of a session, the agent's and the user's, but never another extension's opaque `data`. Its tool target is relative to the session's folder, so it learns nothing about folders beyond that.
- A live tool is shown only while the session runs; a lost end event must not leave a tool on screen past the turn. `inWork` mirrors the sidebar's In work rule, and v2's typed forms still read as the public activity `waiting-question`. So does a turn held by an agent's `awaitAnswer` page or secret card, read from the global blocking-request index the sidebar uses; an `answerLater` page holds no turn and stays out.
- Global session records own complete membership, archives included; child stores only fill discovery gaps. A session of a project opened on a subfolder of its repository runs in that subfolder of its worktree, so a worktree holds its subfolders.
- Shells are read from the local store, never the network. A project scope covers the project root and its worktrees, the same membership the workspace projection reports. OpenCode keeps an ended command's output until it evicts the command (the latest 25 per directory); a stopped command keeps none.
- Device-local extension preferences are removed only after a confirmed uninstall, never because a listing omitted the extension. A failed cleanup cannot undo the server's removal, and the retired installation identity makes any retained bytes inaccessible.
- Badge counts live in memory only, are cleared when the guest's panel opens, and reset on a runtime switch, because two servers can host extensions with the same ids.
- A late `generate` outcome is delivered once, to a frame with the same owner (runtime, installation, surface and project). The store is per window, and only a loaded catalog of the same runtime may revoke a kept outcome; while the catalog loads or after a runtime switch nothing is dropped for that reason.
- A status section's rows and controls keep their identity while their content is unchanged, so a sample that moves one number redraws one row and leaves the header alone. Polling never asks twice at once, reads nothing while the document is hidden, drops results that arrive after `stop`, and `refresh` resolves only after a read that started after the call has been delivered.
- A status frame publishes its controls at most 20 times a second, and one extension may show at most five toasts in ten seconds; the rest of a burst is dropped so an extension in a loop cannot bury the app. A toast's buttons own their own data, so they stay usable after the guest frame exits.
- A service connection reads as not connected until its status has answered.
- A guest with `folders` takes part in the rail, pages, phone tabs, Work Status sections, actions, commands and attach rows only while the open directory, its project or its space's project lies inside one of them (`guestsInScope`). Without folders it is everywhere. With no directory open, the active project is the scope. `useGuestScopeSync`, mounted once by `GuestHosts`, publishes the scope; the hooks read it from `useGuestScopeStore`, so a session switch subscribes nothing per row and a switch that keeps the same extensions returns the same array. A surface that acts on something other than the open session passes its own scope instead: a sidebar row's session actions and marks use the row's directory and project, the New worktree dialog its project, `@` mention rows the composer's directory and its project or draft target (`useGuestScopeOf`, `keepGuestItemsInScope`), applied to the rows held while a search is pending as well, so a folder change drops a row from click and keyboard selection at once. File editors follow the open scope, except that an editor that held unsaved changes keeps its file until another file opens (`findScopedGuestFileEditor`): a save clears the dirty flag before the frame reports edits made during the write, so dropping the editor at that moment would lose them. New opens use the host's view. Folder containment uses `isFilePathWithinDirectory`, so Windows drive and UNC paths compare without case. When folders change, a tab is closed only in a directory whose project is known and outside them; one whose worktree owner is not resolved yet stays, hidden by the pane until the scope resolves.
- An extension tab in the context panel, restored or open, is hidden and its frame unmounted while the catalog is still loading or the extension's folders leave the scope out (`isGuestTabHidden`, `useGuestTabsInScope`). The tab stays stored and returns when the scope covers it, such as a worktree whose project resolves later.
- Its service, tools, logos, quota, links and blocks in existing messages, and Settings ignore folders. Mention search still asks the server for every extension; the composer drops the rows of those outside the scope.
- The Add dialog sends its folders with the install request, an empty list included (`useInstallFolders`). A folder typed but not added counts; a relative one stops the install with the invalid-folder toast (`withPendingFolder`), so a half-filled field never installs an extension everywhere. When the source is already installed and the field is empty, the field takes the stored folders once per dialog. A reinstall from the dialog sends what the field shows, so an emptied field clears the limit in the same server write as the replace. Installs started outside the dialog send no folders, and the server keeps the stored ones.

## Decisions

### Why folders hide surfaces and leave the service running

Folders answer "where do I want to see this extension", not "what may it do": approval and pause stay the permission and the off switch. A service is one process for the whole server, and stopping it whenever the user opens a project outside the folders would lose its state and restart it on every switch. The project path counts as well as the directory because a worktree's checkout usually lives outside the project's folder. The scope is published in a layout effect so the rail never paints one frame with the previous project's extensions. When a loaded catalog changes an extension's folders, every window closes that extension's tabs in directories outside them, judged the same way (a worktree through its project); tabs inside stay open. The first catalog a window reads closes nothing: worktrees may not be resolved yet, and a tab of a worktree inside the folders would close.

### Why the catalog is parsed row by row and field by field

A build meets newer servers and broken packages. One unreadable row or one unknown field must cost only itself, so every optional contribution carries `.catch(undefined)` and an unreadable row falls back per field to what Settings needs to offer removal. A whole-catalog failure is reserved for a response that is not a catalog at all.

### Why the client stores categories and not HTML

Frames are shown through a grant URL or a relay document, so a panel, a page, a status section and a block all arrive as package paths the host resolves with current credentials. That is what lets the relay runtime work at all: a browser-owned iframe request cannot travel through the JS tunnel client, so relay frames are read over authenticated runtime HTTP and drawn from `srcDoc`, which is also why their CSP travels as the document's first `<meta>` element and only approved origins stay reachable. The direct path keeps the grant inside the URL path so the page's own relative scripts, styles and fetches carry it and no sign-in proxy session is needed; a server that predates grants gets the short-lived guest-scoped query token instead.

### Why relay documents are cached by characters as well as by count

A panel loads once, but a chat with several blocks of one extension would read the whole package through the tunnel for each, again on every scroll back, and a document can be tens of megabytes. The size bound is the one that matters on a phone, so a document over the cap is simply not kept. Frames that appear together join one read, and a frame going away cancels it only when it was the last one waiting.

### Why a relay read is retried once

A tunnel that reconnects mid-read loses its streams. Every request on this path is a GET and the next one waits for the channel, so one more read is safe and a slow read is not counted as the action's failure. The frame load timeout is 60 s for the same reason.

### Why the guard around unresolved relative URLs is a `<base>` element

A rewritten document keeps its own relative links. Without a base pointing at the package URL, a relative navigation lands on the host UI instead of the package, so the base element is written before any other content and the original `<base target>` is carried over.

### Why the host waits for an ack before the next frame

A shared surface sends one `frame` text message followed by one binary message with the image; the client pairs them, hands the bytes to the pane and acknowledges the sequence once the pane has drawn it. The ack is what lets the host send the next frame, so a pane that draws slowly sees fewer frames rather than a growing queue.

### Why a loaded frame document is kept

A frame that navigates inside its own document keeps the `srcDoc` it already has. The URL is resolved again only when the frame starts over, so an open panel does not reload its package for every navigation, and scoped auth is renewed on that new load rather than per navigation.

### Why the CSS rewriter consumes comments and strings

The reference pattern must not treat URL-like text inside a CSS comment or a standalone string as a resource to fetch. Matching those spans first, and passing them through untouched, keeps only real `url()` and `@import` references on the network path.

### Why link rules are plain data with no regular expressions

The chat's Markdown plugin takes the rules as an option, and streamdown keys its parser cache by the options' JSON. Anything that does not serialize, a `RegExp` in particular, would change the key on every render and re-parse every message. The array also keeps its identity while its content is unchanged, so the Markdown plugins keep theirs; a version mark that moves with content is what re-parses a message already on screen, because streamdown's root re-renders on content and `data-*` props rather than on a new plugin list.

### Why the UI runs compiled link patterns and never compiles them

The server compiles `contributes.links` into literal keys and anchored patterns, and the client only executes them. A pattern the client built from manifest text would be a second, drifting definition of what an extension may claim.

### Why a claimed URL keeps only its path and the template's own query parameter

An address from the conversation can carry tracking, fragments or unrelated parameters. The claim hands the extension the address its rule describes, on the exact origin (port included, no `www.` folding) or, for a wildcard origin, on any subdomain of its domain on the default port (`linkOriginMatches`), so what the extension receives is what its manifest declared rather than whatever the message happened to contain.

### Why a claimed identifier must be a whole word

`KEY-123` is only a claim when it stands alone. Inside a word, a path, a URL or a version (`a/DEMO-1`, `DEMO-1-old`, `DEMO-1.5`) it is ordinary text, and an `attach` claim without a link stays text because a chip without its link is not what the user would click.

### Why the tool rules are compiled once per catalog array

Every rendered tool part asks for a rule, and tools stream. Compiling on the catalog array's identity means one pass per catalog change, not per part. The hook subscribes to that array only, which changes on load, install, pause, approval and runtime switch but never while a tool streams.

### Why card link values are percent-encoded and a `..` step is refused

A manifest writes the address around placeholder values. Encoding each value keeps it inside the path step or query value it was written into, so it cannot add separators of its own; a step that resolves to `..` would walk out of the address the manifest meant, so it yields no link at all. In the host a value keeps its dots, which is why a placeholder may stand for a whole label only.

### Why a `{settings.<id>}` cap is repeated here

`GUEST_TOOL_LINK_SETTING_MAX` matches the server auth store's cap for one stored setting value. A larger client cap would accept values the server refuses.

### Why late answers are kept in the window and not on the server

The request itself never outlives the window that sent it, so keeping an answer there would mean a second lifetime to reconcile. Per window the store starts empty and delivers each answer once to the next frame of the same owner.

### Why the phone opens a workspace tab instead of a rail

The phone has no rail. A surface with a workspace tab opens it, an extension's tab only when it opted its panel in, and everything else answers as unsupported. The item hand-off and the dialog store therefore branch on the surface before they open anything, and a caller that must tell "not on the phone" from "no folder" checks `guestPanelOpensHere` first.

### Why `host.openUrl` treats loopback specially

A loopback address is a dev server or a container port the user just started, so it belongs beside the chat the way a project action's preview does. Any other link follows the user's setting for links in chat.

### Why `host.openCommit` reads the commit itself

The guest only names a hash. The host validates it, reads the commit from the open project, selects it exactly as the Diff view's commit picker would, and opens the view in commit scope, so nothing the frame sends reaches git unchecked. The phone's Changes tab reads the same selection in its commit scope, once it shows that repository.

### Why a command or resolve mounts a hidden frame

A guest answers a slash command only from a live frame. The composer uses the rail pane when it is up and otherwise mounts one hidden pane for the call, one at a time, unmounting it as soon as the command has an outcome. A guest that never connects is `unavailable`, never a silent null. Background actions apply the same budget to hidden documents, capped at eight, and add the 15 s a stopped service may need to start.

### Why the host captures the microphone

A guest frame has an opaque origin, so the browser refuses it `getUserMedia`. The host asks under its own origin and hands the frame mono samples at the rate the frame's audio graph runs at, with echo cancellation and noise suppression on because an extension usually wants a live microphone for a call. Captures are counted per guest, because a guest can listen from more than one frame and the rail marks which extension is listening rather than that the app is.

The `ScriptProcessor` only runs while it is connected to the destination, so a muted gain stays in the graph to keep the microphone out of the speakers. A context without the user's gesture stays suspended and its `resume()` may never settle, so the start races it against two seconds and then reports that the microphone must be opened from a click.

### Why host typography is read in a passive effect

The user's font settings reach the root element in layout effects (`ThemeProvider`, `useAppFontEffects`). A passive effect runs after all of them, so it reads the values the new settings already produced. The frame's `1rem` is the app's body text in pixels, not the root font size, because body text is authored in rem and the interface size scales the root under it.

### Why the device metrics come from probes

The mobile shell pads itself with `--oc-safe-area-*`, which carry the platform fixes (Android's injected insets, the status bar the WebView already sits below), so those variables win over raw `env()`. Keyboard coverage differs by runtime: the iOS shell overlays the keyboard and publishes `--oc-keyboard-inset`, a mobile browser shrinks the visual viewport over an unchanged layout, and Android resizes the window so nothing is covered. The form factor follows the shell, and the value is republished only when something in it changes, so a frame hears a new `ready` on rotation or a keyboard opening, never on an unrelated resize.

### Why an expired frame URL is not retried as it is

A socket refusal before open is most often an expired URL token. The client drops the token and mints a fresh one on the next attempt instead of retrying the same refusal. An `ended` is different: the host closed on purpose, so reconnecting would only get the same answer, and the pane offers a retry instead.

### Why a popover closes under a host dialog

A guest preview must never cover a host permission or modal dialog. Some modal boxes are not in the way: one hidden from everyone (the phone keeps its closed drawers mounted, off screen and `aria-hidden`), one the owner frame sits in (the phone's workspace drawer holds the Status tab), and the phone's sheet that holds the popover itself. The controller is one lease per document, so a stale owner can never release a replacement.

### Why an extension detail screen still names a global-config entry for a paused extension

The entry in the user's global OpenCode config stays whatever the extension's state, so the screen names it even when the extension is off, awaiting approval or refused by enterprise mode. What such an extension never gets is an offer to add the plugin; and a managed OpenCode that reads our config file (`file`) shows nothing, because the plugin is already loaded.

### Why install requests are dropped across servers

An install request is captured with the runtime instance that made it. A path means nothing on another server, so a request taken after a switch is dropped instead of installing something unexpected.

### Why an uploaded archive travels as a raw body

The `.zip` goes over `runtimeFetch` as an `application/octet-stream` body, which is what the files tree upload uses too, so relay and tunnel runtimes carry it unchanged. It answers with the same result shape as `installGuest`, so one flow handles both.

### Why device storage keys are a JSON tuple

The namespace key encodes the runtime, guest and installation identity without delimiter ambiguity: any separator would let one identity's parts spell another identity's key.

### Why the instance storage request drops `scope`

The server route predates device storage and reads the old body. Removing `scope` before sending keeps the wire shape those servers understand; the device scope never reaches the network.

### Why every extension frame gets a viewer id

A page of a shared-surface extension sends its viewer id with every `serviceRequest`, and the host tells the service which viewer the call came from and whether that viewer holds control. The host validates the id against its live viewers, so a stale one only means the call goes out without it.

### Why guest prompts to an open subagent classify their own record

The app-wide composer can still hold a parent's selection right after a child is opened. A guest prompt to a root session, or to a review session, answers with what the composer shows; every other session uses its own record and unsent picks. The record is looked up in the panel's directory store, then every store, then the global cache, so a child whose store has not loaded is still classified (`#6555`).

### Why a guest session passes a selection at creation

v2 creates the session on a selection, so the first prompt runs on the model the extension asked for without a switch message appearing in the transcript. A worktree checkout that failed to populate reports `bootstrap-failed` and keeps the worktree for the guest to decide on (`packages/sdk/API.md`).

### Why the host answers the first-party Linear read itself

`GET /api/linear/issues/get` with host-provided auth is issued by the host, not through the guest proxy. An extension attaching a Linear issue therefore never receives that integration's credentials, and the proxy stays off the path.

### Why the install link parser is pure

The Markdown sanitizer may run in a worker, so `install-link.ts` imports nothing and touches no DOM. `openchamber://extensions/install?url=…` installs from a repository and `?path=…` from a folder; a link can come from any page outside the app, so the desktop shell passes on only `url`, and only chat content inside the app may carry `path`.

### Why one extension can name a Remixicon but not a product mark

Guests name a Remixicon the app's sprite carries or ship a package SVG. The product marks in `scripts/generate-icon-sprite.mjs` are the host's own, so a guest cannot draw itself as one of them. A package SVG becomes an authenticated asset URL and is masked in `currentColor`; an SVG provider logo is requested in the theme's variant so it reads on either background.

### Why the provider-logo map is memoized on the catalog array

Every provider mark in the app asks for a logo, and each answer costs a pass over the catalog. Rebuilding only when the catalog array changes keeps that to one pass per catalog change; among extensions naming one provider id, the first in the catalog wins, as with tool presentations.
