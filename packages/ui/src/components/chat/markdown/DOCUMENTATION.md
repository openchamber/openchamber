# Markdown file references

## Ownership

The shared renderer classifies and confirms local references before opening them through the active runtime's file viewer or editor. Filesystem access and authorization remain with the runtime adapters.

## Invariants

- Ordinary link hrefs are percent-decoded once. Inline code, fenced code, and path-looking link labels remain literal paths.
- Reference suffixes are parsed before ordinary href paths are decoded. Encoded filename characters do not become line references or anchors.
- Confirmation and clicks use the same input kind. Confirmation results distinguish hrefs from literal paths and retain directory/runtime scope.
- Existing file-URL handling, file classification, and final-path containment checks remain in place.
- Ordinary local hrefs bypass prose-only filename filters. External schemes and protocol-relative URLs are rejected before decoding.
- An identifier an extension claims (`remarkGuestLinks`) is a link with no href and `data-oc-guest-link`, which only that parser sets (`rehypeMarkdownPolicy` drops it from authored HTML). `MarkdownLink` draws it before any file, anchor or browser branch, so it never reaches file-reference classification; a claimed https link is checked against the app's own link readers at click (`guestLinkClick.ts`). The contract is in `packages/sdk/DOCUMENTATION.md`, *Links in messages*.
- Encoded edge spaces remain part of the filename during resolution, existence checks, and file-tab navigation.
- A drag that starts on an inline-code or fenced-code file reference selects text as it does in surrounding prose, and the click at the end of that drag opens nothing (`activateMarkdownFile`). The code reference gives up its tab stop for the press (`releaseFileReferenceTabStop`), because Chromium moves focus to a tab stop on mousedown and a drag from a focused element never becomes a selection. A file reference drawn as a link keeps the browser's link behavior: a drag from it starts a link drag.

## Decisions

### Why the phone checks inline code on tap and not ahead of time

The phone makes no file requests before the user acts, so path-looking inline code cannot show that it is a file. A tap asks once and either opens the file or shows a toast. The answer skips the stat cache: a cached miss would keep saying "not found" after the file appears, and the cache records a failed request as a miss.

### Why explicit href input and not decoding every reference

The same resolver receives URLs and native path text. Explicit input kinds preserve a native filename such as `50%25off.md` while resolving the href `50%25off.md` to `50%off.md`.

### Why suffix parsing precedes ordinary href decoding

A literal `#L12` suffix denotes a line reference, while `%23L12` can belong to a filename. Decoding first loses that distinction and can select the wrong file.

### Why explicit local hrefs bypass prose filters

A link target can contain repeated spaces, angle brackets, or encoded `://` in its local path. Prose filters would reject these filenames and let the browser open a new tab. Scheme checks run on the encoded target so external URLs remain external.

### Why decoded href paths preserve whitespace

Text references are trimmed as prose, but an href's encoded edge spaces identify a different file. Href resolution opts out of trimming, and stat checks and absolute file-tab targets retain those spaces.

### Why a code file reference drops its tab stop while the pointer is down

The code reference keeps `role="button"` and Enter/Space activation, but Chromium focuses any tab stop on mousedown before it decides whether the gesture is a drag. A drag that starts inside the now-focused reference never becomes a text selection, so the release reads as a plain click and opens the file. Removing `tabindex` for the press and restoring it on the next task leaves keyboard access intact while the browser starts the selection as it would in ordinary prose. A reference drawn as a link keeps its `href`: the browser owns a link drag from it, and disarming the link for the press would take that away.

# Commands run from a reply

## Ownership

A `bash`, `sh`, `shell` or `zsh` fence in a finished assistant reply has a run button (`MarkdownCode`, and `ReplyCommand.tsx` loaded with the first such block, so the session sync stays out of the Markdown renderer). `@/lib/opencode/reply-command` owns the messages a run adds to the transcript and how to read them back; `@/sync/reply-commands` starts a run and watches it. OpenCode runs the command through `session.shell`, the route of `!command`, in the session's own directory and shell.

## Invariants

- A run takes three synthetic messages around OpenCode's shell message, all hidden from the timeline: the note (`openchamberReplyCommand`), OpenCode's completion, and the continuation with `resume: true`. The note carries the reply, the command and both client-minted ids.
- The note is the only link from a block to its run. A block finds its run in the transcript, so its output and status survive a reload and show in every client.
- The agent is continued once per run. The continuation id is fixed at the click, so a second client is refused as a repeat.
- A continuation goes out only after OpenCode's completion message, so the output is in context first. A command the user stopped gets none.
- A run started here is watched from the event stream, because its block can scroll away or its session can close. After a reload the block continues any run still owed one.
- The block shows the run instead of the shell row. A run whose reply is outside the loaded history keeps its row (`dropReplyCommandRows`).

## Decisions

### Why a note in the transcript and not matching by command text

`session.shell` takes no metadata, and a typed `!ls` after a reply that suggested `ls` would look the same as a click, so it would lose its row and wake the agent. A note costs one line of context and is what OpenCode stores.

### Why the client continues the agent and not the server

The VS Code extension has no OpenChamber server, and a server runtime would need its own persistence and delivery loop (`dispatch-results`) for what the event stream and the block already cover. Nothing continues the agent while no client is open; the block does it when the session is next opened.

### Why the output is drawn like a shell tool row

The tool row is the one place that already turns terminal bytes into text (`renderTerminalOutput`: colour codes, `\r` progress lines) and highlights a settled output as `bash`, so a block and a row read the same. While the command runs the block stays plain, because each poll would highlight again.

### Why the output of a stopped command comes from the live view

OpenCode drops the output when the shell is removed and records "output is no longer available". The block keeps what it had read, and after a reload shows the status alone.

# SVG fences in document previews

## Ownership

An `svg` fence in the Files Markdown preview draws as an image (`MarkdownSvg`). The preview opts in with `svgFences`; chat, tool output and copies keep the fence as code.

## Invariants

- The source is loaded only as `<img src="data:image/svg+xml;…">`. It is never inserted as markup, so its scripts, event handlers and external loads do not run. `svg` stays in the strip list of `streamdownPlugins.ts`, so inline `<svg>` in Markdown is still dropped.
- Source with a `<script` or an inline `on…=` handler stays an ordinary code block (`MarkdownCode` decides before `MarkdownSvg` mounts). The image load is what keeps scripts from running; the check only lets the reader see what the file carries, so a miss costs nothing.
- The image sits on a white surface (`bg-white`, as the pairing QR does). An SVG is drawn for a light page and an image does not see the app theme, so black strokes on a transparent background would vanish in dark themes. A `prefers-color-scheme` rule inside the file is not relied on: Safari ignores it for images.
- Source the browser cannot draw (the image `error` event) goes back to the ordinary code block, with its header and Copy: `MarkdownSvg` reports the failure through `MarkdownSvgFailureContext` (`MarkdownPresentationContext.tsx`), and `MarkdownCode` keeps the failed source so it does not mount the image again. A changed source is tried again.
- The figure sits in a `data-streamdown="svg-block"` wrapper that carries `data-oc-svg-source`. Selection copy (`selectionMarkdown.ts`) rebuilds the `svg` fence from it, as it does for mermaid, so a copy never pastes the data URL.

## Decisions

### Why an image and not inline markup

Inline markup needs a sanitizer, and the app has none for SVG: `rehype-sanitize` strips `svg`, and a hand-written allowlist would be code to keep current against new attack forms. An image load gives the same picture for the case asked for (a static diagram) with no sanitizer, at the cost that the figure does not inherit page fonts or `currentColor`.
