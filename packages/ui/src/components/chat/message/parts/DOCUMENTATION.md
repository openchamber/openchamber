# Chat Message Parts: Rendering Architecture

This folder contains renderers for chat message parts (text, tools, reasoning, placeholders) and shared tool presentation helpers.

Use this doc when you ask an agent to change tool/header/description behavior.

## High-level flow

- Message parts are rendered from `MessageBody.tsx`.
- There are two tool rendering paths:
  - **Expandable named tools** -> `ToolPart.tsx`
  - **Compact fallback rows** -> `StaticToolRow` in `ProgressiveGroup.tsx` for legacy or malformed tool records
- Shared tool icon mapping is centralized in `toolPresentation.tsx` (`getToolIcon`).

## Which file controls what

- `ProgressiveGroup.tsx`
  - Renders grouped Activity rows and compact fallback tool rows.
  - Contains `StaticToolRow`.
  - Contains static tool short description logic (`getToolShortDescription`).
  - If you want to change compact fallback copy, edit here.

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
    - `isStandaloneTool`
  - If a tool should switch between standalone vs expandable, change it here.

- `ReasoningPart.tsx`
  - Thinking block UI (`ReasoningTimelineBlock`), summary + optional duration.

- `JustificationBlock.tsx`
  - Justification block wrapper over `ReasoningTimelineBlock`.

## Current important behavior

- All non-empty, non-task tool names are **expandable tools** and render via `ToolPart`.
- `task` is standalone and handled by its dedicated rendering flow.
- Thinking/Justification duration is hidden in `sorted` mode (handled in `ReasoningPart.tsx` + `JustificationBlock.tsx`).

## "I want to change description for Perplexity" (example recipe)

If task is: "change text shown near Perplexity tool header/description":

1. Edit `ToolPart.tsx` for the expanded header or body.
2. If the compact fallback row also needs the copy, edit `ProgressiveGroup.tsx` -> `getToolShortDescription(activity)`.
3. Keep icon changes (if any) in `toolPresentation.tsx`.

Why: named tools, including Perplexity-style tools, render through `ToolPart`.

## "I want tool to become expandable" (example)

1. Update `toolRenderUtils.ts`:
   - add/remove standalone exclusions as needed
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
- Status/placeholders: `WorkingPlaceholder.tsx`, `SessionActiveSpinner.tsx`, `MigratingPart.tsx`, `BusyDots.tsx`
- Utility renderers: `VirtualizedCodeBlock.tsx`, `MinDurationShineText.tsx`
