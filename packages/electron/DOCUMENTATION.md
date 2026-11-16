# Desktop browser security

## Ownership

Electron main owns browser sessions, webview attachment, native permissions and
request interception. `agent-browser-policy.mjs` defines pure partition and URL
decisions. Shared UI owns tab provenance and chooses the partition before creating
a view. The web runtime owns browser-control request routing; the Server Browser
extension owns its separate server-side browser.

## Invariants

- Human pages use `persist:openchamber-browser`. Agent pages default to
  `persist:openchamber-browser-agent`, matching upstream's agent profile. Neither shares OpenChamber's app session.
  The upstream `agentBrowserSharesLogins` opt-in lets agent-owned tabs use the
  human profile. Browser control still refuses tabs the human opened.
- Only the separate agent session has the front-door request filter. Sharing the
  human profile explicitly grants that profile's logins and network access.
  Every resource type,
  redirect destination and WebSocket handshake goes through `onBeforeRequest`.
- Agent requests cannot reach known OpenChamber endpoints, loopback aliases or
  local interfaces on known server ports. File, DevTools, Chrome and packaged UI
  schemes are refused. URL parsing normalizes numeric IPv4, mapped IPv6, case and
  trailing dots before comparison. Initial webview URLs and renderer-initiated
  navigation also use this policy because internal Chrome pages may navigate
  without a network request.
- Each request reads current desktop hosts and connection settings, active window
  endpoints, the embedded server's tunnel URL and local interfaces. Unreadable or
  malformed settings cancel the agent request. Saved SSH forward ports and managed
  tunnel hostnames also remain protected while disconnected.
- Human browsing keeps its existing permissions and popup behavior. Agent and
  space pages open links in place, keeping their original session. Space-preview
  proxy restrictions remain independently owned by `space-preview.mjs`.
- Clear-data accepts exact human and agent partition names or a validated space
  partition. Capture requires membership of a hardened panel session. Favicons
  use the view's session; space favicon fetching remains refused.
- Both persistent panel sessions flush cookies and storage before `app.exit()`.

## Decisions

### Why the agent has a separate persistent session

Human panel pages can hold signed-in OpenChamber cookies. A separate persistent
agent partition preserves agent site logins without inheriting human or app
cookies. Persistent storage alone does not prevent a new login to the front door,
so main also refuses requests to its known endpoints.

### Why connection state is read at the request boundary

Settings have writers outside Electron main. A file watcher can deliver its
notification after a request starts, leaving a newly saved endpoint reachable.
Reading current state during interception removes that notification race and
requires no idle polling. Disk and interface enumeration costs per agent request
have not been profiled.

### Why favicon requests use Session.fetch

Electron's `net.fetch` uses the default session and does not accept a session
override. `view.session.fetch` carries the page's cookies and runs its request
filter, including on redirects.
