# Chat Message Parts: Rendering Architecture

This folder contains renderers for chat message parts (text, tools, reasoning, placeholders) and shared tool presentation helpers.

Use this doc when you ask an agent to change tool/header/description behavior.

## High-level flow

- Message parts are rendered from `MessageBody.tsx`.
- Tool rendering has two callers that must stay aligned:
  - **Flat message path** -> `MessageBody.tsx`
  - **Activity path** -> `ProgressiveGroup.tsx` via `TurnActivity`
- Both paths consume `projectToolSegmentRows` from `toolSegmentProjection.ts` for tool segment projection.
- Rendered tool rows are one of:
  - **Context tool groups** -> `ContextToolGroupRow.tsx`
  - **Static tools** -> `StaticToolRow` in `ProgressiveGroup.tsx`
  - **Expandable tools** -> `ToolPart.tsx`
- Shared tool icon mapping is centralized in `toolPresentation.tsx` (`getToolIcon`).

## Which file controls what

- `ProgressiveGroup.tsx`
  - Renders grouped Activity rows, context tool groups, and static tools.
  - Contains `StaticToolRow`.
  - Contains static tool short description logic (`getToolShortDescription`).
  - Flushes tool segments through `projectToolSegmentRows` and flushes again on reasoning/justification boundaries.
  - If you want to change how non-context static tools such as `perplexity/webfetch/...` look in compact mode, edit here.

- `ContextToolGroupRow.tsx`
  - Presentation row for consecutive runs of two or more context tools.
  - Renders a controlled, default-collapsed disclosure. Its header contains only the arrow, localized active/done/error title, and counts; expanded content contains ordered lightweight child rows.
  - Receives `isExpanded` and `onToggle` from its caller. It must not own local expansion state or inspect/render tool output.
  - Uses projected child rows only; it must not re-own whitelist, status, counts, ordering, or hint extraction.

- `toolSegmentProjection.ts`
  - Pure presentation projection for consecutive tool segments.
  - Exports `projectToolSegmentRows` and row types used by both flat and Activity paths.
  - Owns context-run boundaries and flush behavior, status aggregation, counts, ordered child hints/states, keys, and render signatures.
  - Does not render React, generate i18n copy, choose theme/icon styling, subscribe to stores, or define turn/source models.

- `ToolPart.tsx`
  - Renders expandable tool rows (bash/edit/write/question/task + fallback).
  - Controls expandable header title/description/diff stats/timer and expanded output body.
  - Always loads an available Agent Task child session, including finalized tasks with metadata, then calls `projectTaskSummary`. It does not flatten child messages or reimplement live-versus-fallback source priority, context boundaries, preview accounting, or nested group keys.
  - If you want to change expandable tool layout, edit here.

- `taskToolModel.ts`
  - Owns Task metadata parsing and child-session summary projection.
  - `part.state.metadata.sessionId` is the only live identity contract between a Task and its child session.
  - A running Task may briefly have no `sessionId`; render it as waiting until the authoritative part update arrives. Never match parallel children by order, title, timestamp, or status.
  - Part-level metadata and output parsing exist only for older persisted records and never override state metadata.
- `taskSummaryProjection.ts`
  - Pure Agent Task summary projection Module. Its `projectTaskSummary` Interface is the sole seam for Task summary source priority, preserved live-message boundaries, namespaced nested keys, ordinary-row mapping, context grouping, preview selection, hidden action accounting, and render signatures.
  - Receives original child session messages and metadata fallback together. Renderable live rows win over metadata fallback. Fallback metadata is projected as independent ordinary rows because it does not retain separators.
   - Live `read`, `grep`, `glob`, exact local `search`, and `list` use `projectToolSegmentRows`: one canonical action remains an ordinary task entry; contiguous runs of two or more become the existing `ContextToolGroupRow`. Hidden reasoning within consecutive assistant messages does not interrupt a context run. Non-empty text, nested `task`, `todowrite`, `todoread`, and every non-assistant message are hard non-rendered separators. Assistant message IDs are not separators.
  - Projects groups before the six-display-row preview. Hidden count is the number of original actions represented by hidden rows, so a hidden context group contributes all of its children. Expansion state remains owned by the parent message's `expandedTools`; this Module owns no state.
  - Live identities include child message ID and part index even when a supplied part ID exists, so duplicate supplied IDs cannot collide. Fallback metadata identities include their ordered fallback index; fallback order is append-only for a task summary.
  - Ordinary rows normalize source statuses to `active`, `error`, or `done`. Terminal failure statuses (`error`, `failed`, `aborted`, `timeout`, `cancelled`) render as errors, and a non-empty tool error message becomes the row label before title/path metadata.

- `toolPresentation.tsx`
  - Shared icon mapping for tool names (`getToolIcon`).
  - Used by both `ProgressiveGroup.tsx` and `ToolPart.tsx`.

- `toolRenderUtils.ts`
  - Core classification helpers:
    - `isExpandableTool`
    - `isStaticTool`
    - `isStandaloneTool`
    - `getContextToolSummaryKind`
   - Owns exact canonical context classification (`read`, `grep`, `glob`, local `search`, `list`); qualified and indexed aliases remain ordinary tools.
  - If a tool should switch between static vs expandable, change it here.

- `ReasoningPart.tsx`
  - Thinking block UI (`ReasoningTimelineBlock`), summary + optional duration.

- `components/LiveTurnActivity.tsx` (relative to the chat folder)
  - Owns the optional live-only turn disclosure. `MessageList` enables it when
    Activity Default is Collapsed and the turn has visible Activity content.
  - `components/LiveActivityCollapse.tsx` owns the finite height transition;
    `components/liveActivityContext.ts` scopes the final message's non-text
    disclosure without changing sorted message context or tool rendering.
  - `lib/turns/liveActivity.ts` owns final-answer and interruption boundaries.
  - `lib/turns/liveActivitySummary.ts` derives the report from tool results.

- `JustificationBlock.tsx`
  - Justification block wrapper over `ReasoningTimelineBlock`.

## Current important behavior

### Optional live history disclosure

Activity Default is shared by the settings UI in both render modes. In live
mode, Expanded preserves the original timeline without a turn disclosure.
Collapsed adds one Activity header after completion or interruption while preserving the original live rows,
their order, and their individual controls. It adds no tool subgroups, side
line, height cap, or inner scroller. Sorted rendering keeps its existing path
and its own per-turn expansion state.

The active turn stays open without an Activity header. A final assistant message with `finish: stop`
collapses the earlier messages and the final message's non-text parts, keeping
the answer and its existing footer outside. Intermediate-text summary fallback
and compaction summaries never become final answers. An older turn without a
final answer collapses once a later visible turn has an assistant response;
a queued user message alone is not enough. Hidden user continuations retain
the visible-turn mapping established by `projectTurnRecords`.

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
history. The Bun patch for `@legendapp/list@3.3.10` stores that padding's CSSOM
read-back value: Chromium rounds fractional pixel strings, so comparing the
original input with `style.paddingBottom` can skip cleanup permanently. This
leaves a phantom tail even when every Activity region is already zero-height.
The patch covers both web entry points in ESM and CJS; its installed-controller
regression tests live in `scripts/legend-list-padding.test.mjs`. Retain this
fix when updating the dependency unless upstream has equivalent ownership and
cleanup behavior. Chat padding and scroll policies do not compensate for it.

The header retains its report when expanded and has no hover background. Its
left inset matches sorted Activity. Diff deletions use the ASCII hyphen.
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
setting) use the same tool-result file identities, in first-touch order, with
paths relative to the message's project root. The user message's
`summary.diffs` is a working-tree snapshot between turn start and end, so it
also lists edits made by other sessions or by hand in the same directory; it
never decides which files belong to the turn on its own. It supplies a touched
file's line counts, because those match the turn diff a pill opens; a file the
snapshot does not list falls back to its tool patch and renders as a plain
chip, since the turn diff has nothing to open for it. A file with no
recoverable counts, or a snapshot entry without line changes, shows its name
alone. One exception: edits delegated to `task` subagents live in child
sessions the projection cannot see, so when a turn ran subagents the snapshot
entries no own tool call touched are appended after the turn's own files. The
list is projected once the last assistant message finished with `stop`, so no
tool patch is parsed while the turn streams.

### Message parts

- Assistant markdown treats raw HTML as inert visible text. The final generated
  HTML is sanitized as defense in depth, with script and style elements
  forbidden, so message content cannot inject active DOM or application-wide
  CSS into any runtime surface. Safe custom application links go through the
  app-link confirmation flow in every supported renderer, including VS Code.
- Final assistant Markdown rendering is independent from image gallery
  extraction: gallery presence never changes the chat body. Assistant image
  syntax consistently renders as a shared image icon followed by its filename,
  without loading the image in the body; tool and simple Markdown retain normal
  inline image rendering. The gallery separately collects HTTP(S), embedded, and workspace-local
  PNG/JPEG/GIF/WebP image candidates into one 100px thumbnail gallery in the
  message-completion area after all message text and above the turn's changed
  files. Each muted filename caption includes the shared image-file icon.
  HTTP(S) images keep their browser URL. Embedded and workspace-local images
  are limited to 10 MiB and validated as PNG/JPEG/GIF/WebP. Chat Markdown uses
  the assistant image-label policy without gallery-specific link rewriting,
  completion-state switching, or hidden placeholders. A
  completed assistant message hydrates at most 12 unique image candidates,
  including persisted text parts that omit their optional part-level end time.
  In server-backed runtimes, a gallery approaching the viewport prepares all
  local candidates in one message-level request, then reuses the authenticated
  `/api/fs/raw` asset route. Each URL loads only when its thumbnail approaches
  the viewport. VS Code instead loads workspace-contained images through its
  local filesystem bridge and never calls the server grant route; OpenCode
  temporary-directory images remain unsupported there. Mounted historical
  messages therefore do not eagerly read every image.
  Gallery clicks do not introduce or alter preview chrome: desktop and mobile
  both reuse the pre-existing attachment image preview overlay.
  Workspace-external images receive the existing path-bound `outsideFileGrant`
  only when the server verifies the exact source in the owning assistant
  message and the real file is inside OpenCode's dedicated temporary directory.
- `read` and `skill` are **static navigation tools** and render via `StaticToolRow`.
- Every other tool, including search/fetch, OpenCode built-ins, custom tools, plugins, and MCP tools, is **expandable** and renders through `ToolPart`.
- The managed `openchamber` plugin tool uses the expandable path and hides its broad protocol input. The plugin supplies the selected action's human description as the native tool title; the UI renders that metadata without owning an action map. The full versioned result envelope renders through the same neutral JSON summary/tree/raw views as other tools, without a tool-specific output card.
- Selecting a JSON summary, tree, or raw view saves that mode in the persisted UI settings. New and refreshed JSON tool outputs read the saved mode across sessions; missing or invalid preferences use Summary.
- Consecutive runs of two or more canonical context tools render through `ContextToolGroupRow` instead of their singleton presentation.
- `ToolPart` defers expanded content after a user toggle, preventing large tool input/output payloads from mounting during the initial chat render.
- The rich tool diff preview lives in `ToolPartDiffPreview.tsx` and is lazy-loaded from `ToolPart`. It is the only tool-card piece that imports the `@pierre/diffs` + Shiki rendering stack, keeping that stack out of the eager chat startup graph. While its chunk loads (first rendered diff only) the plain-text patch from `PlainDiffFallback.tsx` renders as the Suspense fallback, mirroring the preview's error fallback. Patches over 256 KiB or 2,000 lines skip rich parsing and use a bounded plain-text preview; navigation keeps the original patch. `ToolPart` itself must not statically import `@pierre/diffs` runtime modules or `@/lib/shiki/appThemeRegistry`.
- The `@pierre/diffs` stack is knowingly unprotected against the JS/TS `template-call` backtracking that OOM'd the renderer in openchamber/openchamber#2587. Our own markdown Shiki worker sanitizes every grammar it loads (`@/lib/shiki/sanitizeTemplateCallGrammar`), but the diff worker pool runs `preferredHighlighter: 'shiki-wasm'` (`DiffWorkerProvider.tsx`) and resolves its languages by id through `@pierre/diffs`' own registry — `langs` accepts `SupportedLanguages` strings only, so there is no seam to hand it a pre-sanitized `LanguageRegistration`. A pathological template literal inside a rendered diff can therefore still hang that pool's Oniguruma engine. The available levers are upstream (a `langs` overload accepting grammar objects) or switching that pool to the JS regex engine; neither is done.
- Running bash output falls back to `state.metadata.output` until canonical `state.output` arrives. Its output viewport grows with the content up to `46vh`, then scrolls and follows new output until the user scrolls up; following resumes when the user returns to the bottom. Live output appends or replaces rewritten snapshots as plain text without worker highlighting; finalized output normalizes ANSI terminal controls with a bounded synthetic-cell budget, bypasses the throttle, and receives the normal one-time highlighted rendering.
- Thinking/Justification duration is hidden in `sorted` mode (handled in `ReasoningPart.tsx` + `JustificationBlock.tsx`).
- Reasoning streaming presentation derives from the live stream phase (`streaming`/`cooldown`), never from missing persisted timing: a cached part without `time.end` is not live, and a part whose `time.end` is set never streams (issue #2020).

## Context Tool Group

- `ContextToolGroup` is a tool segment presentation projection. It is not a turn model, source model, SDK part, sync-store state, runtime API, or server API.
- `toolRenderUtils.ts` owns the narrow canonical context classifier: exactly `read`, `grep`, `glob`, OpenChamber's evidenced local `search` alias, and `list` after trim/lowercase only. The sampled upstream canonical set was `read`, `grep`, `glob`, and `list`; this local alias does not admit web/provider tools such as `websearch`, `codesearch`, `search_web`, or `web-search`, nor qualified/indexed names such as `plugin.search` or `search:2`.
- `projectToolSegmentRows` consumes that classifier and owns context-run boundaries, status, counts, child order, keys, and render signatures in both flat and Activity rendering.
- A consecutive canonical context run renders as a default-collapsed `ContextToolGroupRow` only when it contains two or more tools. A single canonical context tool keeps its existing singleton presentation (`read` remains static; `grep`, `glob`, local `search`, and `list` remain expandable).
- `grep`, `glob`, and exact local `search` count as `search`; `read` counts as `read`; `list` counts as `list`.
- `bash`, `edit`, `write`, `apply_patch`, `task`, `webfetch`, `skill`, todo tools, and unknown tools do not enter context groups.
- In flat and Activity rendering, a context run continues only across consecutive assistant messages when its canonical tools are consecutive in the rendered activity sequence. Any non-assistant message immediately flushes the run; actual text, reasoning, justification, non-tool, or non-context-tool boundaries also flush it. Agent Task summary projection is the explicit hidden-reasoning exception described below.
- Group status is projected centrally: active/error/done, with error taking precedence over active.
- The collapsed header always retains active/error status, with error taking precedence. Expanded child rows retain projected source order and show only tool kind, hint, and active/error state; never render full `state.output`.
- A multi-tool group key is anchored to the first child (`context-tool-group:<first-child-id>`). Both flat and Activity paths read and toggle that key through the message-owned `expandedTools`. Streaming from one context tool to two changes from a singleton row to a group; this one remount is intentional because a singleton has no group state.
- Agent Task group keys are additionally namespaced by the parent task part ID (`task-summary:<task-part-id>:context-tool-group:<first-child-id>`) so two tasks in one message cannot collide. Every live child identity includes its message ID and part index, with a supplied part ID retained only as an optional informative suffix.
- `renderSignature` is the memo/comparator contract for render-relevant projected data; update it whenever row-visible child data changes.
- In flat and Activity rendering, `bash`, `shell`, `edit`, `write`, and `apply_patch` remain their ordinary `ToolPart` disclosures. Inside an Agent Task summary they remain lightweight independent task-entry rows; they never render a nested `ToolPart` disclosure.

### Hidden Reasoning Boundary

- This boundary applies only to flat and Activity projection. Activity receives full segment parts, flushes tool segments when reasoning appears, and only then decides whether to render the reasoning row based on `showReasoningTraces`. Flat projection does not cross non-tool part boundaries because its tool segment loop only advances across consecutive `part.type === 'tool'` entries. Do not filter hidden reasoning before either projection in a way that would let `read -> hidden reasoning -> grep` merge into one context group.
- Agent Task summary projection is the explicit exception: hidden reasoning inside consecutive assistant messages does not flush its context-tool run. A non-assistant message, non-empty assistant text, nested `task`/todo tool, or ordinary non-context action still flushes that run.

### i18n, Theme, Icons, Tests

- New visible text for context groups must use `useI18n()` / `t(...)` and be present in every main locale dictionary.
- Use theme/status CSS variables such as `--tools-*` and `--status-*`; do not add hardcoded colors or Tailwind status color classes.
- Use the shared `Icon` component; never import `@remixicon/react` directly.
- Keep projection behavior covered in `toolSegmentProjection.test.ts` and locale coverage in `contextToolGroup.test.ts`.
- Keep executable coverage in the projection, locale, and `ContextToolGroupRow.test.tsx` static-render tests. Manually review native trigger interaction semantics that server rendering cannot exercise: click, Enter, Space, focus, and state retention while appending children.

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
3. Validate both modes (`sorted` and `live`).

## Safe editing checklist

- Do not duplicate icon logic; keep it in `toolPresentation.tsx`.
- Do not duplicate context grouping rules; keep whitelist/flush/status/counts/child hints/render signatures in `projectToolSegmentRows`.
- For non-context static tool copy changes, prefer `ProgressiveGroup.tsx` first.
- For context group row copy, use i18n keys consumed by `ContextToolGroupRow.tsx`.
- For expanded output changes, edit `ToolPart.tsx`.
- After edits run:
  - `bun run type-check`
  - `bun run lint`
  - `bun run build`

## Quick map of files in this folder

- Text: `AssistantTextPart.tsx`, `UserTextPart.tsx`
- User-attached context (inline code comments, terminal selections, browser
  annotations, PR comments/checks): `UserContextPart.tsx`. `UserTextPart`
  routes to it when the part's metadata carries an `openchamberContext`
  payload (see `lib/messages/contextParts.ts`, which owns both the send-time
  builder and the read-back parser). Linked GitHub issues/PRs and Linear
  issues are instead converted to link file-parts in
  `normalizeUserDisplayParts.ts`. Legacy pre-metadata messages still render
  via text sniffing (`<terminal_context>` blocks, `GitHub issue context (JSON)`
  and `Linear issue context (JSON)` prefixes).
- Tools: `ToolPart.tsx`, `ToolPartDiffPreview.tsx`, `PlainDiffFallback.tsx`, `ProgressiveGroup.tsx`, `toolPresentation.tsx`, `toolRenderUtils.ts`, `ToolRevealOnMount.tsx`
- Reasoning/justification: `ReasoningPart.tsx`, `JustificationBlock.tsx`
- Status/placeholders: `WorkingPlaceholder.tsx`, `SessionActiveSpinner.tsx`, `MigratingPart.tsx`, `BusyDots.tsx`
- Utility renderers: `VirtualizedCodeBlock.tsx`, `MinDurationShineText.tsx`
