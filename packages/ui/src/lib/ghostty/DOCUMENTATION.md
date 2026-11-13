# libghostty-vt Terminal Adapter

## Ownership

This directory is OpenChamber's browser adapter for the official `libghostty-vt` C ABI, adapted from T3 Code (see `LICENSE-T3CODE`). It replaces the `ghostty-web` npm package: the emulator, the renderer and the input layer are all owned here, so a terminal bug is fixed in this directory rather than patched around in `node_modules`.

- `runtime.ts` owns the single WebAssembly instance per page, the C struct layouts read from `ghostty_type_json`, allocation helpers, and the PTY write callback trampoline (embedded bytes compiled from `../../../scripts/ghostty-write-pty.zig`).
- `core.ts` owns one terminal's Ghostty handles: VT writes, resize, theme and 256-color palette, selection, key/mouse/paste encoding, and the render-state snapshot (`GhosttySnapshot`) the renderer draws.
- `renderer.ts` paints a snapshot into a Canvas 2D context: background runs, text runs, decorations, cursor. It measures the cell from the faces that will render.
- `surface.ts` owns the DOM: canvas, hidden textarea (keyboard, IME, clipboard), scrollbar, pointer selection, link hover/activation, mouse reporting, wheel scrolling, cursor blink, DPR changes, and the fit/notify cycle toward the PTY.
- `boxDrawing.ts` draws Box Drawing (U+2500–U+257F), Block Elements (U+2580–U+259F) and Powerline arrows (U+E0B0–U+E0B3) procedurally to the exact cell; the renderer never sends those to the font.
- `keyCodes.ts` mirrors the `GhosttyKey` enum of the pinned revision. `terminalLinks.ts` matches URLs across soft-wrapped rows. `fonts.ts` normalizes family lists for the canvas font shorthand and probes for monospace advances.
- `vendor/` holds the reproducible artifact (`ghostty-vt.wasm`), the pinned upstream revision (`VERSION`) and Ghostty's license. `fonts/` vendors the symbols-only Nerd Font (MIT) so prompt glyphs render without a locally installed Nerd Font and without a CDN.

`components/terminal/TerminalViewport.tsx` is the only React consumer. React stays out of the render loop: the surface schedules its own frames.

The viewport owns the desktop Copy/Paste context menu. Its trigger accepts only the native event forwarded by `surface.onContextMenu`, so mouse-reporting applications retain right clicks and the surface's Shift override still applies. Touch-owned viewports keep their existing gestures. Copy snapshots the selection when the menu opens; Paste uses `surface.pasteFromClipboard` for bracketed-paste encoding and native-paste deduplication. The viewport invalidates pending clipboard reads on session changes, hide and unmount. Clipboard read failures show a translated error with a keyboard-paste fallback.

On Linux, terminal selection changes publish to PRIMARY through the local Electron bridge. A drag replaces one pending write instead of queuing every intermediate selection, and a click that clears the selection leaves PRIMARY unchanged. With the bridge, a plain middle click reads PRIMARY through `surface.pasteFromClipboard` when no application tracks the mouse. A mouse-reporting TUI receives the plain middle-button event; Shift bypasses tracking and pastes PRIMARY. The surface suppresses Chromium's follow-up paste for both bridge-owned paths, so the TUI click does not also insert clipboard text. Ctrl and Meta middle clicks keep the browser's paste, and without the bridge the browser's native middle-click paste reaches the terminal.

Touch-owned viewports have no menu and no paste shortcut, so `TerminalView` puts a Paste button next to Copy in the tab toolbar on those hosts only and calls `TerminalController.pasteClipboard`. It takes the same path as the menu's Paste, bracketed-paste encoding included, and its failure toast names no shortcut. Long-press stays text selection: the surface owns touch, so the system never sees a long-press it could answer with its own Paste menu. Clipboard text comes from `readClipboardText` (`lib/clipboard.ts`), which starts the read inside the click. iOS WebKit then shows its own Paste bubble and answers once the user taps it; dismissing the bubble rejects the read. Android WebView refuses web clipboard reads with no prompt, so the Android app reads through its `ClipboardText` plugin (`packages/mobile/README.md`).

## Invariants

- On Android the hidden textarea rests at one space with the caret after it; elsewhere it rests empty. Every deletion a soft keyboard makes there fires an `input` event of type `deleteContentBackward`, and `onInput` sends exactly one Backspace for it through the key encoder (with a release for Kitty report-all programs) and puts the space back. Every keydown first returns the caret to after the space, because Gboard's space-bar swipe moves it without an event. Typed and composed text reaches the PTY without the space. Deletion is handled on `input` only, never on `beforeinput`. Other platforms leave deletion edits alone, as before.
- The paste shortcut starts a clipboard read and keeps the browser's native paste event; `TerminalPasteArbiter` lets exactly one deliver. Chromium fires the native event first and it cancels the read. WebKit resolves the read first, so the native event of the same keystroke is swallowed when it arrives within one second.
- A terminal selection is copied to the regular clipboard only by an explicit Copy. In local Linux Electron, selection changes publish PRIMARY; Copy uses the regular clipboard. Middle-click paste stays with the editable surface or terminal under the pointer. A mouse-reporting application owns the plain middle click, Shift bypasses that reporting and pastes PRIMARY, and a terminal without an application claiming the mouse pastes on a plain click. The surface suppresses Chromium's follow-up paste only when its own branch consumes the click.
- On macOS, unshifted Option+Left/Right sends ESC+b/f and Option+Backspace sends Ctrl+W at legacy prompts. `core.encodeMacWordShortcut` checks the active screen and Kitty keyboard flags before translating; alternate-screen and Kitty-enabled programs receive the original keys. `surface.ts` consumes the matching keyup for translated shortcuts. Other platforms, extra modifiers and Option character input retain normal encoding.
- On macOS, Option that composed an ASCII symbol the key does not type on its own (Option+4 is `$` on Swedish, German and Ukrainian layouts) counts as a consumed modifier, so the symbol reaches the shell as text. Option letters and digits (Russian - PC types Latin letters with Option) and non-ASCII characters such as `€` or Polish `ą` keep the Meta encoding: Option+B sends ESC b. `ghosttyConsumedMods` reads the active layout through `navigator.keyboard.getLayoutMap()` where the engine has it and falls back to US letters and digits.
- On macOS every Cmd keydown without Ctrl bypasses the encoder and is not `preventDefault`ed, so a menu accelerator or the browser claims it (`isTerminalMacAppShortcut`); its keyup is swallowed through `suppressedKeyCodes`. At plain shell prompts, Cmd+Backspace sends Ctrl+U and Cmd+Left/Right send Ctrl+A/E (`encodeMacLineShortcut`). Cmd+Home/End/PageUp/PageDown on macOS and Shift+Home/End/PageUp/PageDown elsewhere scroll the viewport (`terminalViewportScrollShortcut`). These overrides run only on the primary screen with no Kitty keyboard flags, and never during IME composition. Alternate-screen and Kitty programs keep the existing app-shortcut and encoder paths. Option and Cmd+Ctrl keep encoding. On Windows and Linux, Ctrl+=/-/0 without Alt or Shift bypasses the encoder the same way, so the app or browser zoom fires (`isTerminalZoomShortcut`); every other chord there keeps encoding.
- Web and Electron terminals share these bindings, as do hosted and Capacitor mobile terminals with an external keyboard. The VS Code layout does not mount this terminal.
- The grid is measured after the faces that will render are loaded (`document.fonts.load` for every style plus the bundled symbols font). A face that finishes loading later triggers a re-measure through `loadingdone`. Never size the grid from a fallback face on purpose.
- Generic keywords Chromium's canvas parser rejects (`ui-monospace`, `system-ui`) are stripped before any `context.font` assignment; an invalid shorthand silently no-ops and the grid would be measured with the previous font.
- The canvas context is created with `willReadFrequently: true`, which pins it to the software rasterizer. Gecko otherwise picks acceleration per canvas, and its GPU text path on macOS skips CoreText smoothing: a terminal created after page load drew thin, pencil-like glyphs while the first one stayed on the software path (confirmed: `gfx.canvas.accelerated=false` in Zen removed the symptom). The backing store is also sized to the mount at DPR before the first paint, so the compositor never sees the default 300×150 store stretched.
- Cell-filling symbols (borders, bars, block logos) are drawn by `boxDrawing.ts`, snapped to whole CSS pixels so neighbouring cells meet without seams. Fonts draw these only as tall as their em box, so at the 1.35 em line height every TUI border showed a strip of background between rows.
- The PTY hears about a resize only after the grid settles (150 ms) and at most once per fit; `onResize` is the sole resize channel. The first successful fit always notifies, even at the construction size.
- History replay (`resetAndWrite`) detaches the PTY writer so historical device queries never reach the live shell, and runs at the PTY size the history was drawn for when the caller passes one, so Ghostty reflows lines where the shell wrapped them.
- A hidden surface (`setVisible(false)`) keeps parsing output and answering VT queries but schedules no frames, no cursor timer and no scrollbar work. Reveal repaints in full.
- Touch hosts (`handleTouchPointer: false`) own scroll and long-press gestures through `scrollLines`, `selectWordAt` and `extendSelectionTo`; the surface ignores touch pointers and the compatibility mouse events that follow them so a tap does not summon the soft keyboard.
- Every terminal frees its own handles on `dispose()`; the WebAssembly instance is shared and never torn down.

## Decisions

### Why Android keeps a space in the textarea and not an empty field

Gboard deletes the characters it typed through the field (`deleteSurroundingText`), and in an empty field Chrome fires only a `keydown`/`keyup` pair with key code 229 and no edit. Once Gboard has nothing of its own left to delete, it sends a Backspace keydown whose `code` is empty, which the encoder cannot map. Both cases were measured on an Android 15 emulator with Gboard 14.2, Chrome 124 and Chromium 158. Reading an empty 229 pair as Backspace was rejected: Gboard sends the same empty pair before every Enter, so the last character of each command would be erased. With a space resting in the field, both cases become an ordinary deletion edit, which is authoritative. A keyboard that replaces several characters in one edit, such as tapping the suggestion "each" after typing "ech", removes only the space, so one character is deleted.

### Why deletion is read from `input` and not `beforeinput`

On the same emulator, Chromium 158 ignored `preventDefault` on the `beforeinput` of a keyboard's deletion: the field still lost its character and `input` followed. Sending a Backspace on `beforeinput` and cancelling it would therefore delete twice whenever the field holds text. `input` fires once per finished edit, whichever way the keyboard made it.

### Why shell shortcuts yield to alternate-screen and Kitty programs

OpenChamber applies Ghostty-style line editing and viewport bindings only at plain shell prompts to preserve application keyboard handling. Active screen and negotiated Kitty flags are authoritative; application cursor mode alone does not disable shell editing because shells can enable it too.

### Why Cmd+K remains unhandled

Ghostty's clear-screen binding needs an API the pinned `libghostty-vt` ABI does not expose. Cmd+K retains the app-shortcut path and has no terminal action; these bindings do not implement the full Ghostty keymap.

### Why Linux selection clipboard access is native

The canvas selection is not a DOM selection, and the web Clipboard API cannot write PRIMARY. Electron exposes `clipboard.selection` on Linux, so the local-page bridge is the only path that publishes the terminal's selection; remote pages, browsers, VS Code and mobile deliberately get no bridge. Copy stays on the regular clipboard path.

### Why the selection writer keeps only one pending write

A drag reports selection changes for every cell, and writing every value would queue text the user has already moved past. The viewport starts one write and replaces the pending text while it is in flight. A middle-click read waits for that write so it sees the selection the user just made. Copy does not wait for or flush this writer.

### Why the terminal times its middle-click suppression

Chromium emits a paste event after middle-click even when the surface handled the pointer event. The local bridge timestamps both clicks it turns into PRIMARY paste and plain clicks it sends to a mouse-reporting TUI, so the TUI's mouse event is not followed by clipboard text in the PTY. `pointerup` refreshes the timestamp because Chromium may paste on release. A terminal without the bridge and Ctrl or Meta middle clicks keep the browser's native paste.

## Updating libghostty-vt

1. Put the new upstream commit hash in `vendor/VERSION`.
2. Run `bun run --cwd packages/ui build:ghostty-wasm`. It downloads Zig 0.15.2 into `~/.cache/openchamber-ghostty`, clones Ghostty at the pin, builds `wasm32-freestanding`, replaces `vendor/ghostty-vt.wasm`, and prints the trampoline bytes for `runtime.ts` (they only change when the Zig source changes).
3. Reconcile the ABI numbers in `core.ts` (`RENDER_DATA`, `ROW_DATA`, `CELL_DATA`, option ids in `setTheme`, `ghostty_terminal_get` ids) and `keyCodes.ts` against the headers of the new revision.
4. `runtime.test.ts` fails when the artifact's embedded build metadata disagrees with `VERSION`.

On macOS 27 with Xcode 26+ SDKs the script works around a Zig 0.15.2 limitation: the SDK's `libSystem.tbd` lists only `arm64e-macos`, so the script builds a patched SDK root and shims `xcrun` for the duration of the build.

## Verification

```sh
bun test packages/ui/src/lib/ghostty packages/ui/src/components/terminal
bun run --cwd packages/ui type-check
```

The `core` and `runtime` tests run the real WebAssembly under bun; they cover reflow, palette, replay isolation and recycled-row cleanliness.
