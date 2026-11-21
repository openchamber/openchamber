# Update UI

## Ownership

This module owns update notifications, compatibility recovery, and the release-note presentation shared by Settings > About and the update dialog. The server owns upgrade availability and installation. Runtime transport and desktop readiness belong to the adjacent runtime and OpenCode libraries.

## Invariants

- Compatibility checks leave the application mounted while pending or disabled. Only confirmed incompatibility replaces it; failed reads leave connection recovery in charge and preserve any known incompatibility.
- A runtime switch during native preflight invalidates the old check before it can request the new endpoint. A `null` result means the desktop shell already confirms compatibility for its managed OpenCode.
- Recovery removes the initial HTML loading overlay because the application cannot finish initializing against OpenCode v1.
- An OpenCode 2.x below the minimum needs update guidance. The recovery screen shows the binary path so users with several installations can identify the one in use.
- Update availability and installation support are independent. External runtimes still receive announcements even when the host cannot upgrade their CLI.
- Disabling OpenCode update notifications takes precedence over deduplication and dismisses the active announcement before dedup state changes.
- Closing or swiping an update announcement skips that version. Starting an upgrade or programmatically removing an announcement does not record a user dismissal; mobile dismissal checks that the same update is still available.
- Update event versions are trimmed strings because downstream deduplication compares literal versions. Callers pass normalized versions to the decision helpers.
- A failed upgrade-status read throws so callers cannot mistake it for an authoritative absence of updates.
- A status with `available: null` and an explicit `latestVersion: null` is the server route's answer to a failed registry lookup: the installed version is still shown, and the update announcement retries on the same schedule as a failed read. Any other successful status ends the retries, including the VS Code bridge's settled answers (no managed OpenCode, or its own registry error, which omits `latestVersion`).
- Release-note responses use `YYYY-MM-DD` dates, newest-first releases, and non-empty groups in changelog order with Markdown bullets. Unavailable notes return `null`; an empty list means the changelog has no notes for the requested range.
- The Markdown parser accepts the group headings emitted by `packages/web/server/lib/changelog/update-notes.js`. Other formats, including arbitrary GitHub updater notes, remain unparsed.
- Release-note links open in the external browser on desktop as well as web.

## Decisions

### Why pure toast decisions and not effect-driven helpers

Decision helpers accept explicit inputs so they can be tested without a DOM, storage, or React. React callers own storage writes, toast creation, and event listeners; the helper exports are internal testing boundaries rather than a stable consumer API.

### Why prefetch compatibility and not wait for the gate

The compatibility check starts alongside authentication so the gate can use its result immediately on mount. A read that fails before sign-in is retried when the gate consumes it.

### Why update through the connected transport and not a direct host URL

Outdated-server recovery uses the server's update route over the existing transport so relay and tunnel hosts remain reachable. Servers that cannot update themselves receive manual command guidance.
