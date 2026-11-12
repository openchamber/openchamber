# Server Browser (built-in)

Runs Chrome on the OpenChamber server so agents can browse with no client
open and a person can watch, take over, and hand back the same page. This
package is the service engine behind the `openchamber-builtin-server-browser`
built-in: `contributes.service` only, `provides: ["browser"]`,
`surface: true`. It ships no panel/page UI; the native Browser pane
(`packages/ui`) is the viewer.

Built and staged by `scripts/build-builtin-extensions.mjs` (see
`packages/extensions/registry.json`), the same path every built-in uses.
`service/main.js` is the Node-target ESM bundle Bun produces from
`src/main.js`; it is not committed, only built.

## Source

Adapted from the community extension
[`rubimpassos/openchamber-server-browser`](https://github.com/rubimpassos/openchamber-server-browser)
(branch `feat/phase1`, MIT), itself an extraction of OpenChamber's own
browser backend (upstream
[`JosueGalRe/openchamber-server-browser`](https://github.com/JosueGalRe/openchamber-server-browser),
OpenChamber PR #3425). See `NOTICE` and `LICENSE`.

The extension's panel/page UI (`panel.js`, `profiles-view.js`,
`inspector-page.js`, `panel/*`) was dropped: the native Browser pane and
Settings → Browser replace it. Everything under `src/` is the engine:
Chrome process and install management, the CDP client, the browser runtime
and its actions, the egress policy proxy, development-server discovery,
saved profiles, the inspector, and the shared-surface wire.

## What pages ask of the person

Headless Chrome has no window, so things a local browser would show the
person reach the Browser pane instead:

- **Dialogs** (`page-requests.js`). An `alert`, `confirm`, `prompt`, or
  "leave this page?" dialog pauses the page until it is answered. The tab
  keeps it in the dock state (`tabs[].dialog`), the pane draws it over the
  picture, and `POST /page/dialog` answers it. An agent action on that tab
  fails at once naming the dialog, an action that opens one ends as soon as
  it opens, and `browser.dialog` lets the agent answer.
- **File inputs** (`page-requests.js`). Chrome intercepts the chooser; the
  tab keeps it as `tabs[].fileChooser` with a folder of its own under
  `<project>/.openchamber/uploads/`. The pane uploads the person's files there
  through OpenChamber's file routes and `POST /page/file-chooser` hands them
  to the page, or cancels.
- **Downloads** (`downloads.js`). Chrome downloads into
  `<project>/.openchamber/downloads/.partial/` and a finished file moves next
  to it under the site's name, never replacing a file already there. The
  dock state lists them (`scopes[].downloads`), snapshots tell the agent the
  path, and the pane offers each finished one to save on the person's device.
  A browser with no project (signing into a profile) keeps downloads with the
  service's data and takes no uploads. Both folders get a `.gitignore` of
  `*`.
- **Sound** (`tab-audio.js`, `capture-guard.js`). Chrome runs with
  `--auto-accept-this-tab-capture`, so the service captures the sound of the
  tab in front from an isolated world of its own, encodes Opus with
  WebCodecs, and serves it on `GET /surface/audio` while a viewer has sound
  on. The same switch would let any page record its own tab without asking,
  so every page and frame target is attached paused, gets a
  `getDisplayMedia` that refuses before any of its scripts run, and only
  then resumes; a page Chrome refuses the guard for is closed. A new tab's
  guard is only confirmed once its first page arrives, so a slow one is
  waited for, not closed. Pages on insecure origins (plain `http` outside
  `localhost`) cannot be captured, so they send no sound.

## Who acts where

- **One Chrome per chat.** A scope is a project and a chat; nothing is
  shared between two chats' scopes, closing one closes only its Chrome.
  The Browser pane shows the scope of the chat on screen and keeps only that
  chat's tabs in its strip (`parkedBrowserTabs` in `useUIStore`).
- **The page keeps its size.** A new scope lays pages out at the desktop
  preset (1440x900, `source: 'default'`); opening or resizing the panel only
  scales the picture. The page follows the panel only in Fill
  (`mode: 'auto'`), set by the viewer's device bar or the agent's
  `viewport: 'fill'`.
- **The agent keeps its tab.** An action without `tabId` runs on the tab the
  agent last opened or used (`agentTabId`), else the one in front, so the
  person switching tabs never moves the agent. A page the agent's tab opens
  becomes its tab. `browser.snapshot` marks that tab `active`. The dock state
  reports it as `scopes[].agentTabId` (null before the agent used a tab) with
  `agentActive` while an action runs, so the pane can mark and follow it.
- **The viewer chooses the view while the agent works.** For a while after
  each action the host holds the picture for the agent. Picking a chat,
  picking a tab, and closing a chat's browser stay allowed then, and run
  outside the operation queue except the close; driving the agent's own page
  (navigate, reload, zoom) waits until the agent lets go. Other chats' pages
  are not held. Picking a chat or a tab never checks which frame the viewer
  drew last: right after a chat switch that frame is still the other chat's,
  and only commands that act on the page (navigate, input) need a picture of
  it.
- **The agent closes only its own tabs.** `browser.close` closes a tab the
  agent opened (`browser.open`, or a page one of its tabs opened), naming it
  or, without `tabId`, its most recent one. A tab the person opened is
  refused and stays open.
- **Login help needs a profile to last.** `browser.requestHelp` with
  `kind: 'login'` signs into the project's bound profile. A chat without one
  gets the ordinary hand-over of its page, and the answer carries
  `profileSaved: false` and a `note`, so the agent does not take the login
  for saved. A profile bound after a chat's browser started does not reach
  that browser; `browser.saveProfile` says so and how to restart onto it.
- **An agent asks before it touches profiles.** `browser.requestHelp` with
  `kind: 'profile'` (and `profileName`, default the project folder's name)
  shows the person a request in the Browser panel to create that profile
  or reuse the one of that name, bind the chat's project to it, and keep
  the chat's logins there. Nothing changes until they press Allow
  (`POST /help/profile`, open to the viewer like a page dialog's answer).
  Then the chat's cookies, except partitioned ones, go into a copy of the
  profile, that copy is saved, and the chat continues on a fresh copy with
  its pages. Local storage does not move. Declining or the time limit leaves
  everything as it was. An agent never creates, binds, or renames a
  profile any other way.
- **Tab icons.** Headless Chrome loads no favicons, so the service fetches
  each origin's icon once a page finishes loading (its `<link rel="icon">`,
  else `/favicon.ico`) through Chrome's own network stack
  (`Network.loadNetworkResource`, so the egress policy applies), capped at
  32 KB, and reports it as a data URL on `tabs[].favicon`.

### Why the page does not follow the panel by default

It used to: opening the panel made every page lay out again at the panel's
CSS size, so a site the agent was reading at desktop width switched to its
tablet or phone layout the moment someone looked. A fixed size keeps what the
person sees equal to what the agent saw.

## Configuration

There is no user-editable package directory for a built-in, so configuration
is read from, in order of increasing priority:

1. `${XDG_CONFIG_HOME:-~/.config}/openchamber-server-browser/config.json` —
   same file a folder install of the original extension used, so an existing
   one keeps working.
2. `<OPENCHAMBER_DATA_DIR>/server-browser.json`, when the host passes
   `OPENCHAMBER_DATA_DIR` to the service — instance-specific overrides, for a
   host that runs more than one OpenChamber instance on the box. Keys here
   win over (1).

Both files share `config.example.json`'s shape (`allowedOrigins`,
`allowedNetworks`, `discoverDevServers`, `projectDevServers`, `profileStore`,
`profileKeyFile`, `chromePath`). `projectDevServers` defaults to `true`;
`allowedOrigins`/`allowedNetworks` default to empty. Profiles, Chrome's
download, and the profile key still default under XDG data/config
directories (`${XDG_DATA_HOME:-~/.local/share}/openchamber-server-browser/`,
`${XDG_CONFIG_HOME:-~/.config}/openchamber-server-browser/profile.key`),
independent of `OPENCHAMBER_DATA_DIR`.

### OpenChamber origin refusal

The host supplies `OPENCHAMBER_BROWSER_ORIGINS` as a JSON array of HTTP(S)
origins. It combines its listening URLs with the server-owned settings field
`serverBrowserOpenChamberOrigins`. In a split installation the front door
mirrors that field to the agent server, including its configured, LAN and tunnel
origins. An absent settings field adds no origins beyond the agent server's
own listeners. A malformed field prevents the service from starting.

Local configuration files cannot set or clear this policy. `allowedOrigins`,
private-network approval and development-server discovery cannot override it.
Chrome's Fetch interception refuses matching requests before sending them,
including redirects, subframes and popups. It is enabled on paused targets
before they resume. A target that refuses interception stays paused or closes.
The existing egress proxy enforces the same refusal in `classifyProxyTarget`,
before DNS, listener probes or grants. HTTP forwarding, WebSocket upgrades and
CONNECT tunnels all use that decision. Fetch does not intercept WebSocket
handshakes, so the proxy is required even when CDP interception is enabled.
Hostnames compare case-insensitively without trailing dots; localhost names,
127/8, IPv6 loopback, IPv4-mapped loopback and unspecified bind addresses match
as loopback on the protected port. The refusal matches host and port across
schemes because CONNECT exposes only an authority and could carry plain
HTTP or WebSocket traffic. Default ports still follow the URL's scheme.
Other endpoints and development-server ports retain their existing policy.
File requests are refused by the CDP guard too.

After a successful settings write, the host stops a running browser whose
origin list changed. Its next request starts a fresh service with the current
policy. Tabs from the stopped service close. Editing settings directly on disk
requires a service restart; unknown proxy aliases must be listed explicitly.

This refusal protects the built-in browser's network use. The service runs as
the agent account and is not a sandbox for arbitrary code that account runs.

## Build and test

From the repository root:

```sh
bun run extensions:build
```

This package is not a Bun workspace member (see `packages/extensions/README.md`),
so most of its suites — the ones with no `@openchamber/sdk` import — run as
plain `node:test` files:

```sh
node scripts/run-isolated-tests.mjs packages/extensions/server-browser/test
```

Three suites import source that reaches into `@openchamber/sdk`
(`service.js`, `browser-runtime.js`, `tab-audio.js`): `service.test.js`,
`browser-integration.test.js`, and `tab-audio.test.js`. They are written in
`bun:test` style and run through `packages/web`'s Vitest, which already
aliases `@openchamber/sdk` to the SDK's TypeScript source
(`packages/web/vitest.config.ts`) the same way it does for every other server
suite that touches the SDK; that config lists these files explicitly, so they
are already part of `bun run --cwd packages/web test` (and therefore the root
`bun run test`):

```sh
bun run --cwd packages/web vitest run ../extensions/server-browser/test/service.test.js ../extensions/server-browser/test/browser-integration.test.js ../extensions/server-browser/test/tab-audio.test.js
```

`browser-integration.test.js` skips its Chrome-dependent cases when no
Chrome/Chromium binary is available; they ran against real Chrome during
this move (see the plan's QA notes). `chrome-install.test.js` and
`browser-manager.test.js` need no real Chrome and always run.
