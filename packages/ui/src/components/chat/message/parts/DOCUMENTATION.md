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
  - Task tools (`task`) show `AgentAvatar` + subagent nickname (`input.subagent_type`) in the
    leading icon column (same slot as the expand chevron). Idle = avatar; hover = chevron only when
    Settings → Visual → "Show Sub-agent Work Details" (`showSubagentTaskDetails`) is on.
  - That setting defaults **off**: no vertical task-summary rail. Clicking the compact row always
    opens the sub-agent session (context panel / mobile session switch), including while the task
    is still loading — if the child session id is delayed, the click is queued until it arrives.
    When details are on, the rail + output expand UI return (expand via the leading chevron), and
    child-session summary fetches run again; the row click still opens the sub-agent.
  - While a task is active, title + description use `animate-text-shimmer` (same loading highlight as
    thinking traces). Subagent names need not appear in the main agent picker — the identicon only
    seeds from the name string.
  - If you want to change expandable tool layout, edit here.

- `toolPresentation.tsx`
  - Shared icon mapping for tool names (`getToolIcon`).
  - Used by both `ProgressiveGroup.tsx` and `ToolPart.tsx`.

- `toolRowChrome.ts`
  - Shared Codex-style rounded chip classes for interactive tool / reasoning headers.
  - Hover-only wash matches sidebar session-row hover (`surface-foreground` color-mix); idle rows stay flush.
  - Tight `py-0.5` + `my-1.5` keeps row height compact while spacing tool rows apart; `-mx-2` cancels `px-2` so hover wash expands without shifting icons (message body must not `overflow-hidden` or the wash radius gets clipped); `oc-tool-row` keeps pointer cursor on desktop.
  - `TOOL_ROW_CHIP_GEOMETRY_CLASS` (`rounded-lg px-2 py-0.5`) is shared with assistant info/status chips so radius + padding stay consistent.
  - Also exports composer chrome (`SELECTOR_CHIP_HOVER_CLASS`, `COMPOSER_TRIGGER_CHROME_CLASS`, `COMPOSER_ICON_HOVER_CLASS`) for draft project/branch selectors and input footer controls.
  - Used by `ToolPart.tsx`, `ReasoningPart.tsx`, `ProgressiveGroup.tsx`, `ChatInput.tsx`, and `ModelControls.tsx`.

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

- `read` and `skill` are **static navigation tools** and render via `StaticToolRow`.
- `edit` / `multiedit` / `apply_patch` / `write` stay in `ToolPart` for title + path + diff-stats chrome, but are **non-expandable file navigation**: click opens the file at the first changed line in the right context panel (or VS Code editor). No chevron / expanded diff body.
- Every other tool, including search/fetch, OpenCode built-ins, custom tools, plugins, and MCP tools, is **expandable** and renders through `ToolPart`.
- `ToolPart` defers expanded content after a user toggle, preventing large tool input/output payloads from mounting during the initial chat render.
- Virtualized history uses a `MarkdownHydrationProvider` per stable turn entry. The newest visible turns are released first, from bottom to top; upward scrolling additionally preloads only the nearest three mounted turns above the viewport.
- Historical Markdown/tool hydration state updates run in React transitions. Hiding the owning `Activity` cancels queued frame work and aborts the Markdown pipeline before subsequent blocks can parse or commit.
- Shiki worker requests carry an `AbortSignal` plus `visible`/`background` priority. Cancelled hidden-session jobs are removed before they start, while current visible work overtakes queued historical highlighting. A Shiki call already executing is the single non-preemptible worker unit; its cancelled result is discarded.
- Historical Markdown that has not been released renders a bounded skeleton over an invisible `white-space: pre-wrap` size spacer. Raw Markdown syntax is never visually exposed, while the spacer preserves approximately the same pre-hydration row height. It does not mount the lazy rich renderer, run marked/DOMPurify/decoration, or attach Markdown interactions yet.
- After a row is released, the first layout pass sync-paints Markdown and reveals before the browser paints (so a streaming-tail → history remount does not flash the skeleton over already-rendered content). Async morphdom still upgrades to the rich DOM afterward. The target subtree remains exclusively imperative-owned.
- Hydration state is keyed by stable turn/message entry keys rather than virtual indexes, so prepending older pages does not shift the wrong rows into the hydrated set. The newest entry stays hydrated immediately; streaming-tail Markdown remains immediate.
- Thinking/Justification duration is hidden in `sorted` mode (handled in `ReasoningPart.tsx` + `JustificationBlock.tsx`).

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
- Keep historical Markdown scheduling at the `MessageList` entry boundary. Do not add one `IntersectionObserver` per Markdown block or reverse virtual-row DOM order.
- After edits run:
  - `bun run type-check`
  - `bun run lint`
  - `bun run build`

## Quick map of files in this folder

- Text: `AssistantTextPart.tsx`, `UserTextPart.tsx`
- Tools: `ToolPart.tsx`, `ProgressiveGroup.tsx`, `toolPresentation.tsx`, `toolRowChrome.ts`, `toolRenderUtils.ts`, `ToolRevealOnMount.tsx`
- Reasoning/justification: `ReasoningPart.tsx`, `JustificationBlock.tsx`
- Status/placeholders: `WorkingPlaceholder.tsx`, `SessionActiveSpinner.tsx`, `MigratingPart.tsx`, `BusyDots.tsx`
- Utility renderers: `VirtualizedCodeBlock.tsx`, `MinDurationShineText.tsx`
