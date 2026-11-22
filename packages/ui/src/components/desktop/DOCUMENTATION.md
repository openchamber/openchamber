# Desktop controls

## Ownership

This module owns the desktop instance menu, host-switching UI, project app launcher, and custom window controls. Host configuration, status storage, runtime transport, and native window operations belong to the desktop and runtime libraries in `src/lib` and the Electron shell.

## Invariants

- The menu trigger and switcher header resolve the current instance through the same resolver, including the runtime fallback when saved instances are unavailable. The sidebar survives runtime switches, so endpoint-change notifications refresh its label.
- The default label names only a selectable host. Local can be absent when no local server exists.
- Remote update checks are status-only and do not report usage for the remote installation. Shared response parsing preserves `installBlocked` so the dialog cannot offer an unusable update command.
- The keyboard shortcut opens the sidebar before its footer menu, because a collapsed sidebar gives the menu a zero-width anchor.
- Configuration is authoritative for pruning host statuses. A probe can start before configuration loads and cannot establish that an instance is removed.
- SSH selection and opening an SSH instance in a new window both connect the tunnel first and reload the host entry for the rewritten forward URL and client token. A new tunnel invalidates the cached probe for the previous forward.
- Opening in a new window is pending per host until the window-open call settles, so a repeat click on that host never opens a second window, whatever other hosts do meanwhile. The pending state lives at module scope, because the sidebar menu unmounts its switcher on close while the open continues. The refreshed SSH entry replaces the menu's copy, and host-list saves (default star, edit) wait while any of these SSH connects and its entry reload is pending: the desktop shell replaces the saved list wholesale, so saving the older entry would drop the new forward URL and client token. The refreshed entry is published through the same module store, so a switcher mounted during the connect takes it too. Opens that connect nothing do not block saves.
- A switch probe publishes its final direct-or-relay outcome once, so an intermediate direct failure does not flash over a usable relay connection.
- Closing a switch-check dialog preserves the current instance. Cancellation after the direct leg skips relay setup and leaves status reporting to the menu probe; cancellation after a relay probe closes its unadopted tunnel. An ordinary cancelled check has no SSH connection to disconnect.
- A closing switch dialog retains its host label through the fade-out so its title stays stable.
- Relay-only rows describe the connection type because a `relay://` identifier is not a useful address to display.
- Both window-control styles retain their physical edge and button order in every language.
- Traffic-light hit targets preserve the titlebar's vertical hit band and the spacing between circles. Their right-edge inset remains separate from the classic Windows flush-edge convention.

## Decisions

### Why shared host statuses and not component-local state

Startup warms the shared status store, and opening the dropdown remounts its content. Component-local statuses discard known results on every open; rows retain the last probe result during refresh and use a live active connection as success only when no probe result exists, so a connected instance does not misleadingly say "Checking" and a measured result retains its latency.

### Why cached switch probes and not an unconditional second probe

The dropdown already probes hosts on open, so repeating a usable probe adds switch latency and transient failure states. A pending probe needs a fresh check before navigation to avoid stranding the window on an unavailable host; Local and the currently connected instance already have evidence of availability.

### Why relay adoption and not a second tunnel handshake

The renderer's runtime fetch and socket layers use the singleton E2EE tunnel registry. Adopting a probe's retained tunnel before the endpoint switch lets activation reuse the matching descriptor without another WebSocket connection and handshake; background candidate refresh discovers a changed LAN address so a stale direct address does not keep the host on relay.

### Why host-based new windows and not fixed relay URLs

A relay-capable host needs the local UI to select direct or tunnel transport when the new window starts. A fixed navigation URL cannot express that choice.

### Why shell-assisted Local switching and not always switching in place

A page served by another instance cannot reach the local server, so the desktop shell loads the Local UI. Pages already served by the app switch their runtime endpoint in place.

### Why memoize the project app launcher and not rerender it with each session change

The header rerenders for many session changes while the launcher's directory and class props stay stable. Memoization avoids repeating that unrelated render work.

### Why fixed traffic-light colors and not theme status tokens

Traffic lights reproduce macOS window chrome across themes, so their platform colors sit outside the theme-token hex policy. Translucent black glyphs let each fill tint its symbol while retaining legibility across all 3 colors.

### Why measured control width and not reserved-width constants

`TitlebarLeftControls` measures the cluster with `ResizeObserver`, so changing control styles updates reserved width automatically. Left-side classic buttons match the titlebar icon band and avoid negative margins because inaccurate width makes the project-actions chevron overlap the session title; right-side classic buttons retain the taller Windows hit target.

### Why paired solid close-hover colors and not the error background wash

The classic close button pairs the solid error red with its authored foreground. The error-background token is a banner tint against which that foreground is unreadable in both theme modes.
