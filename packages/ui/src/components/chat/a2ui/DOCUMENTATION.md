# A2UI Surfaces

## Ownership

This module owns OpenChamber's lightweight native renderer for the A2UI (Agent-to-User Interface) v0.9/v0.10 wire protocol: JSONL and JSON-array envelope parsing (`protocol.ts`), reactive JSON-Pointer data model binding, OpenChamber's theme-matched React component catalog (`A2uiSurface.tsx`, `A2uiCharts.tsx`, `A2uiQuestionBatch.tsx`), and synthetic reply delivery (`answer.ts`, `replyAnswer.ts`, `ReplyA2uiBlock.tsx`).

The Markdown renderer routes ```` ```a2ui ```` fences through `MarkdownA2uiBlock.tsx`; `openchamber_render` tool calls with `a2ui` route through `message/parts/A2uiPageFrame.tsx`. On-demand schema delivery lives on the server in `packages/web/server/lib/openchamber-control/a2ui-schema.ts`.

## Invariants

- Zero external renderer dependencies: uses React, Zod v4, and OpenChamber's own UI primitives and `visualKit.ts` tokens so themes stay consistent and Zod v3 / Lit never enter the bundle.
- Streaming & LLM-slip resilience: while `complete` is false, an incomplete trailing JSONL line is ignored without blanking earlier parsed envelopes; once complete, `protocol.ts` applies deterministic recovery for trailing commas, minor unbalanced trailing delimiters, shorthand single-object surfaces, merged multi-key envelopes (`{ updateComponents, updateDataModel }`), and stray top-level component objects before re-validating strictly with Zod v4, showing diagnostics and reporting `notDrawn` for unrecoverable payloads.
- Client-side reactivity never runs arbitrary code: dynamic values resolve only JSON Pointers, `${path}` templates, and a small allowlisted set of pure functions (`equals`, `notEquals`, `not`, `and`, `or`, `isEmpty`, `nonEmpty`, `count`, `countAnswered`, `gt`/`gte`/`lt`/`lte`, `formatString`).
- Inline reply blocks persist unsent data-model edits in `sessionStorage` and submit once via `opencodeClient.resumeWithSyntheticInput` with an idempotent message ID.
- On-demand schema delivery preserves LLM prompt caches: `openchamber.guidance` carries only a compact static pointer (~144 tokens) instead of the previous ~1,100-token `UI_BLOCKS_GUIDANCE`, and the full or topic-filtered A2UI catalog (`charts` | `forms` | `all`) loads via `openchamber_render` (`action: "render.schema"`) as a normal tool result when needed.

## Decisions

### Why a native renderer in `packages/ui` and not `@a2ui/react` + `@a2ui/web_core`

OpenChamber runs on Zod v4 (patched in workspace root) and maintains its own Radix/Base-UI + `visualKit.ts` design language. `@a2ui/react` and `@a2ui/web_core` currently depend on Zod v3, Lit, and `@preact/signals-core`, and require custom catalog overrides for OpenChamber's visual theme and charts anyway. Implementing the A2UI wire protocol directly over OpenChamber's components keeps the bundle small, avoids Zod version conflicts, and unifies charts and batch questionnaires with the app theme.

### Why `QuestionBatch` is a first-class catalog component alongside `List` templates

Generic `List` templates work for arbitrary repeating cards, but 20–50 decision questionnaires need live progress tracking, answered/unanswered filtering, collapsible answered summaries, pagination, per-option expandable details, and bulk-recommended selection without forcing the agent to wire dozens of state nodes. `QuestionBatch` encapsulates those mechanics behind a single compact JSON data array in `updateDataModel`.

### Why `CognitiveMap` binds by `mapId` (with standalone `dsl` fallback)

Eden & Ackermann Means-Ends Cognitive Maps evolve over many turns through solo user edits and agent laddering. Embedding full graph JSON inside every chat message wastes tokens and drifts out of sync. `CognitiveMap` therefore binds live to a server-managed map via `{ id: "m", component: "CognitiveMap", mapId: "m1", focus: "n4" }` (just ~25 tokens) backed by `openchamber_cogmap` (`cogmap.read` / `cogmap.mutate` / `cogmap.analyze` / `cogmap.open`), while also accepting inline `dsl` or `nodes`/`edges` for standalone snapshots and the `?a2ui-demo=1` playground. All layout is computed deterministically client-side (`cogmap/layout.ts`) using a zero-dependency Sugiyama layered DAG layout with smooth feedback arcs.
