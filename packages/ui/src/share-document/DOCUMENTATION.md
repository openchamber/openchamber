# Shared page renderer

## Ownership

A page an agent shares with other people (`openchamber_render` with `share`) leaves the app as one self-contained HTML document. This module owns the part of that document a `ui` page needs: the UI block renderer built as a standalone script (`entry.tsx`, emitted as `share-document.js`), the document around it (`page.ts`), and the page's side of the frame protocol with the relay's viewer (`protocol.ts`). The chat's card builds and uploads the document (`components/chat/sharePages`); the server only encrypts and uploads what the chat posts (`packages/web/server/lib/share-pages`); the viewer that shows it is `apps/relay/src/share/viewer.ts` in the website repository.

## Invariants

- The document needs nothing from the network. The viewer runs it in a `sandbox="allow-scripts allow-forms"` srcdoc frame under a policy that allows inline scripts and styles, `data:`/`blob:` images and fonts, and no connections, form submissions or navigation. Everything the page draws, the app's stylesheet included, is inside the script.
- The page answers only through the viewer: `{ source: "openchamber-share-document", type: "submit", data, summary }` to its parent, settled by `{ source: "openchamber-share-viewer", type: "submit-result", ok, error }`. One answer is on its way at a time and none after one went through. The recipient's app (`components/chat/sharePages/received/`) plays the viewer too, and shows a page again after its answer: its `init` carries that `answer`, the `ui` page freezes on it and neither kind takes another. The relay's viewer never sends it. An `html` page gets the same protocol from the string script in `components/chat/sharePages/shareDocument.ts`; change both with the viewer.
- The page wears OpenChamber's default light and dark themes, picked by the reader's system, never the author's own theme.
- Text comes in the reader's language: the browser's first, then the one the viewer's `init` names. The page carries only the strings its components name (`messages.generated.ts`); after changing strings the bundled components show, run `bun run --cwd packages/ui share-document:generate` (`messages.test.ts` fails while the copy is stale).
- The bundle is built from the app's own source with the modules in `shims.ts` replaced. A new import in the UI block renderer's subtree lands in every shared page: an app store, the runtime or a large table needs a shim, or the bundle grows and may touch storage the opaque origin forbids at load.
- Every config that builds the app for web, desktop and mobile emits the script: the web build (`packages/web/vite-share-document.ts`), which the desktop app serves and the Capacitor app copies. The dev server builds it on the first request and after a source change.

## Decisions

### Why the chat builds the document and not the server

The renderer and the `html` page bootstrap live in `packages/ui`, and the links and PINs are useless without the card anyway. The server would need a second copy of the UI block renderer, which it cannot carry: `@openuidev/lang-core` stays out of the server's package (`components/chat/uiBlocks/DOCUMENTATION.md`).

### Why the real renderer and not a page drawn from the program at build time

A shared form has to behave like the one in the chat: the note and Send the chat adds, Tabs stepping with Next, date and slider fields, the same validation. Drawing static HTML from the program would mean a second renderer and a second form logic. The cost is size: a `ui` page is about 2 MB, most of it React, the app's stylesheet and the icon sprite, which is far below the relay's 32 MB limit.

### Why shims and not a renderer free of app hooks

The renderer reads the theme, the language, the calendar settings and the project through the app's hooks, like every other chat component. Replacing those few modules in the bundle keeps the renderer one component for both places; threading the values through props would change every block component for a document most users never send.

### Why the string table is generated

The app loads one locale's dictionary at a time, megabytes each; a page has no store to load them into and should carry only what it shows. The keys are read off the source the bundle is built from, so the table follows the renderer without a hand-kept list.
