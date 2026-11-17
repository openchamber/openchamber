# Session authentication

## Ownership

This module owns the session gate, password and passkey login orchestration, and the mid-session expiry banner. Runtime auth helpers own requests and the shared expiry state; directory and persistence modules own home resolution and stored workspace preferences.

## Invariants

- Retry bookkeeping survives re-renders. Pending retry timers clear on unmount, endpoint switches, and definitive session answers. Network failures do not establish a password requirement; a 401 does.
- A successful session check marks the shared auth store authenticated even when the gate already has that state. Login in another tab can leave the gate state unchanged, so a state-change effect alone cannot clear expiry.
- Mid-session expiry leaves work visible and interactive. The banner's explicit login action requests a session check through `reauthenticating`; a genuine 401 enters the full locked flow, and successful authentication restores `ok`.

## Decisions

### Why bounded retries and not a single session check

The first relay request can race the tunnel's initial WebSocket attempt, which rejects queued requests before reconnecting; lossy links and backend startup can also recover without user action. Transient failures receive a bounded retry budget before the error screen appears, while successful responses, 401, and 429 end retries.

### Why local-runtime detection includes same-origin defaults and loopback aliases

An empty API base targets the desktop page's embedded server, and loopback aliases address that same machine. These targets need `desktop-local` client metadata because the server's client-create gate rejects untagged local tokens.

### Why home resolution gates mounting for a bounded wait

The unauthenticated page-load home lookup can fall back to `/`, so the app waits for an authenticated lookup to avoid starting work in the wrong directory. The lookup has no timeout of its own, so the gate releases the app after 10 seconds if it stalls.

### Why workspace pointers load only during bootstrap

The first authentication on a page load adopts persisted workspace pointers. Reauthentication preserves the window's current workspace because shared settings can contain another window's pointers.

### Why the expiry banner sits below the header

The desktop header can be a window-drag region that prevents clicks. Placing the banner below it keeps the login action clickable.
