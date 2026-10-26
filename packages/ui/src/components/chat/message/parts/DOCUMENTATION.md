# Chat Message Parts: Rendering Architecture

This folder contains renderers for chat message parts (text, tools, reasoning, placeholders) and shared tool presentation helpers.

Use this doc when you ask an agent to change tool/header/description behavior.

## High-level flow

- Message parts are rendered from `MessageBody.tsx`.
- There are two tool rendering paths:
  - **Static tools** -> `StaticToolRow` in `ProgressiveGroup.tsx`
  - **Expandable tools** -> `ToolPart.tsx`
- Shared tool icon mapping is centralized in `toolPresentation.tsx` (`getToolIcon`).

## Which file controls what

- `ProgressiveGroup.tsx`
  - Contains `StaticToolRow`, the compact one-line row of a navigation tool.
    The file keeps the name of the grouped Activity block it used to hold.
  - Contains static tool short description logic (`getToolShortDescription`).
  - If you want to change how `read/grep/perplexity/webfetch/...` look in compact mode, edit here.

- `ToolPart.tsx`
  - Renders expandable tool rows (shell/edit/write/question/subagent + fallback).
  - Controls expandable header title/description/diff stats/timer and expanded output body.
  - If you want to change expandable tool layout, edit here.
  - A subagent call is an ordinary tool row, rendered through `SubagentToolPartContent`: shine and a live duration while it runs, the final duration (red on failure) once settled, and an open action that shows the child session. Expanded, it shows the prompt and the result. The row never reads the child session's messages; the child's own chat is where its work is shown.
  - While the child runs, foreground or background, the row has a stop action. OpenCode 2.0.23 has no route that cancels a subagent job; interrupting the child ends the job as cancelled, which the agent reads as a failed subagent and tends to restart. `opencodeClient.stopSubagent` therefore first admits a non-resuming synthetic note (`subagentCancellationNote` in `@/lib/opencode/subagent-run`) that explains the cancellation as the user's stop without forbidding the work, and interrupts the child only once the note is in. A foreground call the note names reads `stopped` instead of failed (`toStoppedSubagentPart`). Drop the note once OpenCode reports a user cancel itself.

- `taskToolModel.ts`
  - Owns subagent output preparation and child identity parsing. `ToolPart.tsx` resolves the call's child identity.
  - A subagent's `state.metadata.sessionID` is the preferred child identity from progress/result updates. Legacy part metadata and output IDs remain readable, then a non-empty `state.input.sessionID` identifies a resumed child when those IDs are absent.
  - If none of those sources names a child, a running call may infer one from child sessions created at or after the call start. Candidates must belong to the parent, match the requested agent when the session has one, and remain unclaimed by sibling calls. A unique candidate is accepted; when several remain, the call description must uniquely match the child title. Ambiguous calls stay unlinked. Inference never pairs children by sibling order or status.

- `toolPresentation.tsx`
  - Shared icon mapping for tool names (`getToolIcon`).
  - Used by `ProgressiveGroup.tsx`, `ToolPart.tsx`, and `ToolOutputDialog.tsx`.
  - Takes an optional extension rule (below) whose `icon` wins when the sprite carries it.

- Tool names, per-tool input/metadata fields, and the row description are owned by `@/lib/opencode/tools`. Branch on its predicates (`isShellTool`, `isSubagentTool`, `isFileChangeTool`, ...) instead of comparing tool names here; v2 has no `state.title`, so a row's description comes from `toolDescription(tool, input, metadata)`. Every v2 built-in answers from its own input before its result lands: `patch` from the `*** Update File:` headers of its text until `metadata.files` arrives, `skill` from its `id`, and the `opencode.*` namespace tools (`session_rename`, `session_move`, `models`) from their title, directory or search; `getToolMetadata` resolves a namespaced name by its last segment.

- Extension tool presentations (`contributes.tools` in a guest manifest)
  - The registry is `lib/guests/tool-presentation.ts`: `useGuestToolPresentation(part.tool)` / `resolveGuestToolPresentation` return the first matching rule of an active guest (exact `match` beats a suffix wildcard; first extension wins) or `null`. Rules are compiled once per catalog array; each part does one linear scan.
  - The lookup always gets the **full** tool name OpenCode reported (`mcp.jira.search`); `normalizeToolName` still feeds every built-in switch, so built-in behavior is untouched when there is no rule.
  - Hook points, each falling back to today's code when the rule is `null` or silent on that field: icon (`getToolIcon`), header title (`title` template, else `name`, else `getToolMetadata`), header subtitle (`subtitle` template replaces both the description and the justification text), and the expanded body (`output`: `text` / `code` / `json` / `markdown` / `table`, checked at the top of `renderResultContent` and inside `ToolScrollableTextOutput`; `auto` keeps detection). A `table` whose output is not an array or `{ items: [] }` falls through to detection.
  - `GuestToolTable.tsx` draws a tool-output table with bounded, wrapping cells, capped at 200 rows with a count line.
  - VS Code and mobile mark the guest catalog unsupported, so the registry is empty and nothing changes there.

- `toolRenderUtils.ts`
  - Core classification helpers:
    - `isExpandableTool`
    - `isStaticTool`
    - `isStandaloneTool`
    - `getStaticGroupToolName`
  - If a tool should switch between static vs expandable, change it here.

- `ReasoningPart.tsx`
  - Thinking block UI (`ReasoningTimelineBlock`), summary + optional duration.

- `components/LiveTurnActivity.tsx` (relative to the chat folder)
  - Owns the optional turn disclosure. `MessageList` enables it when Activity
    Default is Collapsed and the turn has visible Activity content.
  - `components/LiveActivityCollapse.tsx` owns the finite height transition;
    `components/liveActivityContext.ts` scopes the final message's non-text
    disclosure without changing message context or tool rendering.
  - `lib/turns/liveActivity.ts` owns final-answer and interruption boundaries.
  - `lib/turns/liveActivitySummary.ts` derives the report from tool results.

- `ShownToolCard.tsx`
  - What a call drawn in place of its row shows (`isShownInPlace` in `@/lib/opencode/tools`): the run a completed `workflow.run` call proposed (`proposedWorkflowRunId`, read from the call's result envelope), else the page of an `openchamber_render` call. Both ask something of the user, so both are hoisted to the answer with the turn's pages when Activity is collapsed.
  - The workflow card (`components/chat/workflows/WorkflowRunCard.tsx`) reads the run from the server's store, not from the call: the plan with its phases, the run's state, and Run and Don't run while it waits for approval, Stop while it runs, Resume after a failure or stop. The card is current after a reload and on every device; a run the server no longer has says so.
  - The run's report arrives later as a synthetic message (`lib/workflows/report.ts`) and renders as one collapsed line in `TimelineNotice`, like a dispatched session's result, opening a turn of its own.

- `HtmlRenderFrame.tsx` and `htmlRender.ts`
  - A completed `openchamber_render` call that OpenChamber accepted (`renderedPage` in `@/lib/opencode/tools`: `metadata.openchamber.ok` and an `html` input) is drawn as the page itself in place of its tool row. A refused call keeps its ordinary row, and so does a running one, except a page that waits for the user's answer (`awaitAnswer`): its call runs until the user answers, so it is drawn while it runs, and it stays with a "Not answered" line when the call ends in an error (the user stopped the turn).
  - The page loads through `srcdoc` in a frame sandboxed with `allow-scripts allow-forms` and never `allow-same-origin`, so its script runs in an opaque origin with no reach into the app. `buildHtmlRenderDocument` puts a bootstrap first in the page's head: the theme as CSS variables (`htmlRenderTheme`; the agent tool's description in `packages/web/server/lib/agent-tool/runtime.js` lists the same names; `--chart-1` is the theme's accent and `--chart-2` to `--chart-6` a fixed set per light and dark, `CHART_SERIES`, because the theme's syntax colors made near-identical series), a size report, and http(s) link clicks handed to the host, which opens them with `openExternalUrl`. A theme switch is posted to the page instead of rebuilding it, so the page keeps its script state. Messages are accepted only from the frame's own window. A focused frame keeps every key from the app, so the bootstrap passes on a Cmd/Ctrl chord the page left alone (not typed into its own fields, not handled by its script, not the clipboard, select-all or undo chords), and the host replays it as a keydown and keyup on the frame element. The app's shortcut handling then runs as for any key pressed outside a text field, with no list of shortcuts to keep in sync. A chord without Cmd or Ctrl is never replayed. A wheel up or vertical swipe over the page scrolls the chat around the frame while its events stay in the frame, so the bootstrap reports each one its script and its own scrolling boxes left alone (a direction only), and the host raises it on the frame element for the chat's follow (`lib/scroll/DOCUMENTATION.md`); without it a streaming reply kept pulling a reader who scrolled over a page back to the end. Pages are interactive within themselves (tooltips, tabs, sorting).
  - A page that waits for an answer sends it with `openchamber.submit(data, summary)`, which the bootstrap posts as an MCP Apps `ui/message` request (the summary as text content, the data in `_meta["openchamber/data"]`); the host replies with a JSON-RPC result or error that settles the page's promise. The host accepts it only while the page waits and only during a user gesture: a click inside the frame activates the chat window too (`navigator.userActivation`, checked in Chromium and WebKit), and a page that sends on its own does not, even if it skips the bootstrap. The answer goes to the server through `answerRenderedPage` (`@/lib/renderPageAnswer`); a refusal (answered on another device, turn ended) shows a toast and rejects the page's promise. The page learns where it stands from `openchamber.answer`, set when it loads (a JSON script element, so no data can close it) and updated by a posted state message, so a page loaded again after the answer can show the choice. A line under the page says it waits, what was answered, or that the user answered in the chat. The base stylesheet carries ready classes for such a page in the app's look (`.oc-options`, `.oc-option` with `aria-pressed="true"` on the chosen one, `.oc-button`), which the tool description names, so agents do not style their own on every page. `.oc-option` is the app's flat tile (`.oc-tile`: no border, a tone step on the page, a further step on hover or focus) and takes the selection fill once chosen (`--oc-selection`, like a pressed chip), since the accent colour means act, never chosen. Focus draws no ring on either class; a focused one takes its hover fill. `.oc-button` is drawn like the app's main `Button` (pale accent fill and border, readable accent text from `getReadableThemeColors`, the `.oc-raised-button` light), through `--oc-button-*` variables `htmlRenderTheme` computes per light and dark. It is sized in the app's rem (`--oc-rem`, read from the root font size, which the interface size setting scales), so it matches the app's buttons at any interface size; `--radius` follows the same scale.
  - Every page also gets a small kit of ready classes for what agents drew again and again (`KIT_CSS`): `.oc-box`, `.oc-muted`, `.oc-table` (a div around a table: the chat's Markdown table frame, scrolling sideways when wide), `.oc-num`, `.oc-badge` with `data-tone`, `.oc-dot` and `.oc-bar` (colored by `--color`, the bar as long as `--value`), two more `Button` variants on `.oc-button` (`data-variant="outline"` for a secondary action, `"destructive"`, through the same `--oc-button-*` variables and `--oc-destructive-*`), and form controls drawn like the app's: `.oc-field`, `.oc-input` (the `Input` with its field light), `.oc-switch` (the `Switch` on a checkbox), `.oc-segmented` (the active-pill strip). In 45 pages agents drew before the kit, about a third of the characters were the page's own CSS for these, written anew each time and looking different on every model. The light and dark differences come from `--oc-edge`, `--oc-field-*`, `--oc-raised-*`, `--oc-recessed`, `--oc-hover` and `--oc-*-text`, which `htmlRenderTheme` computes from the app's `.oc-raised`, `.oc-field` and `.oc-recessed` rules; the tool description names the classes and not these variables. A page with its own look ignores the kit. Plain HTML with ready classes was chosen over a component language the model writes instead of HTML (a generative UI library): that kind of library sends its component and language reference with every request, about ten times the size of this tool's description, and cannot draw what is outside its components, such as a mockup of the user's own app.
  - The row of buttons above the page (annotate, full screen, download) holds the browser panel's "Annotate page" toggle on web and desktop (not phones, not VS Code), so the user can point at an element, drag a region or draw over a mockup and tell the agent what to change; it is how a user reacts to a variant beyond picking it. It runs the same overlay as the Files view's HTML preview through `useFrameAnnotation` (`components/browser/`): the bootstrap carries the same bridge listener as a previewed file (`ANNOTATION_BRIDGE`, on the channel `lib/browser/previewFrameHost.ts` names), which evaluates the overlay's code only when the parent posts it. The prompt names the page by its title, with an intro saying the agent showed it in the chat; the frame's own address is `about:srcdoc`. A page is as tall as its content and often only partly on screen, so the desktop screenshot is the part of the frame that the window and the scrolling chat leave visible (`visibleFrameArea`), and the marks are shifted by where that part starts (`PageCapture.viewportArea`). The overlay's tool bar sits at the top of the page, just under the toggle. The buttons sit in a 24px row of their own above the page, small and without a fill, fading in on hover over space the row keeps: laid over the page's top corner they covered the page's own controls there. Sending the annotation while the page waits for an answer counts as answering in the chat. Only the inline page has the toggle; the full-screen view does not.
  - The app cannot read a selection made inside the frame, so the bootstrap reports it: the trimmed text (at most 20,000 characters), its box in the frame's viewport and a quote anchor, once it settles (on mouse up, or after a pause for keyboard and touch selections), and an empty text when it is gone. The anchor is measured in the page's own `document.body` text stream with the algorithm of `lib/chatQuoteAnchor.ts` (32 characters of context either side, start offset); the host validates it and adds `page: { partId }`. The host clears the app's own selection and re-dispatches the report as a DOM event from the frame element (`message/frameSelection.ts`). Every page owns its menu (`PageSelectionScope`, a `TextSelectionMenu` with `frameSelections`), attributed to the message that owns the render call, so a page works in its message, hoisted into the live turn outside any message body, and full screen; the message-level menu ignores frame events. The menu shows for the selected text with the box translated to app coordinates (re-read from the frame's position while the chat scrolls), and a cleared report hides it unless a comment is open. In the full-screen dialog the menu portals into the dialog's content so it sits above it and its comment input can take focus.
  - One selection at a time: when the menu stops tracking a frame selection (cleared, a press outside, the app selecting text, another page selecting) the host posts a clear message and the page drops its selection without echoing it back; a selection in one page clears the others' (`message/pageQuoteBridge.ts`). Escape pressed in the page closes the menu the same way, as Escape does for a selection in the chat: the bootstrap passes it on only while the page has a reported selection and its script left the key alone, so without a selection Escape stays the page's own. It travels as its own message and is never replayed as a key, because a bare Escape reaching the app's key handling would prime the abort of the running turn.
  - Quotes taken in a page persist like reply-text quotes. The host posts the page's marks (id, anchor, focused) when they change and when the frame loads; the page re-finds each by text and context and paints it with the CSS Custom Highlight API (`--oc-quote-mark`; focus, hover and flash share one color). A click on a mark posts its id and box (an empty id for a click on no mark) and the highlight layer opens the mark popover on click only, since the pointer over a frame is invisible to the app; the popover does not follow scrolling inside the frame. A page mark's popover opens only for a mark of the page that reported the click. Reveal and flash scroll the frame into view and ask the page to scroll to and flash the quote. The frame is as tall as the page, so in the chat the page's `scrollIntoView` scrolls the chat around the frame, which brings a quote far down a long page into view (checked in Chromium with the frame in its own process); in the full-screen view it scrolls the page inside the frame. Anchors without `page` are unchanged; an older client strips `page` and finds no highlight.
  - The frame takes the page's full reported height (at least 48 px; the 20,000 px ceiling only stops a page that grows with its frame), so a page never scrolls inside the chat: a scrolling frame keeps the wheel or a swipe that starts on it, so the chat stopped under the pointer until the page reached its end, and on a phone a frame as tall as the screen left no place to swipe the chat from. A long page reads in the full-screen view too. The page's root font size is the chat's body text size in px (`--oc-text`, from `--text-markdown` and the app's rem, so it follows the interface size setting live and is larger on phones, as the chat is); the tool description asks agents to size text in rem or em, so their text scales with it, while px stays fixed. The full-screen view builds the page `contained`, which stops its scrolling at the edges without the elastic bounce. A page that fits its frame gets `overflow-y: hidden` from the bootstrap, so a touch that starts on it scrolls the chat instead of bouncing inside the frame (iOS keeps a touch in any document that can scroll). Media is capped at the column width; content still wider scrolls sideways (`overflow-x: auto`, `overscroll-behavior-x: none`), and the tool description asks agents to give a wide table its own scroll box. A page wider than its frame has a horizontal scrollbar drawn like the app's (10 px, thumb from `--foreground` at the app's 18% and 36%), whose thumb shows only while the pointer is over the frame (#4949): the host posts pointer enter and leave on the frame element, the same hover that shows the buttons above the page, and the page marks its root with `data-oc-pointer`. The page's own `:hover` was not used, because with synthetic input in Chromium it stayed set after the pointer left the sandboxed frame, which runs in its own process. On a touch screen (`pointer: coarse`) the thumb always shows, as the buttons above the page do. The track keeps its place while the thumb is hidden, so hovering moves nothing, and the reported height includes it (the window's height less the root's client height); the tooltip check re-measures when that changes, since the bar can appear without the root resizing. The vertical bar has no width. Firefox has no per-axis scrollbar styles, so both its bars are thin and follow the same rule; Safari on iOS draws no styled scrollbar and reserves no room for one, so there the page looks as before. Only the horizontal bounce is off: `overscroll-behavior-y` stays default, because turning it off would also keep a vertical swipe from reaching the chat. The last height is kept per call, so a row the timeline unmounted comes back at its size. The reported height reaches down to where the body's content ends, overflow included unless the body clips it, and to the lowest absolutely positioned element outside any box that scrolls or clips. The document's scroll height counts content past the root's box only while the frame is shorter than where it ends, so a hidden tooltip parked below the page's last block (#4940), or a picture taller than the box it sat in, made the frame grow and shrink on every frame, and the text under the page shook with it. The body's scroll height does not depend on the frame's height, so it ends that loop; it misses an absolutely positioned element placed against the page itself, which the element check covers.
  - A page that scrolls itself (the body, or a box spanning the frame from top to bottom with `height:100vh` or `100%` and `overflow:auto`) never outgrows its frame, so its reported height was the frame's own and it stayed a 48 px strip scrolling inside. The bootstrap adds what such a box hides below its edge, once per box height: a fixed-height box that only happened to span the frame does not follow the frame, and growing it again would swing the frame between two heights. A box that starts lower (an app shell with a header above a `flex:1` scroller) is not detected; the tool description already forbids `100vh` and `height:100%` on html and body.
  - A frame is transparent (`opacity: 0`) until the page's first size report or its load, whichever comes first. What a new frame paints before the page's own document is not the page, and under a dark theme a page flashed white each time the timeline mounted it again while scrolling. The size report arrives once the page is laid out, so a page with slow remote images does not wait for them; the space is already held at the page's remembered height. Opacity and not `visibility: hidden`, which Chromium may treat as a hidden cross-origin frame and throttle, holding the size report back.
  - The bootstrap moves a tooltip or popup the page positions itself back inside the frame when it sticks out past an edge (`translate`, so the page's own `transform` still applies). Only absolutely or fixed positioned elements that are partly inside are moved; one wholly outside, wider than the frame, or inside a box that scrolls or clips is left alone. Hover counts as a trigger, because a CSS `:hover` tooltip changes nothing in the DOM. The tool description also asks agents to keep tooltips inside the page.
  - In the mobile layout (`useUIStore.isMobile`) the page has no full screen or download: it is already as wide as the screen.
  - Full screen opens the page in a dialog, inset from its edges and as tall as the page up to the window, past which the page scrolls. Download saves the page with the theme it was viewed in; on Capacitor it goes through the native share sheet, and VS Code shows no download because its bridge has no save route for HTML.
  - A page can name an image file on the machine by its absolute path (`renderPageImages.ts`). The page cannot read files, so before drawing it the chat asks the image grant route for the paths the page names (the server checks them against the call's stored HTML; see `packages/web/server/lib/markdown-image-grants/`), reads each through `/api/fs/raw` as a data URL and puts it in place of the path. A data URL, not the asset URL: the asset URL carries the URL auth token, which the page's script would see. The page is drawn once its images are in, never before and again after, since a second draw reloads it; its space stays reserved meanwhile. The chat sends every path the page names in one request with the page's call id, and the server shows them in page order while their files add up to 25 MB; the agent's tool result names the rest. An image that does not load keeps its path. VS Code reads workspace images through its file bridge, one by one in page order up to the same 25 MB, since no server weighs the page there, and has no temporary-directory images. A page that scrolls away is remembered with its images in place so it comes back without reading them again; remembered pages are bounded by their total length, 100 MB of characters (about a byte each), and past it the oldest go and read their images again when scrolled back to.
  - VS Code's webview CSP allows inline scripts but no remote ones, and a `srcdoc` page inherits that policy, so the tool description tells agents to draw charts with inline SVG or their own script.
  - With Activity collapsed, a page is never folded away. `LiveTurnActivity` collects the turn's pages (`getShownPages`) and `LiveTurnHoistedPagesContext` keeps their rows out of the fold, so an opened fold does not draw them twice. While the turn works, and in a turn that ended without a final answer (stopped, failed), the pages sit right below the fold, and what the agent did after the last page (more steps, the reply it is still writing) is drawn below them, so the page stays put while new work appears under it; once the final answer arrives, the final message draws them above its first answer text. With Activity expanded there is no fold, and a page sits where its call ran.

- `BlockLine.tsx`
  - The vertical connector line left of a collapsible block's body. It is also a click target: clicking it folds/expands the block via its header toggle handler (`onToggle`), or toggles the nearest native `<details>` when no handler is passed (JSON summary sections). Geometry is inline-styled (12px hit strip centered on the 1px line) so it does not depend on compiled Tailwind classes.

## Current important behavior

### Bidirectional prose

Shared chat CSS applies `unicode-bidi: plaintext` to prose blocks, including
nested paragraphs, headings and table cells. Plain user text uses the same
behavior across newlines. The message root does not select one direction for
all its children. Code widgets, diagrams, math and technical references remain
LTR isolates, including their controls.

The Streamdown component map and shared CSS own direction without a DOM
annotation pass. Each list item owns its logical gutter, allowing adjacent
Arabic and English items. Inline code and code widgets remain LTR isolates.
Direction changes must preserve source and copy text. Disclosures use native
`details` and `summary` with a React-owned chevron that follows the open state.

### Turn footer copy and image

The footer under a turn's last assistant message copies and saves the whole
reply: the text parts of every assistant message in the turn, in order, with
tool output and reasoning left out. `MessageList` hands the earlier text to the
last message as `earlierAssistantText`; per-message copy buttons keep copying
only their own text. Earlier messages may be folded or not mounted, so
`buildTurnImageExportSource` renders each text part through
`markdown/renderMarkdownForExport.tsx`. Whole-message rich clipboard content
uses that helper too. It mounts the same `MarkdownContent` component used on
screen and removes its temporary host after taking the result. Image export
prepares code highlighting with a bounded wait, then synchronously commits the
prepared tokens before cloning the result. Export
disables filesystem probes and media loading, preserves original media source
metadata, and omits controls and authenticated asset URLs.

Rich clipboard output normalizes only its detached result: code and Mermaid source become
semantic `pre/code` with literal source newlines, and media becomes safe text
labels without loaded URLs. This does not modify the live React subtree or
run a second Markdown parser. Ordinary code selections copy raw code;
prose follows the Markdown/plain setting and retains safe rich HTML. The
desktop `openchamber:copy` event follows the same selection policy.

### Why selection cloning follows the Range boundaries

`markdown/selectionRange.ts` owns code-source coverage for Markdown selection,
rootless tool selections, and rich clipboard copies. Native `cloneContents`
retains attributes on partial elements, so full code-source metadata is removed
only from clones whose original content is not completely selected. Partial
elements lie on the two Range boundary ancestor chains; following their
first/last-child clone paths avoids scanning unrelated code blocks and pairing
query results by index. Restored ancestor shells use the same coverage rule.
The live React tree is read-only, and detached copies remain self-contained
after React unmounts. Local selections still read committed token rows; whole
code copies retain the existing full-source policy. Selection capture timing
and highlighting retention are independent of this cloning step.

### Markdown ownership

`MarkdownRendererImpl.tsx` connects Streamdown to the application component
map. Streamdown and React own the ordinary Markdown subtree. Application
components own navigation, file references, media, Mermaid and controls;
`markdown/streamdownPlugins.ts` owns parsing and HTML/URL policy. Screen,
clipboard and image rendering share this configuration. The stable consumer
root is `.markdown-content[data-markdown-content]`; code and table consumers
use native `data-streamdown` markers.

Fenced `diff` blocks carry a translated Proposal label and a source-copy button.
Completed, bounded patches use the same read-only diff preview as tool cards,
with file names as text and no file actions. Headerless +/- snippets receive
parser-only hunk coordinates; copy and export retain the original source.
Incomplete, oversized or unparseable blocks keep a plain source preview. The
diff stack loads only for a completed block within the tool preview budgets.
Clipboard and image export keep ordinary code markup because the rich diff's
shadow DOM is not part of the detached export tree.

#### Why React owns Markdown updates

Using Streamdown's parsing and component lifecycle keeps screen and export
rules together. A second HTML renderer or a post-render wrapping pass would
split that ownership and require separate state restoration. Preserve
disclosure choices and readable code through stream, settlement and async
highlight updates in the native renderer tests.

Chat parts choose their parser mode on first mount: completed history uses
static mode; a live or not-yet-finalized part uses streaming mode and keeps that
block tree after settlement. A new message/part identity resets the choice.
Assistant media ownership is explicit and independent of parser mode, so static
history keeps the same image grants and remote-media policy. Ordinary static
documents retain local/document media behavior.

Streamdown configuration objects and parser plugins retain their references.
Arrival context values change only with the active flag or committed block
count. Existing blocks keep their initial animation choice. The memoized code
body receives its highlighter directly, isolating token-row traversal from
copy-button state and unrelated presentation context updates. File annotations
retain unmodified token rows; a warm result does not allocate plain fallback
rows. Export source collection runs after commit, not during rendering.

Tables use one React-owned wrapper for the end-aligned toolbar and scrollable
canvas. Streamdown still owns cell rendering; its table wrapper and controls
are not nested under a second toolbar. Copy/download preserves bare URLs in
CSV/TSV and escaped links in Markdown, with copy feedback on the trigger.
Each table measures its body columns locally, with headings excluded from that
intrinsic layout; header-only tables use their headings. React then renders its
colgroup. Short columns keep their width; long columns share remaining space,
with the original 120px minimum. Container resize refits saved widths; content
or font changes require fresh measurement. Inline code wraps only in capped
columns. This preserves the previous sizing policy without a document-wide
decorator or imperative colgroup replacement.

Code copy/wrap buttons remain visible without hover. File navigation is enabled
only for settled content with file references enabled; mobile keeps navigation
while skipping filesystem probes. Selection-ending clicks are consumed without
opening a file, and platform-specific Cmd/Ctrl clicks retain external opening.

#### Why KaTeX is pinned by an override

`@streamdown/math` renders through `rehype-katex`, which depends on KaTeX
0.16, while the stylesheet the app loads (`styles/katex-css`) comes from the
KaTeX the UI depends on. The root `overrides` entry keeps one KaTeX in the
tree, so the markup and its stylesheet are always the same version.

#### Why Mermaid retains synchronous rendering and a separate viewer

Completed Mermaid fences use beautiful-mermaid's synchronous renderer with the
original 100-entry LRU, keyed by source and SVG/ASCII mode. Screen SVGs reference
semantic CSS colors, so theme changes preserve geometry and the viewer's current
viewBox. Downloads and offline rendering resolve those palette references to
concrete theme colors on the original SVG, never the panned live DOM. Incomplete
fences show source; there is no streaming layout queue or idle-render delay.

React owns the block, scroll container and floating toolbar. The viewer owns
only SVG viewBox interactions. Button visibility does not disable gestures.
New viewers settle for two animation frames and batch all size reads before
viewBox writes; early interaction initializes that viewer immediately. Cleanup
removes pending work and listeners. Preview sizing measures each new SVG once,
prefers content bounds, and uses saved original bounds for its fallback rather
than observing every pan/zoom attribute write. ASCII copy uses the displayed
text; SVG copy uses source, and both show copied feedback.
Fullscreen height passes through Streamdown's intermediate root. Recreated
controllers read saved original bounds rather than the previously fitted or
zoomed viewBox, so reset remains tied to the diagram's original geometry.
Screen SVGs remain visibility-hidden inside their reserved viewport until a
fit with nonzero dimensions completes. This avoids painting the raw diagram
before the two-frame batch runs. Offline exports bypass this visibility gate.

#### Why block edge margins use wrapper-local CSS variables

Nested structural first/last selectors caused subtree style invalidation during
token insertion and virtual row replacement in session-switch traces. Separate
selectors detect the wrapper edge and consume its CSS variable on the content
edge. Each wrapper resets the variables; paragraph, heading and compact-message
defaults preserve interior margins. CSS tracks appended and removed blocks
without dependency patches, additional parsing or imperative DOM writes. Static
rendering keeps its direct-child rules. This CSS alternative still needs its
own browser performance comparison; the explicit-metadata experiment does not
establish its invalidation cost.

Markdown code in languages with a `@pierre/highlights` lexer (about 80, every
common one) is tokenized on the main thread, synchronously, in one pass over
the whole block with `MARKDOWN_HIGHLIGHTS_THEME`, so the block paints
highlighted on its first commit. The rest run in `streamdown-code.worker.ts`
on Shiki/Oniguruma with the same grammar sanitization as the shared code
worker and `MARKDOWN_SHIKI_THEME`. Until the Highlights import settles, the
first blocks wait for it and then take the same split. Both themes resolve to the same `--md-*` variables.
For Shiki languages, complete-line grammar state stays in eight bounded worker
lineages; edits restart from a matching prefix or a full pass. The client preserves the pre-migration cache
policy: four recent streaming results, four complete-line snapshots, and a
2000-entry, 24 MiB estimated completed-result LRU. Language and the existing
dual-hash content fingerprint key pure highlighting. A single oversized entry
is retained; no filesystem or runtime-dependent annotations enter this cache.
Only completed requests coalesce. Streaming results promote to the completed
cache when the same source settles. Snapshot sequence numbers keep an older
response from replacing a newer base in the same lineage.
Streaming requests reuse complete prefix rows and transfer only suffix token
ranges and palette indexes in two ArrayBuffers. Text is reconstructed from the
caller's source using UTF-16 offsets, without JSON encode/decode. Whitespace
tokens may absorb foreground differences but preserve font/background and
decoration boundaries. `MarkdownCode` owns the React token rows and line numbers,
using Streamdown's public container and header. A warm lookup renders tokens on
the first commit; unchanged row arrays skip row rendering. Async results carry
their input and append lineage, so abandoned contexts and shorter late results
cannot replace newer displays. Shiki never runs on the main thread:
unsupported workers, oversized input and failed requests leave readable code.
Main-thread Highlights results go through the same caches; streaming rows that
match the previous result of the same block keep their identity. Each dispatched request has a five-second
deadline. A timeout terminates the worker, caches only the offending failure in
the same LRU, and replays other pending requests with fresh deadlines. A crash
or message error ends all pending requests without caching their failure;
subsequent requests may retry. Work serializes inside the worker, with no new
main-thread queue admission limit. The existing `openchamber_stream_highlight`
full-pass flag bypasses incremental reuse. Language-load failure falls back to
text. Line budgets remain 1200 settled, 300 open-fence, and 200 in VS Code.
Lexical file-path matches have a separate bounded source cache; confirmation
stays directory/runtime-bound. Empty path results do not trigger another token
callback, and annotations reuse results only within their resolver instance.
VS Code loads the bundled worker through its existing webview blob-worker
boundary. Image export awaits the same token path with a bounded fallback to
readable source. The code body reads prepared tokens during render, so the final
flush commits them without DOM readiness markers or an observer.

#### Why pending code retains its last result

Like Streamdown's highlighted body, the code body uses plain text on first mount
and retains the last display while an appended input waits for highlighting.
It does not splice tokens itself: the worker owns complete-line grammar and token
reuse. Replacing the entire block with plain rows between worker results discarded
prefix identity and repeatedly deleted and recreated highlighted tokens.

A mounted body records the displayed result's actual input after commit. Results
for intermediate append inputs may advance that display even when newer input is
pending, so continuous output does not starve updates. Shorter late results cannot
roll it back. Edits, deletions, language changes and plugin/context changes start
a new lineage; callbacks from abandoned lineages are ignored even if the text
later returns to an old prefix. Exact cached and policy-driven plain results take
precedence. Worker failure publishes the requested plain text through the existing
plugin fallback. This is one mounted component's display state, not a shared cache.

The separate code worker (`markdown-shiki.worker.ts`) remains shared by
non-Markdown code views for Shiki languages. Their client renders Highlights
languages on the main thread, and `getCachedHighlightedCode` /
`getCachedHighlightedLines` answer them synchronously for a highlighted first
paint.
CodeMirror (`lib/codemirror/codeHighlight.ts`) runs Highlights' `LiveTokenizer`
on the main thread, so an edit re-tokenizes only the lines it changed and
colors land with the keystroke; it uses this worker only for languages without
a Highlights lexer. Its whole-block HTML, per-line HTML and themed token APIs,
cache and timeout/replay rules are unchanged. Markdown does not call that
worker's HTML interfaces. Its `init` message warms Highlights only; Shiki and
its WebAssembly start on the first language Highlights has no lexer for.

#### Why Highlights languages run on the main thread without lineages

Highlights tokenizes without regular expressions, about a millisecond per
100 KB, which is less than a worker round trip; the line budgets cap a block
well below that. Running it on the main thread removes the plain first frame,
and re-tokenizing a streamed fence from its first line costs less than keeping
and matching lineage state. Its lexers are written per
language and cannot backtrack, so the `template-call` hang behind the
sanitization does not apply to them. A runtime whose WebAssembly lacks SIMD
fails the Highlights import, and every language falls back to Shiki.

#### Why the code plugin uses the application's WASM worker

The official code plugin tokenizes both configured themes even when they are
identical. This application uses one CSS-variable theme, so its worker runs one
pass and, for Shiki languages, reuses the existing grammar sanitization and
complete-line state rules. Transferring suffix ranges keeps repeated token strings and
unchanged rows out of worker replies while preserving native Streamdown tokens.
Cache eviction, request coalescing, timeout replay and grammar-lineage retention
follow the pre-migration worker. The payload and its byte estimate change from
HTML to tokens so React can own the code body; streaming-only prefixes stay in
the bounded recent results.

### Optional history disclosure

The chat has one render mode: parts stream in and stay in the order they ran.
The Sorted mode, which folded a turn's work into one block above its answers,
was removed; a stored `chatRenderMode: 'sorted'` reads as Collapsed Activity
(`lib/settings/parsers.ts`, `parseActivityRenderMode`). Expanded preserves the
timeline without a turn disclosure. Collapsed adds one Activity header after
completion or interruption while preserving the original rows, their order, and
their individual controls. It adds no tool subgroups, side line, height cap, or
inner scroller. Subagent calls alone do not make a turn collapsible.

The active turn has its Activity header from the first step. Folded, it shows
only the latest 7 rows (a text, a reasoning block or a tool call each;
`lib/turns/activityRows.ts`); the header counts the earlier ones ("+N more")
and opens them all. `LiveTurnActivity` leaves out the messages entirely above
the cut and tells the message it cuts into, through
`ActivityRowSkipContext`, how many of its first rows `MessageBody` skips; both
count with the same rule. When the cut moves down, `useActivityRowGlide`
replays the jump as a 220 ms glide of the rows (FLIP, `transform` only, skipped
with reduced motion). The trim stays while the settled fold closes and lifts
when the reader opens it.

A long turn, in either mode, mounts only a window of its rows
(`lib/turns/turnMessageWindow.ts`, `components/TurnMessageWindow.tsx`): past
60 rows its newest 40, with the rest behind spacers that mount 40 at a time as
they near the viewport. It counts rows with the same rule as the fold, and the
head may end inside a message, whose first rows `MessageBody` skips through
`ActivityRowSkipContext`. Counting messages left a turn of a few steps with
dozens of parallel calls each fully mounted.

A final assistant message with `finish: stop`
collapses the earlier messages and the final message's non-text parts, keeping
the answer and its existing footer outside. Intermediate-text summary fallback
and compaction summaries never become final answers. An older turn without a
final answer collapses once a later visible turn has an assistant response;
a queued user message alone is not enough. Hidden user continuations retain
the visible-turn mapping established by `projectTurnRecords`. A notice the
timeline skips that separates a `stop` answer from the next assistant message
opens a turn there (`createNoticeTurnSplitter`), so each answer keeps its own
Activity and stays outside it; a notice between steps of one run does not.

Manual expansion survives later metadata updates and timeline virtualization
within the session. The disclosure uses a finite 180ms height transition,
respects reduced motion, and delegates end pinning to the existing timeline.
It never calls scroll-to-bottom. Collapsed history does not mount its hidden
message bodies; initial history loads do not animate collapse.
Layout-effect replay after a Suspense hide/reveal must settle the requested
height and retained children even when the expanded target did not change.
Cleanup stops the animation, so a same-target early return can leave a cached
pre-collapse height on the DOM indefinitely. Failed animations also settle;
callbacks from cancelled, superseded animations never settle a newer target.

The virtualizer also adds temporary end padding while compensating prepended
history. `@legendapp/list` stores that padding's CSSOM read-back value (built
in since 3.3.11; it was a Bun patch before): Chromium rounds fractional pixel
strings, so comparing the original input with `style.paddingBottom` could skip
cleanup permanently and leave a phantom tail even when every Activity region is
already zero-height. `scripts/legend-list-padding.test.mjs` checks the
installed version for it. Chat padding and scroll policies do not compensate
for it.

The Bun patch for `@legendapp/list@3.6.0` floors `roundSize` to the device
pixel grid instead of eighth pixels, mirroring upstream LegendApp/legend-list#536.
Rows the list has not measured yet are placed at the average measured height;
with eighth-pixel precision their positions are fractional, the browser rounds
each `scrollTop` correction, and the remainder is lost on every compensation
pass. A history prepend then leaves the reader's row one to two pixels off
(3.3.10 drifted too; the browser harness passed only because its row heights
happened to average to a whole pixel). The patch covers both web entry points
in ESM and CJS. Drop it once upstream ships #536 or an equivalent, and verify
with `bun packages/ui/tests/chat-history-scroll.browser.mjs`, which runs the
prepend scenarios over several row-height profiles for this reason.

The same patch hands out containers in item order while the list's initial
scroll is active, end-aligned included. Upstream reverses them for an
end-aligned start (`renderPriority` in `findAvailableContainers`), so a
freshly opened timeline was in reverse DOM order and the DOM-order pass
(`useDOMOrder`) moved nearly every row about 300 ms after the reveal: each row
restyled, and with an accessibility client on, the transcript re-serialized
(about 40 ms on every session open and switch). Containers render in index
order, so rows are now in DOM order (what screen readers and tab order follow)
from the first paint, and the pass finds nothing to move. Scrolling up still
recycles containers out of order; the pass corrects that as before. The patch
also keeps the pass's own delay: it treats the list's mount as activity, so a
pass that does have work waits for 500 ms of quiet instead of landing in the
opening reveal. `scripts/legend-list-dom-order.test.mjs` runs the installed
bundles' allocation and timer code for both.

The header retains its report when expanded and has no hover background. Its
left inset matches the tool rows. Diff deletions use the ASCII hyphen.
The header reports five categories: changed files, codebase
exploration, commands, web research, and subagents. Narrow chat columns only
show file changes. Exploration and research are flags, not synthetic counts.
Subagents count distinct child session IDs; commands count calls, not shell
subcommands. Unknown tools and administrative tools stay in the disclosure
without a guessed summary category.

File statistics come exclusively from successful edit/write/patch tool
results, not user-message summary diffs or the current workspace Git diff.
Unique normalized paths determine file count; renames preserve identities.
Line totals sum performed edits, including lines later removed by another
call. Per-file patches/counts take precedence over a whole-call patch; the two
representations are never added together. Missing or truncated diffs suppress
the line total rather than presenting a partial total as complete. Write input
content is not evidence of added lines. Repeated records of one call count once.

The completed-turn file pills under the final answer (the "show changed files"
setting) use the tool-result file identities, in first-touch order, with paths
as the tools reported them (v2 assistant messages carry no working directory).
Line counts come from each call's patch; a file with no recoverable counts
shows its name alone. Every pill opens the turn diff: OpenCode 2 computes it on
request (`GET /api/session/:id/diff`, `DiffView`'s "Last turn" scope) from the
turn's start and end snapshots, merged per file, so it also covers a `write`
result and the edits a `subagent` made in its child session, which the pills
themselves cannot list. Past four pills the rest wait behind one `+N` pill
that reveals them in the row; the same pill then hides them again. The list is projected once the last assistant message
finished with `stop`, so no tool patch is parsed while the turn streams.

### Why empty reasoning does not separate the answer

`MessageBody` omits reasoning containing only whitespace or default-ignorable
characters before adding its React element. The final-answer divider counts
preceding rendered elements, so adding a reasoning element whose child returns
`null` would leave a divider above a direct answer. Visible reasoning and tool
rows keep their divider.

### Why media reconnects in layout setup

The content owner survives effect disconnection, while requests and document
object URLs belong to one connection. Layout setup makes that connection usable
before child passive effects resolve sources; a deferred terminal dispose only
covered immediate StrictMode replay and left longer hidden intervals unusable.
Document consumers clear revoked URLs before paint and load fresh ones through
the same owner.

### Message parts

- Assistant Markdown treats raw HTML as inert visible text, including HTML
  inside link text. `streamdownPlugins.ts` applies the restricted rehype policy
  and sanitizer, retaining Streamdown's hardening plugin. Files previews and
  reference descriptions/comments opt into safe raw HTML with `allowRawHtml`.
  Author styles, application classes and active content remain forbidden.
  Restricted disclosures have a dedicated remark parser in ordinary chat.
  A summary that is a single `<h1>`-`<h6>` tag, as GitHub review bodies write
  it, becomes a heading node there, so it renders as a heading in both modes.
  GitHub alerts (`> [!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]`,
  `[!CAUTION]`) become titled callouts in every Markdown surface
  (`remarkAlerts.ts`, `MarkdownBlockquote.tsx`); the kind travels as a
  generated `data-oc-alert` the policy drops from authored HTML, and copying
  writes the marker back. Item text in the references preview also links
  repository references (`remarkRepositoryReferences.ts`, see
  `components/references/DOCUMENTATION.md`) and draws review suggestions
  (`markdownSuggestion.ts`).
  Safe custom application links keep the app-link confirmation flow; only
  existing session routes qualify as `openchamber:` links. VS Code keeps
  session links inert.
- File references use `markdown/markdownFileReferences.ts`, `MarkdownLink`
  and the code plugin's token metadata. Automatic confirmation runs through
  the bounded, cached stat queue after settlement and never on mobile.
  Code-path annotations are declarative; unconfirmed tokens stay code.
  Automatic probes skip emails, handles and digit-leading suffixes
  (`user@gmail.com`, `v1.2.3`, `backup.7z`); an `@` after a slash is a path
  (`node_modules/@types/...`) and still links. Clicks on a link keep the broad rules, so a
  file-looking href opens the viewer and never a new window (#3858). In the
  phone shell the click also opens the workspace drawer on Files, as tool
  rows and attachments do; without it the file is staged out of sight (#5486).
  Directory/runtime changes must reject older results. Explicit file links
  retain their navigation behavior independently of automatic probing.
- Assistant media nodes belong to `MarkdownMedia` and `MarkdownMediaContext`.
  A workspace-local or embedded PNG/JPEG/GIF/WebP image outside a link starts
  as a label. Loading requires settlement and proximity to the viewport.
  React updates that node after the picture loads, at most 30rem wide and
  tall. An image-only paragraph coordinates equal-height rows through local
  component state, using image aspect ratios and wrapping at small widths.
  Mixed prose paragraphs keep their normal flow. No label scan or detached
  DOM restoration participates in loading.
  An image that is missing, too large or fails validation keeps its label.
  Remote model/tool Markdown images stay labels or links, so a model or a
  fetched page cannot learn when the user read the message. Documents and
  references retain their explicit inline-image policy. A click on loaded
  assistant media opens the shared attachment preview overlay
  with every drawn image of the message as its gallery. Copying a selection
  writes `![name](source)` from `data-oc-media-source`, never the authenticated
  asset URL. Incomplete image syntax emits no loading placeholder.
  In server-backed runtimes, the first label of a part to near the viewport
  prepares all of that part's local images (at most 12) in one request to the
  grant route, then loads them through the authenticated `/api/fs/raw` asset
  route; the preview prepares again, so an expired grant is renewed. Embedded
  images are validated in the browser and limited to 10 MiB. VS Code loads
  workspace-contained images through its local filesystem bridge and never
  calls the grant route; images outside the workspace stay labels there.
  Workspace-external images, wherever they are on the machine, receive the
  existing path-bound `outsideFileGrant` only when the server verifies the
  exact source in the owning assistant message and the file's signature.
  Effect cleanup aborts the connected media requests and revokes document object
  URLs. Layout setup reconnects the same content owner before child passive
  effects register and resolve sources. Each async operation captures its own
  signal, so a late completion cannot use a later connection. Loaded chat image
  presentation keeps its owner identity; document URLs are resolved again after
  revocation. Runtime changes dispose the old owner synchronously, including
  same-runtime credential renewal. Reconnection also checks the URL resolver
  identity because hidden providers can miss endpoint events.

- `read` and `skill` are **static navigation tools** and render via `StaticToolRow`.
  A `read` of an image adds a fullscreen icon after the title, placed and
  styled like the open icon of the edit rows; it opens the image with the files zone expanded beside the chat
  (`openContextFile` with `expanded`). Only web and desktop show it: VS Code
  and mobile open files full size already, through the path itself.
- Every other tool, including search/fetch, OpenCode built-ins, custom tools, plugins, and MCP tools, is **expandable** and renders through `ToolPart`.
- The managed `openchamber` plugin tool uses the expandable path and hides its broad protocol input. The plugin supplies the selected action's human description as the native tool title; the UI renders that metadata without owning an action map. The full versioned result envelope renders through the same neutral JSON summary/tree/raw views as other tools, without a tool-specific output card.
- Selecting a JSON summary, tree, or raw view saves that mode in the persisted UI settings. New and refreshed JSON tool outputs read the saved mode across sessions; missing or invalid preferences use Summary. A summary section's chevron turns on that section's own `<details>` state (`JsonSummarySection`), never on an enclosing one, so a nested row that is still collapsed keeps pointing right while its parent is open.
- `ToolPart` defers expanded content after a user toggle, preventing large tool input/output payloads from mounting during the initial chat render.
- A failed `!command` row states its reason while collapsed, after the description and in the error colour, so a red row is not a bare duration. `TimelineNotice` passes it as `failureReason`: for a command that exited on its own, the last non-empty line of its output as the terminal shows it, because that is where sudo or ls prints the problem; for one killed or timed out, one that printed nothing, or one whose output OpenCode truncated (it keeps the start, so the last stored line is not the end), how it ended (`timeout`, `exited (1)`). The line is capped at 300 characters, its tooltip shows what the row cuts off, and the whole line is in the expanded output. An expanded row does not repeat it, because the body already shows the error and output. Agent tool rows get no reason line: a call interrupted by Stop keeps its streamed output, and its last line would read as the failure.
- The rich tool diff preview lives in `ToolPartDiffPreview.tsx` and is lazy-loaded from `ToolPart`. It is the only tool-card piece that imports the `@pierre/diffs` highlighting stack, keeping that stack out of the eager chat startup graph. While its chunk loads (first rendered diff only) the plain-text patch from `PlainDiffFallback.tsx` renders as the Suspense fallback, mirroring the preview's error fallback. Patches over 256 KiB or 2,000 lines skip rich parsing and use a bounded plain-text preview; navigation keeps the original patch. `ToolPart` itself must not statically import `@pierre/diffs` runtime modules or `@/lib/shiki/appThemeRegistry`.
- `@pierre/diffs` highlights with `DIFFS_HIGHLIGHTER` from `@/lib/shiki/diffsHighlighter`: `highlights` wherever WebAssembly with SIMD runs, `shiki-js` otherwise. The library allows one highlighter type per thread and throws on a second, so the worker pool in `DiffWorkerProvider.tsx` and every main-thread `File`, `PatchDiff` and `FileDiff` pass that same value. Highlights has no lexer for some languages, and the per-thread rule leaves no Shiki fallback in files and diffs, so `diffsHighlighter.ts` maps the readable ones to a close relative (templates to HTML, ini-style files to TOML, `.env` to bash); the rest render as plain text. Highlights lexers cannot backtrack, so the JS/TS `template-call` hang from openchamber/openchamber#2587 does not reach diffs. On the `shiki-js` fallback the stack is still unprotected: its `langs` accepts `SupportedLanguages` strings only, leaving no place for a sanitized `LanguageRegistration`.
- OpenCode 2 Code Mode arrives as one tool, `execute`, whose input is a short
  JS script (`input.code`) calling the MCP and integration tools as functions.
  The row is named **Script** (`toolHelpers.ts`), uses the `braces` icon, and is
  described by `metadata.toolCalls`: the called tool names deduplicated in
  first-seen order with a `×N` repeat count, at most four named and the rest
  counted as `+N more`. That is the `tools` description kind in
  `@/lib/opencode/tools`; while the script is running, or if it called nothing,
  the row falls back to the script's first line, capped like a shell command.
  The expanded body replaces the generic input preview with the script as
  highlighted JavaScript, then the call list (tool name, its arguments as
  one-line JSON, error calls in the error colour), then the normal output
  section. `metadata.truncated` adds a plain note with `metadata.outputPath` as
  text: the app has no open-file affordance for a path outside the project.
  The status pill says `running a script`, or `calling <tool>` once
  `metadata.toolCalls` names one (`hooks/useAssistantStatus.ts`).
- Running `shell` output falls back to `state.metadata.output` until canonical `state.output` arrives. Its output viewport grows with the content up to `46vh`, then scrolls and follows new output until the user scrolls up; following resumes when the user returns to the bottom. Live output appends or replaces rewritten snapshots as plain text without worker highlighting; finalized output normalizes ANSI terminal controls with a bounded synthetic-cell budget, bypasses the throttle, and receives the normal one-time highlighted rendering.
- A background `shell` call (`background: true`, or moved to the background mid-run) settles at once with `metadata.status: "running"` and a `shellID`; its text is a notice plus an instruction for the model. `ToolPart` renders it through `BackgroundShellToolPartContent`, which rebuilds the part from the command's real state (`backgroundShellPart.ts`) so the row keeps the ordinary shell look collapsed and expanded: while `sync/background-shells.ts` lists the command it is a running shell with a live timer from the call start and an `in background` label, and its expanded output is read from `/api/shell/:id/output` only while expanded, once a second while output arrives and backing off to every 4 s while the command is quiet (`useBackgroundShellOutput.ts`, starting from the last 64 KiB). Live durations count whole seconds on the shared 1 s tick (`hooks/useDurationTicker.ts`); a finished row shows tenths. Once OpenCode appends the command's completion (a `synthetic` message with `source: "shell"`, see `@/lib/opencode/background-shell`) the row is a finished or failed shell ending at that message, with its real output; the completion message itself stays hidden from the timeline. While it runs the row has a stop action. OpenCode 2.0.19 has no route that cancels a background job, and `shell.remove` reports the command to the agent as an error (`Shell.NotFoundError`, "nothing ran"), after which agents relaunch it; `opencodeClient.stopBackgroundShells` therefore first admits one non-resuming synthetic note (`shellCancellationNote`) for the commands of one session it stops, which explains the coming errors as the user's stop without forbidding the commands, and removes the shells together only once the note is in. The note stays out of the timeline (no context metadata); its `openchamberShellCancellation` metadata (`shellIDs`, or a single `shellID` in notes written before stops were grouped) makes each named row read "stopped" instead of failed. Drop the note once OpenCode reports a cancel itself. The composer's `BackgroundShellsStrip` offers the same stop for every running command of the session and its subagents (see `composer/DOCUMENTATION.md`). Between the two, or before the list was read, the row shows the notice without the model instruction and no duration. The user moves a foreground command (or a subagent the turn waits on) there with `session.background`, which backgrounds all of the session's blocking work at once: the action sits in the status chip above the composer and in the scroll-to-bottom pill (`components/BackgroundWorkButton.tsx`, a sibling of the pill's scroll button), shown only while `useAssistantStatus` reports `working.canBackground` (including a running shell or subagent inside Code Mode `execute`: its live `metadata.toolCalls` list or child progress, a `shellID` or a `sessionID` with `status: "running"`, identifies the blocking job), and on the customizable `background_session_work` shortcut (default `mod+shift+b`; not the TUI's `ctrl+b`, which the composer's macOS emacs keymap uses to move the caret and which is `mod+b` elsewhere). The row then turns into the background row above.
- A `subagent` call that went to the background (`background: true`, or moved there with `session.background`) settles at once with `metadata.status: "running"` and the child in `metadata.sessionID`. `SubagentToolPartContent` rebuilds it from the child (`backgroundSubagentPart.ts`): running while the child session is active in `global-session-status`, then finished, failed or stopped from the report OpenCode appends (`findSubagentRun`), with the `in background` header label while it runs, `stopped` after a cancel, and the stop action described for subagent rows above. `ChatContainer` drops that report from the timeline (`keepCommandSubagentReports`), so the subagent stays where it was started instead of reappearing as a new turn at the end. Only reports of `subagent: true` commands, which have no call row, still render as their own `TimelineNotice` turn, and only when the child started inside the loaded history; any other report (a call not loaded yet, an unknown child) stays out of the chat and is reachable from the session's subagent list, so loading older history never makes the chat shift.
- The result of a session the agent dispatched with `returnResult` arrives as a `synthetic` message with `source: "openchamber-session"` (`@/lib/opencode/dispatched-session`, delivered by the server's `lib/dispatch-results`). It is a background report like a subagent run (`isBackgroundReportEntry`): it opens a turn, so the woken agent's reply renders below it, and a fork after an answer cuts before it. `TimelineNotice` renders it as one collapsed row, `Session finished: <title>` (failed / stopped variants carry the status icon), that opens to the answer as Markdown with an `Open session` action going through `openSessionLink`.
- A session notice is a labelled message OpenCode, a plugin or OpenChamber puts into a session: a `synthetic` message with a `description`, or the `system` message OpenCode writes when the session's instructions change. `@/lib/opencode/session-notices` decides which ones the timeline shows (plugin notices, a restart, a `!command` that could not start, a move to another folder), and its header lists every kind, shown and hidden, with the reason; change that list there when a kind turns out to be noise. The rest about the session's instructions (skills, MCP servers, instruction files, "Loaded AGENTS.md") stays hidden as noise. The live `session.instructions.updated` event gets the `instructionSources` metadata OpenCode stores, so a live move reads like one loaded from history. A shown notice draws through `SessionNoticeBlock` as one folded row with an info icon (a `!command` that could not start takes the error icon) that opens to the text the model received. `attachSyntheticContext` places it: a notice that lands while a step runs becomes a row of that step, the final step included after it answers (the notice came before the step's `time.completed`) and also when a prompt was queued behind the running step; one that lands before the run's first step joins that step, and until the step exists turn projection keeps it in the prompt's turn (`TurnRecord.waitingNotices`, drawn by `TurnItem`), so it shows even when the run fails or is stopped before its first token and the turn stays the live tail. The row is a tool part only OpenChamber makes (`SESSION_NOTICE_TOOL`) that records whether it sits before or after the step's own parts, so Activity counts and trims it with the step's other rows and `MessageBody` draws it as a notice; `streamingTailEntry` puts these rows back before or after the step's live parts, and a turn whose only row is a notice gets no Activity fold (`hasLiveActivity`). A notice after an answer stays its own entry between turns; when a step follows, the last such notice opens that step's turn, as a hidden one did before, and a notice the answer took moves out of it to open that turn.
- Reasoning streaming presentation derives from the live stream phase (`streaming`/`cooldown`), never from missing persisted timing: a cached part without `time.end` is not live, and a part whose `time.end` is set never streams (issue #2020).
- Text that draws nothing takes no space (#5215). `lib/invisibleText.ts` supplies the shared test for whitespace and Unicode default-ignorable characters. Part renderers and turn projection use it for whole parts. `MarkdownArrivalBlock` omits an invisible-only streaming block before creating its wrapper; `remarkVisibleBlocks` in `streamdownPlugins.ts` filters top-level source ranges after disclosure reconstruction, including static rendering which bypasses that wrapper. Its source view omits the leading BOM as the parser does, so node offsets still identify the intended text. Both checks use the complete source block, so code fences and joiners inside visible text remain intact. The shared predicate avoids divergent definitions of empty text; CSS `:empty` cannot detect zero-width characters.
- Assistant text parts carry the same part-finalization gate (`assistantTextVisibility.ts`): the block-level reveal (`lib/streamTextCommit.ts`) holds a still-growing part's unfinished block, and the reply takes new text at most every 400 ms, while a part sealed with `time.end` renders in full immediately — including while the turn stays blocked on a pending question or permission ask (#3277).

## "I want to change description for Perplexity" (example recipe)

If task is: "change text shown near Read or Skill in compact mode":

1. Edit `ProgressiveGroup.tsx` -> `getToolShortDescription(activity)`.
2. Update the branch that handles `read` or `skill` in `StaticToolRow`.
3. Keep all other tool header/output behavior in `ToolPart.tsx`.
4. Keep icon changes (if any) in `toolPresentation.tsx`.

Why: only navigation tools use the compact static path; all other tools need observable input and output.

## "I want tool to become expandable" (example)

1. Update `toolRenderUtils.ts`:
   - add/remove a tool name from `STATIC_TOOL_NAMES` only when it has a reliable direct in-app navigation action
2. Ensure `ToolPart.tsx` supports desired header + expanded output format for that tool.
3. Validate with Activity Default set to Expanded and to Collapsed.

## Safe editing checklist

- Do not duplicate icon logic; keep it in `toolPresentation.tsx`.
- For static tool copy changes, prefer `ProgressiveGroup.tsx` first.
- For expanded output changes, edit `ToolPart.tsx`.
- After edits run:
  - `bun run type-check`
  - `bun run lint`
  - `bun run build`

## Quick map of files in this folder

- Text: `AssistantTextPart.tsx`, `UserTextPart.tsx`
- Attachment citations: the composer writes `[name.png]` into the text for each
  pasted or picked file. `UserTextPart` gets the message's file names and draws
  each citation of one of them as an inline chip with its file-type icon. The
  Markdown path rewrites it to a `#openchamber-attachment:` link
  (`lib/messages/inlineMessageLinks.ts`) that `markdown/MarkdownLink.tsx`
  renders as a chip; the plain-text path builds the same chip directly.
  Brackets around anything that is not an attachment stay text.
  In a sent message a citation opens what its attachment chip above the
  message opens: one resolver (`lib/messages/attachmentPreview.ts`) decides for
  both, and `message/useOpenAttachment.ts` carries it out per runtime. An image
  opens the viewer, text sent inline (a pasted text, a picked text file) the
  text dialog, a file attached by path (`file://`) the file itself, in the
  editor in VS Code and a Files tab elsewhere. A citation whose file opens
  nothing (a PDF sent inline, a folder) stays a label. Only `UserTextPart`
  makes chips clickable: `withAttachmentChips` draws labels unless the caller
  passes `isOpenable`, so the composer, the queue and context blocks get no
  dead tab stops. A click that ends a text selection over a chip leaves it
  closed.
  A known skill (`$name`, `/name` in messages sent before skills moved to
  `$`, or the yen and full-width spellings a CJK IME types for the same key)
  renders as the same chip with the book icon and still opens the skill file
  on click. The composer draws the same chips
  (`composer/editor/composerLanguage.ts`).
- User-attached context (inline code comments, terminal selections, browser
  annotations, PR comments/checks): `UserContextPart.tsx`. `UserTextPart`
  routes to it when the part's metadata carries an `openchamberContext`
  payload (see `lib/messages/contextParts.ts`, which owns both the send-time
  builder and the read-back parser). Linked source-control issues/change
  requests and tracker items are instead converted to link file-parts in
  `normalizeUserDisplayParts.ts`; a tracker item's part names its tracker in
  its type (`application/vnd.openchamber.tracker-item-link; provider=linear`)
  so the chip wears the tracker's mark, and Linear's older type still reads as
  Linear's. A `linear-issue` context payload from before trackers parses as a
  `tracker-item` of Linear (`lib/messages/contextParts.ts`). Legacy pre-metadata messages still render
  via text sniffing (`<terminal_context>` blocks, `GitHub issue context (JSON)`
  and `Linear issue context (JSON)` prefixes).
- Tools: `ToolPart.tsx`, `ToolPartDiffPreview.tsx`, `PlainDiffFallback.tsx`, `ProgressiveGroup.tsx`, `toolPresentation.tsx`, `toolRenderUtils.ts`, `ToolRevealOnMount.tsx`, `GuestToolTable.tsx`
- Reasoning: `ReasoningPart.tsx`
- Status/placeholders: `WorkingPlaceholder.tsx`, `SessionActiveSpinner.tsx`, `MigratingPart.tsx`; the dots after a busy label are `components/ui/busy-dots.tsx`
- Utility renderers: `VirtualizedCodeBlock.tsx`, `MinDurationShineText.tsx`
