# libghostty-vt Terminal Adapter

## Ownership

This directory is OpenChamber's browser adapter for the official `libghostty-vt` C ABI, adapted from T3 Code (see `LICENSE-T3CODE`). It replaces the `ghostty-web` npm package: the emulator, the renderer and the input layer are all owned here, so a terminal bug is fixed in this directory rather than patched around in `node_modules`.

- `runtime.ts` owns the single WebAssembly instance per page, the C struct layouts read from `ghostty_type_json`, allocation helpers, and the PTY write callback trampoline (embedded bytes compiled from `../../../scripts/ghostty-write-pty.zig`).
- `core.ts` owns one terminal's Ghostty handles: VT writes, resize, theme and 256-color palette, selection, key/mouse/paste encoding, and the render-state snapshot (`GhosttySnapshot`) the renderer draws.
- `renderer.ts` paints a snapshot into a Canvas 2D context: background runs, text runs, decorations, cursor. It measures the cell from the faces that will render.
- `surface.ts` owns the DOM: canvas, hidden textarea (keyboard, IME, clipboard), the composed-text overlay, scrollbar, pointer selection, link hover/activation, mouse reporting, wheel scrolling, cursor blink, DPR changes, and the fit/notify cycle toward the PTY.
- `boxDrawing.ts` draws Box Drawing (U+2500–U+257F), Block Elements (U+2580–U+259F) and Powerline arrows (U+E0B0–U+E0B3) procedurally to the exact cell; the renderer never sends those to the font.
- `keyCodes.ts` mirrors the `GhosttyKey` enum of the pinned revision. `terminalLinks.ts` matches URLs across soft-wrapped rows. `fonts.ts` normalizes family lists for the canvas font shorthand and probes for monospace advances.
- `vendor/` holds the reproducible artifact (`ghostty-vt.wasm`), the pinned upstream revision (`VERSION`) and Ghostty's license. `fonts/` vendors the symbols-only Nerd Font (MIT) so prompt glyphs render without a locally installed Nerd Font and without a CDN.

`components/terminal/TerminalViewport.tsx` is the only React consumer. React stays out of the render loop: the surface schedules its own frames.

The viewport owns the desktop Copy/Paste context menu. Its trigger accepts only the native event forwarded by `surface.onContextMenu`, so mouse-reporting applications retain right clicks and the surface's Shift override still applies. Touch-owned viewports keep their existing gestures. Copy snapshots the selection when the menu opens; Paste uses `surface.pasteFromClipboard` for bracketed-paste encoding and native-paste deduplication. The viewport invalidates pending clipboard reads on session changes, hide and unmount. Clipboard read failures show a translated error with a keyboard-paste fallback.

On Linux, terminal selection changes publish to PRIMARY through the local Electron bridge. A drag replaces one pending write instead of queuing every intermediate selection, and a click that clears the selection leaves PRIMARY unchanged. With the bridge, a plain middle click reads PRIMARY through `surface.pasteFromClipboard` when no application tracks the mouse. A mouse-reporting TUI receives the plain middle-button event; Shift bypasses tracking and pastes PRIMARY. The surface suppresses Chromium's follow-up paste for both bridge-owned paths, so the TUI click does not also insert clipboard text. Ctrl and Meta middle clicks keep the browser's paste, and without the bridge the browser's native middle-click paste reaches the terminal.

Touch-owned viewports have no menu and no paste shortcut, so `TerminalView` puts a Paste button next to Copy in the tab toolbar on those hosts only and calls `TerminalController.pasteClipboard`. It takes the same path as the menu's Paste, bracketed-paste encoding included, and its failure toast names no shortcut. Long-press stays text selection: the surface owns touch, so the system never sees a long-press it could answer with its own Paste menu. Clipboard text comes from `readClipboardText` (`lib/clipboard.ts`), which starts the read inside the click. iOS WebKit then shows its own Paste bubble and answers once the user taps it; dismissing the bubble rejects the read. Android WebView refuses web clipboard reads with no prompt, so the Android app reads through its `ClipboardText` plugin (`packages/mobile/README.md`).

## Invariants

- On Android the hidden textarea rests at one space with the caret after it; elsewhere it rests empty. Every deletion a soft keyboard makes there fires an `input` event of type `deleteContentBackward`, and `onInput` sends exactly one Backspace for it through the key encoder (with a release for Kitty report-all programs) and puts the space back. Every keydown first returns the caret to after the space, because Gboard's space-bar swipe moves it without an event. Typed and composed text reaches the PTY without the space. Deletion is handled on `input` only, never on `beforeinput`. Other platforms leave deletion edits alone, as before.
- While an IME composes, the overlay shows the `compositionupdate` text underlined at the cursor, one line, in the terminal's own colors. `compositionend` clears it, and the composed text reaches the PTY only there, once. The overlay sits on the cursor's cell even when the program hides the cursor, and draws nothing while the cursor is scrolled out of the viewport. It moves left as far as the terminal's right edge requires, and text wider than the terminal shows its end. It takes no pointer events and is hidden from assistive technology.
- The paste shortcut starts a clipboard read and keeps the browser's native paste event; `TerminalPasteArbiter` lets exactly one deliver. Chromium fires the native event first and it cancels the read. WebKit resolves the read first, so the native event of the same keystroke is swallowed when it arrives within one second. An empty native paste leaves the clipboard read as the only path. A host read (context menu or middle click) claims the same token before it starts, so a shortcut or native paste arriving during it supersedes it; a middle click's native paste event is swallowed, which leaves that read as the only delivery.
- A terminal selection is copied to the regular clipboard only by an explicit Copy. In local Linux Electron, selection changes publish PRIMARY; Copy uses the regular clipboard. Middle-click paste stays with the editable surface or terminal under the pointer. A mouse-reporting application owns the plain middle click, Shift bypasses that reporting and pastes PRIMARY, and a terminal without an application claiming the mouse pastes on a plain click. The surface suppresses Chromium's follow-up paste only when its own branch consumes the click.
- On macOS, unshifted Option+Left/Right sends ESC+b/f and Option+Backspace sends Ctrl+W at legacy prompts. `core.encodeMacWordShortcut` checks the active screen and Kitty keyboard flags before translating; alternate-screen and Kitty-enabled programs receive the original keys. `surface.ts` consumes the matching keyup for translated shortcuts. Other platforms, extra modifiers and Option character input retain normal encoding.
- On macOS, Option that composed an ASCII symbol the key does not type on its own (Option+4 is `$` on Swedish, German and Ukrainian layouts) counts as a consumed modifier, so the symbol reaches the shell as text. Option letters and digits (Russian - PC types Latin letters with Option) and non-ASCII characters such as `€` or Polish `ą` keep the Meta encoding: Option+B sends ESC b. `ghosttyConsumedMods` reads the active layout through `navigator.keyboard.getLayoutMap()` where the engine has it and falls back to US letters and digits.
- On macOS every Cmd keydown without Ctrl bypasses the encoder and is not `preventDefault`ed, so a menu accelerator or the browser claims it (`isTerminalMacAppShortcut`); its keyup is swallowed through `suppressedKeyCodes`. At plain shell prompts, Cmd+Backspace sends Ctrl+U and Cmd+Left/Right send Ctrl+A/E (`encodeMacLineShortcut`). Cmd+Home/End/PageUp/PageDown on macOS and Shift+Home/End/PageUp/PageDown elsewhere scroll the viewport (`terminalViewportScrollShortcut`). These overrides run only on the primary screen with no Kitty keyboard flags, and never during IME composition. Alternate-screen and Kitty programs keep the existing app-shortcut and encoder paths. Option and Cmd+Ctrl keep encoding. On Windows and Linux, Ctrl+=/-/0 without Alt or Shift bypasses the encoder the same way, so the app or browser zoom fires (`isTerminalZoomShortcut`); every other chord there keeps encoding.
- Web and Electron terminals share these bindings, as do hosted and Capacitor mobile terminals with an external keyboard. The VS Code layout does not mount this terminal.
- The grid is measured after the faces that will render are loaded (`document.fonts.load` for every style plus the bundled symbols font). A face that finishes loading later triggers a re-measure through `loadingdone`. Never size the grid from a fallback face on purpose.
- Generic keywords Chromium's canvas parser rejects (`ui-monospace`, `system-ui`) are stripped before any `context.font` assignment; an invalid shorthand silently no-ops and the grid would be measured with the previous font. Family names that are not a single CSS identifier are quoted for the same reason.
- A face must render every character on one advance, and the probe refuses one that does not. A probe that cannot run, or an absent face measured through the `monospace` fallback, counts as monospace so the normal fallback chain resolves it. Concrete text faces come before the symbols-only fallbacks; those add no text glyphs, so metrics are unchanged and a locally installed Nerd Font keeps its prompt glyphs. A failed bundled-font load leaves the installed fallbacks in place.
- Overlapping `setFont` calls apply only while their epoch is current. `loadingdone` is ignored while an explicit load is pending, then re-runs the fixed-width guard with the newly loaded metrics. A metrics change clears the cached IME coordinates and refits.
- The canvas context is created with `willReadFrequently: true`, which pins it to the software rasterizer. Gecko otherwise picks acceleration per canvas, and its GPU text path on macOS skips CoreText smoothing: a terminal created after page load drew thin, pencil-like glyphs while the first one stayed on the software path (confirmed: `gfx.canvas.accelerated=false` in Zen removed the symptom). The backing store is also sized to the mount at DPR before the first paint, so the compositor never sees the default 300×150 store stretched.
- Cell-filling symbols (borders, bars, block logos) are drawn by `boxDrawing.ts`, snapped to whole CSS pixels so neighbouring cells meet without seams. Fonts draw these only as tall as their em box, so at the 1.35 em line height every TUI border showed a strip of background between rows.
- The PTY hears about a resize only after the grid settles (150 ms) and at most once per fit; `onResize` is the sole resize channel. Notifying on every drag step would make the shell reprint its prompt mid-drag. The first successful fit always notifies, even at the construction size. Disposing inside the debounce window flushes the settled size so the PTY keeps the final grid.
- The alternate screen has no scrollback, so wheel motion becomes arrow-key input there, matching xterm; the primary screen scrolls the viewport.
- History replay (`resetAndWrite`) detaches the PTY writer so historical device queries never reach the live shell, and runs at the PTY size the history was drawn for when the caller passes one, so Ghostty reflows lines where the shell wrapped them.
- A hidden surface (`setVisible(false)`) keeps parsing output and answering VT queries but schedules no frames, no cursor timer and no scrollbar work. Reveal repaints in full. A canvas inside a mount with no size has nothing to paint; the next fit repaints after the mount gets one. The `visible` option is read after font and WASM loading, and a host getter supplies the latest value.
- Hosts call `refresh()` after a container transition such as an opened panel or a released resize handle: the canvas does not change, but a compositor that cached it mid-transition drops that cache only when its contents update.
- The cursor blinks only when the surface is focused, the program enabled blinking, the cursor is visible and reduced motion is off. Otherwise it is drawn steady, and an unfocused surface draws a hollow cursor. Every write, replay, focus and reveal restarts from the visible phase, and a reduced-motion change wakes an idle cursor that has no timer left.
- The grid sits at the top while there is no scrollback and anchors to the bottom once there is. The origin changes only with a full repaint, never between dirty-row redraws.
- Before the font and WASM loads, the theme background is painted into the canvas so setup never flashes black. The first fit installs the DPR transform even when the target size equals the default 300×150 backing store and renders synchronously, because ResizeObserver fires before paint; a deferred frame would composite the old store stretched into the new box. The resolution media query is re-armed after every change because it fires once for the ratio it was created at.
- Link hit-testing uses only the viewport rows in the snapshot. The row soft-wrap flag decides where a line continues, and a URL whose tail continues below the viewport does not activate.
- Word and line selection keep their base in screen coordinates so streaming output cannot shift a drag. Dragging past the edge scrolls and keeps extending into the revealed rows. Selection changes force a full render because their highlight spans rows Ghostty may not mark dirty.
- A copy parks the selection in the hidden textarea and clears the field only while it still holds that parked text. The field is never rewritten during composition. A native copy that wrote the selection invalidates the in-flight `clipboard.writeText` fallback. On Linux and Windows a plain Ctrl+C clears the selection after copying so the next Ctrl+C reaches the shell; Cmd+C and the Shift variants keep it.
- Every native paste event is prevented, so text the textarea would receive (an HTML-only clipboard converted to text, for example) cannot reach the shell without bracketed-paste encoding.
- A press the host claims through `beforeKey`, or a macOS app or zoom shortcut deliberately left to the app, suppresses its keyup so Kitty report-event-types programs never see a release for a press the shell did not receive. The suppressed-code set survives blur. A translated word shortcut suppresses its release the same way.
- Safari signals an IME-opening keydown only through keyCode 229; encoding it or clearing the textarea would double the committed text, so that keydown returns untouched. A keyup produces data only when the program enabled Kitty report-event-types.
- Hover motion is reportable only in any-event tracking; normal and button-event tracking report none without a pressed button. A tracking change without pointer movement clears the previous motion data so the next same-cell motion starts a session, and a drag already sent to the application cannot later turn into link activation.
- The hidden textarea follows the terminal cursor's cell because the IME candidate window anchors to it. A preedit left edge is floored to a whole pixel so no sliver of the block cursor shows.
- The artifact URL is built with `new URL(..., import.meta.url)` so Vite treats it as a static asset in web, the VS Code webview and the Electron protocol, while bun's test runner reads a file URL. The PTY trampoline is embedded bytes compiled from `scripts/ghostty-write-pty.zig`, and its table entry is registered with grow-then-set. The log import reads memory through a holder because the instance does not exist until `instantiate` returns. An opaque slot is zeroed before `*_new` writes it so a dispose after partial initialization cannot free a garbage pointer.
- Grapheme codepoints are decoded in 4096-code-point chunks because engines cap spread-call arguments, and read through a `DataView` because the byte-array allocator gives no four-byte alignment. Styles are read after allocations and ABI calls, which can grow WASM memory.
- A reset (`RIS`) restores Ghostty's steady cursor default, so the embedder's blink default is applied again before replay. Option 14 replaces the whole 256-color table; `NULL` restores the built-in one and a program's per-index OSC 4 overrides survive.
- Grid tags are 1 for viewport and 2 for screen. `ghosttyKeyboardCodes` order is the `GhosttyKey` ABI value at the pin. Without layout data a shifted key reports unshifted codepoint 0, not the shifted character, which would corrupt Kitty alternate keys.
- Touch hosts (`handleTouchPointer: false`) own scroll and long-press gestures through `scrollLines`, `selectWordAt` and `extendSelectionTo`; the surface ignores touch pointers and the compatibility mouse events that follow them so a tap does not summon the soft keyboard.
- Every terminal frees its own handles on `dispose()`; the WebAssembly instance is shared and never torn down.

## Decisions

### Why composed text is a separate overlay and not the textarea

Showing the textarea itself would leave the underline to the engine: its color comes from the input method, so it can vanish on a dark terminal, and Android's resting space would show in front of the text. The textarea also holds parked copy selections and must stay out of sight for them. An element of its own draws the same text in the terminal's colors and leaves everything the textarea does for keyboards and the clipboard unchanged. The canvas was rejected too: rows repaint only when marked dirty and cursor cells are snapshot-driven, so painting uncommitted text there would add a second input to the render state.

### Why Android keeps a space in the textarea and not an empty field

Gboard deletes the characters it typed through the field (`deleteSurroundingText`), and in an empty field Chrome fires only a `keydown`/`keyup` pair with key code 229 and no edit. Once Gboard has nothing of its own left to delete, it sends a Backspace keydown whose `code` is empty, which the encoder cannot map. Both cases were measured on an Android 15 emulator with Gboard 14.2, Chrome 124 and Chromium 158. Reading an empty 229 pair as Backspace was rejected: Gboard sends the same empty pair before every Enter, so the last character of each command would be erased. With a space resting in the field, both cases become an ordinary deletion edit, which is authoritative. A keyboard that replaces several characters in one edit, such as tapping the suggestion "each" after typing "ech", removes only the space, so one character is deleted.

### Why deletion is read from `input` and not `beforeinput`

On the same emulator, Chromium 158 ignored `preventDefault` on the `beforeinput` of a keyboard's deletion: the field still lost its character and `input` followed. Sending a Backspace on `beforeinput` and cancelling it would therefore delete twice whenever the field holds text. `input` fires once per finished edit, whichever way the keyboard made it.

### Why shell shortcuts yield to alternate-screen and Kitty programs

OpenChamber applies Ghostty-style line editing and viewport bindings only at plain shell prompts to preserve application keyboard handling. Active screen and negotiated Kitty flags are authoritative; application cursor mode alone does not disable shell editing because shells can enable it too.

### Why Option symbols go through consumed modifiers and not the encoder's option-as-alt setting

The vendored artifact is built for `wasm32-freestanding`, and Ghostty's key encoder (`src/input/key_encode.zig`) reads `macos_option_as_alt` only under `comptime builtin.os.tag == .macos`. `GHOSTTY_KEY_ENCODER_OPT_MACOS_OPTION_AS_ALT` (option id 6 in `encoder.h`) is accepted and does nothing here: this encoder always treats Option as Alt and sends ESC before an Option character. What works is the consumed-modifier set: `KeyEvent.effectiveMods()` drops consumed bits when the event carries text, so passing the Alt bit (`1 << 2`) to `ghostty_key_event_set_consumed_mods` makes the encoder write the composed text without ESC. `ghosttyConsumedMods` (`keyCodes.ts`) decides per key which Option input counts as consumed (see Invariants). Meta for every other Option key is the deliberate default, the same the terminal had before Ghostty.

### Why Cmd+K remains unhandled

Ghostty's clear-screen binding needs an API the pinned `libghostty-vt` ABI does not expose. Cmd+K retains the app-shortcut path and has no terminal action; these bindings do not implement the full Ghostty keymap.

### Why Linux selection clipboard access is native

The canvas selection is not a DOM selection, and the web Clipboard API cannot write PRIMARY. Electron exposes `clipboard.selection` on Linux, so the local-page bridge is the only path that publishes the terminal's selection; remote pages, browsers, VS Code and mobile deliberately get no bridge. Copy stays on the regular clipboard path.

### Why the selection writer keeps only one pending write

A drag reports selection changes for every cell, and writing every value would queue text the user has already moved past. The viewport starts one write and replaces the pending text while it is in flight. A middle-click read waits for that write so it sees the selection the user just made. Copy does not wait for or flush this writer.

### Why the terminal times its middle-click suppression

Chromium emits a paste event after middle-click even when the surface handled the pointer event. The local bridge timestamps both clicks it turns into PRIMARY paste and plain clicks it sends to a mouse-reporting TUI, so the TUI's mouse event is not followed by clipboard text in the PTY. `pointerup` refreshes the timestamp because Chromium may paste on release. A keyboard shortcut and a pointer cancel clear the timestamp so it cannot swallow a later paste. A terminal without the bridge and Ctrl or Meta middle clicks keep the browser's native paste.

### Why the terminal refuses a proportional face

The grid places the cursor and selection on one cell advance. A proportional face draws its text narrower than its own cells and strands the cursor, so the probe refuses it and falls back to the default stack. An absent face or a probe that cannot run counts as monospace: the fallback chain decides what actually renders, not the probe.

### Why the grid anchors to the bottom once scrollback exists

While content is shorter than the viewport the grid sits at the top like a fresh terminal. Once scrollback exists the prompt lives on the bottom row, so the grid anchors to the bottom edge instead: the sub-row remainder moves above row 0 and resizing within a row boundary keeps the prompt pinned instead of snapping up and down. The origin changes only together with a full repaint, because a partial redraw at a shifted origin would composite rows over rows painted at the previous one.

### Why a wrapped link cut off by the viewport is refused

Only viewport rows are available in the snapshot, so a wrapped line whose head scrolled above the viewport would resolve a truncated match into a wrong link. A match whose tail continues below the viewport is not a complete URL yet. Both resolve to no link; the soft-wrap flag is authoritative and a missing row means the continuation is outside the viewport.

### Why copy goes through the hidden textarea and the native copy event

Canvas terminals have no DOM selection, and both the native copy event and Electron's Edit-menu `role: "copy"` read the focused textarea, so an empty IME field would write blankness. The surface parks the Ghostty selection there first and keeps the native event alive. A plain copy shortcut defers its `clipboard.writeText` fallback past the default action, so the native event claims the token first when it actually writes. The Shift chord has no native event because Chrome binds Ctrl+Shift+C to inspect, so it synthesizes one with `execCommand("copy")`.

### Why text runs do not split at selection boundaries

Selection only tints the background overlay. Splitting a text run at a selection edge visibly shifts glyph spacing whenever the face's true advance differs from the cell width, so selection is not part of the text-run style key.

### Why box-drawing joints extend to the crossing arm's far edge

A single-weight arm runs to the far edge of the thickest crossing arm's band, so corners and tees fill their junction square exactly, without a hole and without a stub past the perpendicular line. A double arm's two light lines stop at the matching line of a double perpendicular, at the center of a single one, or cross to the far line to close a corner or run straight through. Whole-pixel snapping keeps neighbouring cells' shared edges on the same value, and an odd stroke sits on pixel centers so an arc continues a straight band without a half-pixel step. Block-element edges snap independently so stacked bars still tile.

### Why the default cursor blinks

Ghostty's built-in default is steady, while the xterm.js renderer this replaced blinked. Option 23 sets the embedder's default blink, which is the state a session starts in and returns to on DECSCUSR reset (`CSI 0 q`), so programs that request a specific cursor through DECSCUSR or DEC mode 12 still win.

### Why the PTY trampoline is registered with grow-then-set and not `grow(1, fn)`

WebKit stores a grow init value with broken type information, and every later `call_indirect` through that entry traps with a signature mismatch. Growing the table and then calling `table.set` canonicalizes the entry. The trampoline is a second module because the pinned ABI exposes no way to pass a JavaScript callback; embedding its 121 bytes avoids a second network fetch and the CSP question a `data:` URL raises.

## Updating libghostty-vt

1. Put the new upstream commit hash in `vendor/VERSION`.
2. Run `bun run --cwd packages/ui build:ghostty-wasm`. It downloads Zig 0.15.2 into `~/.cache/openchamber-ghostty`, clones Ghostty at the pin, builds `wasm32-freestanding`, replaces `vendor/ghostty-vt.wasm`, and prints the trampoline bytes for `runtime.ts` (they only change when the Zig source changes).
3. Reconcile the ABI numbers in `core.ts` (`RENDER_DATA`, `ROW_DATA`, `CELL_DATA`, `SELECTION_FORMAT_OPTIONS_SIZE`, option ids in `setTheme`, `ghostty_terminal_get` ids) and `keyCodes.ts` against the headers of the new revision.
4. `runtime.test.ts` fails when the artifact's embedded build metadata disagrees with `VERSION`.

On macOS 27 with Xcode 26+ SDKs the script works around a Zig 0.15.2 limitation: the SDK's `libSystem.tbd` lists only `arm64e-macos`, so the script builds a patched SDK root and shims `xcrun` for the duration of the build.

## Verification

```sh
bun test packages/ui/src/lib/ghostty packages/ui/src/components/terminal
bun run --cwd packages/ui type-check
```

The `core` and `runtime` tests run the real WebAssembly under bun; they cover reflow, palette, replay isolation and recycled-row cleanliness.
