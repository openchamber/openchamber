# Terminal viewport

## Ownership

This module owns the React terminal viewport, chunk replay selection, the tab rename dialog, and the tab bar with its phone sheet. The viewport connects terminal state and host clipboard actions to the emulator. The [Ghostty adapter](../../lib/ghostty/DOCUMENTATION.md) owns VT parsing, rendering, input encoding, and DOM measurement; the terminal store owns PTY state.

## Invariants

- `TerminalController.pasteClipboard` starts from the click handler itself so clipboard reads retain the browser's user activation.
- Provisional sizing uses the same cell-height rule as `measureGhosttyCell`, the larger of 1.35em and the glyph box. The estimate can start a shell early, but an existing PTY must follow the emulator's fitted `onResize` size. Hosts with an existing PTY must provide `onProvisionalSize` to keep estimates off the authoritative resize channel.
- The native selection clipboard is available only on Linux desktop. Clearing the terminal selection leaves PRIMARY and any pending selection write intact; middle-click reads wait for the in-flight write so they paste the latest selection.
- Only the native context-menu event forwarded by the surface can open the React menu. The surface decides whether a terminal application owns the click.
- Teardown blurs a focused terminal editable before removing its DOM and explicitly hides the Android keyboard. Removing it during IME composition can leave Android WebView's input dispatch unresponsive to touch.
- Snapshot replay uses the PTY size recorded with the snapshot before reflowing to the fitted grid, because historical lines are already wrapped for that size.
- Touch-host paste failures name no keyboard fallback because those hosts have no paste shortcut.

## Decisions

### Why the emulator loads on mount and not with the dock

The Ghostty adapter loads on demand so the bottom dock can import `TerminalView` eagerly without putting the WASM emulator and canvas renderer into the startup dependency graph.

### Why font loading has a bound and not an unlimited wait

The bundled monospace face normally loads immediately, but a stalled fetch must leave the terminal usable. After 2000 ms the surface can measure available faces; `document.fonts` sends `loadingdone` when a late face arrives so the adapter can refit.

### Why a portrait phone lists tabs in a sheet and not in the strip

On a portrait phone the strip shares its row with new-tab and four actions, which leaves room for about one squeezed tab, and the always-visible close buttons sit where a tap meant to switch lands. On a phone narrower than 640px, outside the tablet layout, the header shows one trigger naming the active tab with a count, and a bottom sheet lists every tab with its full name, rename and close. A phone in landscape and a tablet have the width for the strip and keep it.

### Why theme and font updates reuse the surface and not recreate it

The surface persists for the mounted container and factory so configuration updates preserve the live terminal. Theme and font changes apply in place.
