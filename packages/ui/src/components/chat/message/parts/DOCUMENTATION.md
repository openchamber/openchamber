# Chat Message Parts: Rendering Architecture

This folder contains renderers for chat message parts (text, tools, reasoning, placeholders) and shared tool presentation helpers.

Use this doc when you ask an agent to change tool/header/description behavior.

## High-level flow

- Message parts are rendered from `MessageBody.tsx`.
- There are two tool rendering paths:
  - **Static grouped tools** -> `StaticToolRow` in `ProgressiveGroup.tsx`
  - **Expandable tools** -> `ToolPart.tsx`
- Shared tool icon mapping is centralized in `toolPresentation.tsx` (`getToolIcon`).

## Which file controls what

- `ProgressiveGroup.tsx`
  - Renders grouped Activity rows and grouped static tools.
  - Contains `StaticToolRow`.
  - Contains static tool short description logic (`getToolShortDescription`).
  - If you want to change how `read/grep/perplexity/webfetch/...` look in compact/grouped mode, edit here.

- `ToolPart.tsx`
  - Renders expandable tool rows (shell/edit/write/question/subagent + fallback).
  - Controls expandable header title/description/diff stats/timer and expanded output body.
  - If you want to change expandable tool layout, edit here.

- `taskToolModel.ts`
  - Owns subagent metadata parsing and child-session summary projection.
  - `part.state.metadata.sessionID` is the only live identity contract between a `subagent` call and its child session.
  - A running subagent may briefly have no session id; render it as waiting until the authoritative part update arrives. Never match parallel children by order, title, timestamp, or status.
  - Part-level metadata and output parsing exist only for older persisted records and never override state metadata.

- `toolPresentation.tsx`
  - Shared icon mapping for tool names (`getToolIcon`).
  - Used by `ProgressiveGroup.tsx`, `ToolPart.tsx`, and `ToolOutputDialog.tsx`.
  - Takes an optional extension rule (below) whose `icon` wins when the sprite carries it.

- Tool names, per-tool input/metadata fields, and the row description are owned by `@/lib/opencode/tools`. Branch on its predicates (`isShellTool`, `isSubagentTool`, `isFileChangeTool`, ...) instead of comparing tool names here; v2 has no `state.title`, so a row's description comes from `toolDescription(tool, input, metadata)`. Every v2 built-in answers from its own input before its result lands: `patch` from the `*** Update File:` headers of its text until `metadata.files` arrives, `skill` from its `id`, and the `opencode.*` namespace tools (`session_rename`, `session_move`, `models`) from their title, directory or search; `getToolMetadata` resolves a namespaced name by its last segment.

- Extension tool presentations (`contributes.tools` in a guest manifest)
  - The registry is `lib/guests/tool-presentation.ts`: `useGuestToolPresentation(part.tool)` / `resolveGuestToolPresentation` return the first matching rule of an active guest (exact `match` beats a suffix wildcard; first extension wins) or `null`. Rules are compiled once per catalog array; each part does one linear scan.
  - The lookup always gets the **full** tool name OpenCode reported (`mcp.jira.search`); `normalizeToolName` still feeds every built-in switch, so built-in behavior is untouched when there is no rule.
  - Hook points, each falling back to today's code when the rule is `null` or silent on that field: icon (`getToolIcon`), header title (`title` template, else `name`, else `getToolMetadata`), header subtitle (`subtitle` template replaces both the description and the justification text), and the expanded body (`output`: `text` / `code` / `json` / `markdown` / `table`, checked at the top of `renderResultContent` and inside `ToolScrollableTextOutput`; `auto` keeps detection). A `table` whose output is not an array or `{ items: [] }` falls through to detection.
  - `GuestToolTable.tsx` draws the table with the same cell classes the markdown decorator gives assistant tables, capped at 200 rows with a count line.
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
setting) use the tool-result file identities, in first-touch order, with paths
as the tools reported them (v2 assistant messages carry no working directory).
Line counts come from each call's patch; a file with no recoverable counts
shows its name alone. Every pill opens the turn diff: OpenCode 2 computes it on
request (`GET /api/session/:id/diff`, `DiffView`'s "Last turn" scope) from the
turn's start and end snapshots, merged per file, so it also covers a `write`
result and the edits a `subagent` made in its child session, which the pills
themselves cannot list. The list is projected once the last assistant message
finished with `stop`, so no tool patch is parsed while the turn streams.

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
- `ToolPart` defers expanded content after a user toggle, preventing large tool input/output payloads from mounting during the initial chat render.
- The rich tool diff preview lives in `ToolPartDiffPreview.tsx` and is lazy-loaded from `ToolPart`. It is the only tool-card piece that imports the `@pierre/diffs` + Shiki rendering stack, keeping that stack out of the eager chat startup graph. While its chunk loads (first rendered diff only) the plain-text patch from `PlainDiffFallback.tsx` renders as the Suspense fallback, mirroring the preview's error fallback. Patches over 256 KiB or 2,000 lines skip rich parsing and use a bounded plain-text preview; navigation keeps the original patch. `ToolPart` itself must not statically import `@pierre/diffs` runtime modules or `@/lib/shiki/appThemeRegistry`.
- The `@pierre/diffs` stack is knowingly unprotected against the JS/TS `template-call` backtracking that OOM'd the renderer in openchamber/openchamber#2587. Our own markdown Shiki worker sanitizes every grammar it loads (`@/lib/shiki/sanitizeTemplateCallGrammar`), but the diff worker pool runs `preferredHighlighter: 'shiki-wasm'` (`DiffWorkerProvider.tsx`) and resolves its languages by id through `@pierre/diffs`' own registry — `langs` accepts `SupportedLanguages` strings only, so there is no seam to hand it a pre-sanitized `LanguageRegistration`. A pathological template literal inside a rendered diff can therefore still hang that pool's Oniguruma engine. The available levers are upstream (a `langs` overload accepting grammar objects) or switching that pool to the JS regex engine; neither is done.
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
- Thinking/Justification duration is hidden in `sorted` mode (handled in `ReasoningPart.tsx` + `JustificationBlock.tsx`).
- Reasoning streaming presentation derives from the live stream phase (`streaming`/`cooldown`), never from missing persisted timing: a cached part without `time.end` is not live, and a part whose `time.end` is set never streams (issue #2020).

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
- For static tool copy changes, prefer `ProgressiveGroup.tsx` first.
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
- Tools: `ToolPart.tsx`, `ToolPartDiffPreview.tsx`, `PlainDiffFallback.tsx`, `ProgressiveGroup.tsx`, `toolPresentation.tsx`, `toolRenderUtils.ts`, `ToolRevealOnMount.tsx`, `GuestToolTable.tsx`
- Reasoning/justification: `ReasoningPart.tsx`, `JustificationBlock.tsx`
- Status/placeholders: `WorkingPlaceholder.tsx`, `SessionActiveSpinner.tsx`, `MigratingPart.tsx`, `BusyDots.tsx`
- Utility renderers: `VirtualizedCodeBlock.tsx`, `MinDurationShineText.tsx`
