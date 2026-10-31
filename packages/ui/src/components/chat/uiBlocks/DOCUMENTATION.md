# UI blocks

## Ownership

An assistant reply can carry fenced `openui-lang` blocks. This module owns the catalog of components those blocks may use (`catalog.ts`), how a block is parsed and drawn (`UiBlock.tsx`), and the text that tells an agent how to write one (`guidance.ts`). The Markdown renderer decides where a block draws (`MarkdownCode`, `MarkdownUiBlock`); the session-knowledge runtime on the server delivers the guidance (`packages/web/server/lib/session-knowledge`).

## Invariants

- Only an assistant reply on screen draws blocks: `MarkdownRenderer` sets `uiBlocks` for the `assistant` variant, and copies and image exports keep the source. User messages, reasoning, tool output and documents show the fence as code.
- The catalog in `catalog.ts` is the one source for the parser, validation and the agent's signatures. After changing it, run `bun run --cwd packages/ui ui-blocks:generate`; `guidance.test.ts` fails while the server copy is stale.
- A finished block that has any parser error, an undefined or unused name, state, a query or a mutation, or no `Stack` root draws nothing but its source and a short note. A block never shows with parts silently dropped.
- While a block streams, a node keeps drawing its last props that parsed against its schema; a node that never parsed draws nothing.
- Fields and Buttons act only once a block is finished and has somewhere to answer: an assistant reply that has settled, or a page whose call still waits. Anywhere else they show disabled.
- A page takes one answer: a press answers the waiting call at once, and the block freezes.
- In a reply a press only chooses. A decision is the buttons that share a `value` (buttons without one make one more), and each takes one choice. Once every decision has one, or the user presses "Send chosen", the choices go to the agent in one piece and the block freezes. The chosen buttons carry a check, also after a reload.
- `@openuidev/lang-core` is a dependency of this private package only, bundled at build time. It never goes into `packages/web`'s dependencies.

## Decisions

### Why OpenUI's language and not our own JSON format

The language streams well: the parser returns a partial tree for any prefix, so a block grows while the reply arrives, and its diagnostics name the component, argument and signature. Positional arguments are the risk for weaker models; the catalog keeps argument lists short and close to OpenUI's standard catalog.

### Why only `lang-core` and not OpenUI's React renderer or component kit

`@openuidev/react-lang` brings devtools with a second lucide version, and `@openuidev/react-ui` a whole component kit (Radix, d3, Markdown, syntax highlighting) that we would override anyway. Drawing the evaluated tree with our own components keeps the look in our theme and the bundle small.

### Why the server gets generated text and not the catalog

`lang-core` has an install-time telemetry `postinstall` script. Bun blocks it, but npm runs it, and `@openchamber/web` is installed with npm. Keeping the package out of the server means users' installs never run it; the server reads a generated copy of the guidance instead.

### Why a reply's answer is synthetic input and not a user message

The choices in a reply's block reach the agent as OpenCode synthetic input with `resume: true` (`replyAnswer.ts`), which starts the agent's next turn without a user bubble. Sending each press as a user message, as the first version did, gave the agent a turn per press: with four cards it answered the first choice and drew the other three again. Collected into one input, the agent gets the whole decision at once. The input's metadata (`openchamberUiBlockAnswer`: message id, block key, answer) is the record the block reads back after a reload, so no store of our own keeps answers. A block on a waiting `openchamber_render` call answers that call through `/api/openchamber/render/answer`, like an HTML page.

### Why OpenUI's state, bindings and actions are left out

The language can declare `$state`, bind fields and run action plans. Each needs a reactive store and its own security review, while a question needs only fields whose values a Button sends. A finished block that declares state, a query or a mutation is invalid.
