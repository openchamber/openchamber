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

- `JustificationBlock.tsx`
  - Justification block wrapper over `ReasoningTimelineBlock`.

## Current important behavior

- `read` and `skill` are **static navigation tools** and render via `StaticToolRow`.
- Every other singleton tool, including search/fetch, OpenCode built-ins, custom tools, plugins, and MCP tools, is **expandable** and renders through `ToolPart`.
- Consecutive runs of two or more canonical context tools render through `ContextToolGroupRow` instead of their singleton presentation.
- `ToolPart` defers expanded content after a user toggle, preventing large tool input/output payloads from mounting during the initial chat render.
- Thinking/Justification duration is hidden in `sorted` mode (handled in `ReasoningPart.tsx` + `JustificationBlock.tsx`).

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
- Tools: `ToolPart.tsx`, `ProgressiveGroup.tsx`, `ContextToolGroupRow.tsx`, `toolSegmentProjection.ts`, `toolPresentation.tsx`, `toolRenderUtils.ts`, `ToolRevealOnMount.tsx`
- Reasoning/justification: `ReasoningPart.tsx`, `JustificationBlock.tsx`
- Status/placeholders: `WorkingPlaceholder.tsx`, `SessionActiveSpinner.tsx`, `MigratingPart.tsx`, `BusyDots.tsx`
- Utility renderers: `VirtualizedCodeBlock.tsx`, `MinDurationShineText.tsx`
