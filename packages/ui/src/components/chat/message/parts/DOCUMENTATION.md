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
  - Renders expandable tool rows (bash/edit/write/question/task + fallback).
  - Controls expandable header title/description/diff stats/timer and expanded output body.
  - If you want to change expandable tool layout, edit here.

- `toolPresentation.tsx`
  - Shared icon mapping for tool names (`getToolIcon`).
  - Used by both `ProgressiveGroup.tsx` and `ToolPart.tsx`.

- `toolRenderUtils.ts`
  - Core classification helpers:
    - `isExpandableTool`
    - `isStaticTool`
    - `isStandaloneTool`
    - `getStaticGroupToolName`
  - If a tool should switch between static vs expandable, change it here.

- `ReasoningPart.tsx`
  - Thinking block UI (`ReasoningTimelineBlock`), summary + optional duration.

- `JustificationBlock.tsx`
  - Justification block wrapper over `ReasoningTimelineBlock`.

## Current important behavior

- `read` and most search/fetch tools are treated as **static tools** and usually render via `StaticToolRow`.
- `bash/edit/write/question/task` are **expandable tools** and render via `ToolPart`.
- `perplexity` is currently treated as static and grouped into search/web-search style rows (through static grouping + short description extraction).
- Thinking/Justification duration is hidden in `sorted` mode (handled in `ReasoningPart.tsx` + `JustificationBlock.tsx`).

## "I want to change description for Perplexity" (example recipe)

If task is: "change text shown near Perplexity tool header/description":

1. Edit `ProgressiveGroup.tsx` -> `getToolShortDescription(activity)`.
2. Update the branch that handles web-search tools (`websearch`, `web-search`, `search_web`, `codesearch`, `perplexity`, etc.).
3. If needed, update group rendering in `StaticToolRow` (search/fetch specific rendering branches).
4. Keep icon changes (if any) in `toolPresentation.tsx`.

Why: in current pipeline Perplexity is static/grouped, so `StaticToolRow` is the primary path.

## "I want tool to become expandable" (example)

1. Update `toolRenderUtils.ts`:
   - add/remove tool name in `EXPANDABLE_TOOL_NAMES`
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
- Tools: `ToolPart.tsx`, `ProgressiveGroup.tsx`, `toolPresentation.tsx`, `toolRenderUtils.ts`, `ToolRevealOnMount.tsx`
- Reasoning/justification: `ReasoningPart.tsx`, `JustificationBlock.tsx`
- Status/placeholders: `WorkingPlaceholder.tsx`, `GenericStatusSpinner.tsx`, `SessionActiveSpinner.tsx`, `MigratingPart.tsx`
- Utility renderers: `VirtualizedCodeBlock.tsx`, `MinDurationShineText.tsx`
