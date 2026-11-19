# Shared Markdown rendering

## Ownership

This module owns shared Markdown parsing, sanitization, presentation, code highlighting, media lifetimes, selection copy and document windowing. Runtime adapters own filesystem access and authorization. Reply execution and SVG preview contracts appear in their sections below.

## Invariants

- File-reference caches shared across renderers contain lexical matches only. Resolution, existence checks and code-path annotations remain bound to the active runtime and directory; plugin lookups are synchronous and start no filesystem work. Pending confirmations coalesce, but negative results expire through the confirmation layer so newly created files can resolve.
- Mobile file taps retain text selection and native inline-code sizing. Adding `role="button"` makes code unselectable and applies the 36px mobile control height; surrounding links, buttons and disclosures retain their own clicks.
- A delayed mobile file confirmation checks that the session and directory still match before opening the Files drawer. Ambiguous matches remain distinct from missing files. The drawer opens on Files so the staged file is visible.
- Automatic file probes exclude emails, handles and digit-leading suffixes. Click classification stays broader so file-looking links cannot fall through to `target="_blank"`. An `@` with a slash can identify a scoped package path.
- File links that reach system reveal use the Files tree's runtime restrictions. Browsers and VS Code have no matching system-file-manager action.
- Scheme parsing avoids constructing a URL for ordinary highlighted identifiers and paths. Malformed href escapes retain their literal spelling.
- Unsafe or unsupported links remain inert after policy filtering. VS Code does not resolve web-session links against its separate session backend.
- App-owned tracker, repository and commit routes take priority over extension claims. Click-time registry reads preserve that priority without subscribing every rendered link to registry changes.
- Extension identifiers have no browser destination and copy as plain text. If the extension disappears they become text again; an unavailable phone panel or project leaves an ordinary URL usable and gives an identifier an explanatory toast. Installing a linked extension folder still requires capability approval. Reference parsing leaves authored inline anchors and code alone because inserting links there can nest anchors.
- Author-provided HTML cannot supply application navigation metadata or arbitrary utility classes. Only approved language classes survive on code; surviving inputs are disabled checkboxes. Validated generated links can restore their application URL after hardening changes custom schemes.
- Media `src` values remain HTTP(S) or relative addresses. Local files use validated source metadata, and only the upload route produced by `projectUploads.ts` receives client credentials on the relay.
- Direction annotation runs after sanitization removes authored `dir`. Each prose block uses its own words, excluding code and independently resolved nested containers; adjacent raw HTML blocks contribute word boundaries. Uniform lists inherit their items' direction for markers and gutters, while mixed lists retain the surrounding direction.
- Math recognition preserves CommonMark code and link destinations. Bracket math occupies its own container-relative line so escaped bracket prose stays prose. Single-dollar candidates stop at actual link boundaries before parsing consumes link punctuation; interval brackets and comparisons remain valid math, and URL labels remain readable URLs.
- Disclosure scanning identifies boundaries and reparses the summary and body with the same CommonMark parser, including nested disclosures and container-relative quote markers. Heading tags inside summaries become heading nodes without their attributes so titles render with raw HTML enabled or disabled.
- Static rendering drops only invisible top-level blocks and preserves inline joiners. Offline export shares the on-screen parser, policy and components, and awaits diagram loading before synchronous rendering.
- Highlights import failure leaves code plain for that runtime because the import compiles WebAssembly requiring SIMD. ANSI display strips escapes and uses plain-text lexing because ANSI tokens merge text and invalidate source offsets; copying retains the original fence source.
- Highlight colors use Markdown CSS variables, so cached results remain valid across theme changes. Syntax-variable resolution stays independent of highlighter registration so eager consumers do not load a renderer or diff stack.
- Highlight-cache keys include result kind and language and use content length plus 2 independent 32-bit hashes. Fingerprints avoid duplicating large sources as keys; a single 32-bit hash risks returning another source's rendered HTML at realistic cache sizes.
- Highlight-cache byte estimates are recorded once at insertion, with UTF-16 string estimates avoiding encoder allocations. Reads and eviction never rescan payloads, and a single oversized entry remains cacheable after other entries are evicted.
- Unchanged streaming code rows retain identity so React can skip them. An edit or context change creates a new lineage whose results cannot reuse abandoned-lineage output, even if the source later returns to an older value; exact plain-result hits still honor export and line-budget policy.
- Highlight style objects share identity by color and font style. Whitespace can merge into the following token to reduce spans, but inherits only foreground color so backgrounds and decorations do not expand into it. Superseded streaming results retain only a small recent set.
- Mermaid geometry survives row remounts and fullscreen previews in the shared 100-entry cache. CSS palette variables let the same geometry serve every screen theme. Unrelated toolbar or context changes leave the viewer-mutated SVG subtree intact.
- Mermaid exports resolve only known palette references against the original uncropped geometry. Serializing the panned DOM would export the user's viewport and unresolved theme colors.
- Mermaid fitting reads all sizes before writing any viewBox and waits for its 2-frame settle. Content bounds never come from the user-controlled viewBox. Hidden or zero-size containers retry on resize before revealing fitted content; unrecognized bounds leave the native SVG visible.
- Mermaid primary-pointer starts clear stale gesture state after a lost pointerup. A finger remaining after a pinch cannot pan until a new gesture, preventing a jump. Hiding toolbar buttons leaves drag, pinch and modified-wheel zoom enabled.
- Mermaid controls occupy their own row or the surrounding surface's header, so appearing controls neither cover the diagram nor move it.
- Document media proximity uses a vertically overflowing ancestor. A horizontally scrolling table can compute `overflow-y: auto` without being a vertical viewport and must not make every contained image appear near. A picture is observed for its box because its sources have none.
- Document media retains its placeholder box until an address arrives so alt text does not replace its layout. Source media queries gate reads, including theme-specific picture sources; data URLs already contain their bytes and need no second viewer read.
- Only assistant message parts participate in the message gallery and equal-height image rows. Tool output, reasoning and user text retain plain media behavior; bare clip URLs become players on document surfaces.
- Image grants are issued and consumed on the server that owns the directory. A runtime switch aborts a pending save because the same path can name another file on another server. Grant preparation includes the render call identity so the server applies the page's weight budget.
- Opaque-origin rendered pages receive validated image bytes as data URLs because passing an authenticated asset URL would expose its auth token to page scripts. VS Code uses its workspace-only filesystem bridge with the same size and signature validation because it has no message-scoped temporary-file grant route.
- Message parts share gallery entries only while their React-owned image is mounted and loaded; entries retain no resolved URLs. Dropped tunnel reads are retried on the next open, and remote images are not fetched for viewer saves.
- Media ownership includes the runtime and settled assistant text even when paths and IDs match. Color-scheme or callback changes preserve loaded assets; streaming text, tool output, reasoning and documents do not recreate ownership on every text update. Hidden providers reconcile missed endpoint events, including same-key renewal, and connect before child passive effects resolve sources.
- Media nodes register in effects before viewport callbacks or microtasks request a batch, so embedded images share the same cap. Tool and reasoning local mode keeps its direct local-source policy; only assistant media uses message grants or the workspace bridge.
- Selection serialization reads semantic source metadata before removing chrome. KaTeX contributes its TeX annotation once, file references remain plain paths, and images use authored source addresses; authenticated loaded URLs never enter copied Markdown. Layout-only word joiners are omitted.
- Selection copy preserves formatting for reading and prompt reuse without promising byte-for-byte round trips. Plain copy emits visible labels and tab-separated table rows while retaining TeX. Native code-row newline placeholders contribute exactly one empty line, and emphasis markers hug their text.
- Rich clipboard HTML removes loaded media URLs and source-set metadata while retaining labels, so pasting cannot initiate image or video requests. Media controls and link-preview wrappers must not retain application actions in the copied document.
- A cross-block selection restores missing ancestor shells because `cloneContents` omits them; a selection within one text block copies the text without enclosing list or table markers. Code-only selections retain row and language shells but stop at the code card. Partially cloned code shells cannot copy the full source; only the boundary ancestor chains need coverage checks, while contained middle subtrees retain metadata.
- Cross-row copy combines Markdown roots only when both selection ends belong to the same answer, in transcript order.
- Windowed document placeholders preserve measured height and collapsing edge margins so unmounting keeps scroll positions stable. Resize observation handles movement from surrounding content without scrolling; a hidden scroller preserves its current mounted set until geometry returns.
- Whole-document readers such as find and heading navigation hold all blocks mounted. Selections retain their ends and mount every block when they cross placeholders, otherwise copying would read empty boxes. Detaching releases selection holds because the collapse event will no longer be observed; synchronous holds run only from event handlers and are effective only after the window attaches.
- User-toggled disclosures and playing media stay mounted to preserve state and playback position. Summary clicks identify user changes because `toggle` also fires when an open disclosure is inserted.
- Tables measure only after streaming settles to avoid a forced layout on every update. Capped-column flags and their shared map change only with content or cap status, since rebuilding the map during resize rerenders every cell. Table copies preserve already escaped links without escaping them again.
- Header measurement preserves rendered cell styles and the longest unbroken word. Short columns keep natural width; once horizontal scrolling is required, squeezing long text to the minimum only makes cells taller.
- Diff parsing loads only for settled, bounded patches. Headerless model snippets receive parser-only coordinates; copy retains the original source. Suggestion fences use review context and its excerpt, show additions when no excerpt exists, and stay ordinary code outside a review comment; an empty hunk side names the preceding line.

## Decisions

### Why renderer identity stays fixed for a mount

A renderer uses the already loaded implementation synchronously when available,
avoiding Suspense's delayed reveal even for a resolved import. That choice stays
fixed for its mount because replacing a lazy component with the loaded component
would remount content and reload media.

### Why a live part keeps its block tree after settlement

Settlement preserves the streaming part's mounted blocks and their media. Already
completed history uses whole-document static rendering; windowed documents use
block splitting unless footnotes or link definitions require the whole source.

### Why block arrival reads a stable ref and not changing context

Arrival metadata is captured when each block mounts, so updating the stream does
not rerender every existing block. Initial blocks never reveal as new content;
later commits retain their reveal decision across settlement, with bounded
staggering when several blocks arrive together.

### Why static Markdown bypasses the block splitter

Static rendering consumes the complete document. Bypassing Streamdown's unused
split avoids running a full-text lexer whose result static rendering discards.

### Why parser switches and not source escaping for literal text

Disabling HTML and character references in the parser preserves typed characters in prose, code and formulas. Escaping the source makes entities appear literally in code and can break formulas.

### Why lazy renderers and not eager Markdown imports

Mermaid brings ELK and about 1.6 MB of script, so the first diagram loads it while the source remains visible; a later diagram retries a failed load. UI blocks load on first use with a code fallback, and command blocks load their session-sync dependency only when needed.

### Why synchronous highlighting and not a later paint

Highlights runs on the main thread so synchronous consumers can paint highlighted code in the first frame. The recorded cost is about 1 ms per 100 KB, and content-addressed caches prevent repeated tokenization of unchanged sources.

### Why heading-based table identity and not an order number

Persisted table widths use headings for identity because inserting a preceding table changes ordinal positions.

### Why document windowing and not mounting the whole document

A full 340 KB document costs 470 ms to open in the recorded measurement. Windowing limits the nodes laid out and serialized for accessibility during panel resize while the first 24 blocks can paint before viewport attachment.

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
- Run controls require a finished reply on a surface with controls because a streaming command could execute an incomplete source.

## Decisions

### Why a note in the transcript and not matching by command text

`session.shell` takes no metadata, and a typed `!ls` after a reply that suggested `ls` would look the same as a click, so it would lose its row and wake the agent. A note costs one line of context and is what OpenCode stores.

### Why the client continues the agent and not the server

The VS Code extension has no OpenChamber server, and a server runtime would need its own persistence and delivery loop (`dispatch-results`) for what the event stream and the block already cover. Nothing continues the agent while no client is open; the block does it when the session is next opened.

### Why the output is drawn like a shell tool row

The tool row is the one place that already turns terminal bytes into text (`renderTerminalOutput`: colour codes, `\r` progress lines) and highlights a settled output as `bash`, so a block and a row read the same. While the command runs the block stays plain, because each poll would highlight again. The highlighter's code background stays transparent because the surrounding block already supplies the surface.

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
