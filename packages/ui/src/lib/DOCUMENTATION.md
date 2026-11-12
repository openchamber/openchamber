# Library modules

## Hosted surface selection

### Ownership

`runtimeSurface.ts` owns the choice between the mobile and desktop app shells in a hosted browser. It stamps the answer on `window` at boot, and every `isMobileSurfaceRuntime()` caller reads that answer. Capacitor, Electron and VS Code have fixed surfaces and skip the heuristic. The live tablet layout inside the mobile shell belongs to `useTabletLayout` in `device.ts`.

### Invariants

- An explicit stamp or `?surface=` override wins over the heuristic, and an override stops the resize watcher.
- Rotating a phone never changes its surface, so it never reloads the document.
- Tablets and fine-pointer touch desktops follow the viewport width: a coarse-pointer tablet is mobile up to 768 CSS px wide, so rotating it can still reload into the other shell.

### Decisions

#### Why a phone is recognized by the screen's short side and not by the viewport width

A rotated phone's viewport and `screen.width` both report the long side, so a width check flips during rotation and the resize watcher reloads into the desktop shell. The short side stays the same in both orientations.

#### Why the short-side rule stops at 600 CSS px and not at 768

768 would move small tablets to the mobile shell in landscape, where they get the desktop shell today. 600 is the line `useTabletLayout` already uses for tablets, so one constant decides both.

#### Why the short-side rule reads only `(pointer: coarse)` and not the wider touch check

`hover: none` and touch points also match touch laptops driven by a mouse. On those the short side would keep the mobile shell at full width, so they stay on the viewport width rule.

## Chat width

### Ownership

`chatWidth.ts` owns the five width levels (`compact`, `standard`, `wide`, `full-width`, `full`), their column values, and the document-root application. `App.tsx`, `apps/MobileApp.tsx`, `apps/VSCodeApp.tsx` and `apps/ElectronMiniChatApp.tsx` call `applyChatWidth` for their shell. `styles/typography.css` reads the two root properties it writes for `.chat-column`, `.chat-input-column` and `.chat-message-column`. The settings registry parses the stored level (`lib/settings/registry.ts`) and the server sanitizes it (`packages/web/server/lib/opencode/settings-helpers.js`).

### Invariants

- One mechanism carries the width: the root properties `--chat-column-width` and `--chat-message-column-width`. CSS must not restate a level's width in a class rule.
- `applyChatWidth` validates the level it is given and falls back to `compact`: a store written by a build with more levels can carry one this build does not define after a downgrade, and hydration skips the migrate hook.
- `components/chat/MessageList.tsx` estimates unmeasured rows from `readChatMessageColumnWidthPx`, which resolves `--chat-message-column-width` the same way the stylesheet does (`rem` against the root font size, `100%` as the window width, the compact column when unset or unparseable). Its root observer refreshes the cached estimate when the property changes, because the scroller's own box does not resize with it.
- The same estimate subtracts `readChatColumnPaddingPx`, which mirrors the stylesheet's `clamp()` padding rules, the 1024px switch between them, the root font size and `--padding-scale`. A fixed 48/32px subtraction would drift with the interface font size and the padding scale.
- A saved `wideChatLayoutEnabled` switch reads as `full-width` and a saved `false` as `compact`, so a settings file from an older build keeps the user's choice.

### Decisions

#### Why wide moves both columns and full-width keeps the old switch layout

`wide` widens the transcript and the composer together to 80rem, so the composer never sits narrower than the messages. `full-width` is the layout the old wide-layout switch produced: the transcript fills the chat width while the composer and docked rows stay on the chosen column, kept as its own level so nobody's layout changes on upgrade. `full` fills the chat area with both.
