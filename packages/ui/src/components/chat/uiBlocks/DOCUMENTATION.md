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
- In a reply a press only chooses. A decision is the buttons of one card whose title no other card in the block shares, named by the title; elsewhere, the buttons that share a `value` (buttons without one make one more). Each decision takes one answer: a button, the card's note alone, or both. Once every decision has one, or the user presses "Send chosen", the answers go to the agent in one piece and the block freezes. An answered card without fields folds to one line with its answer and a way to change it before sending; the fold and the notes come back after a reload.
- A primary button is the agent's pick and is tinted until its decision has an answer; then only the chosen button is, with a check.
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

### Why Table draws as a Markdown table

A `Table` in a block becomes a GFM table string drawn by the chat's Markdown renderer, so it gets the same column fitting, copy and download as a table written straight into a reply; a second table implementation drifted from it in every detail. Cells escape the pipes that would split them and keep their own backslashes.

### Why text with a block stays out of a collapsed Activity

Text the agent wrote before a later step counts as a step, so a collapsed Activity used to fold it away, blocks included: a showcase of eight blocks followed by one question showed only the question. `getShownPages` lists such text with the pages, so it stays in view like them (`message/parts/DOCUMENTATION.md`).

### Why blocks and HTML pages share one visual kit

Chart series colours, badges and their tones, legend dots, bars on their track and boxes come from `../lib/visualKit.ts` in both a block and an HTML page an agent draws (`message/parts/htmlRender.ts`). They drifted apart before: a mockup page coloured its first series with the theme's accent while a block drew a fixed blue, and a badge was a pill on a page and a square in a block. The module holds the values (`kitVariables`, `chartSeriesColors`) and the CSS (`KIT_SHARED_CSS`); a page carries both in its document, a block sets the variables on its root and the CSS is added to the app's document once. On a page the kit's variables alias the public `--chart-N` and status names, so a page that sets its own recolours the kit too. A visual change to one of these goes into the module, never into one side.

### Why charts look the way they do

Each chart was picked by the maintainer from variants drawn on the same data. A single LineChart series is an area with its last value and its change since the first point on top, on an axis that spans its own values. Several series stay lines from zero; the legend and the lines bring one forward (a line only after the pointer rests on it, so a sweep does not flicker; a tap on the legend pins it), with a crosshair and a tooltip of every value. BarChart is a ranked list: name and value on a line, a thin bar under them, one series in the accent stronger as the value grows, with its largest and average on top; several series keep their colours. A chart's unit follows each number ("126 k", "42%", "$41.2"), since alone in a corner it read as nothing. Sum and shares show only when the agent marks the values as parts of one whole (`whole`): then the summary is the total and the largest, each bar is its share of the total and shows the percent. They are not inferred, because for percentages or averages a sum is false.

Stat and Progress were picked the same way. A Stat is a tile: label, large value, and its change as a kit badge with an arrow from the sign and the agent's tone; a Row of Stats is a grid of equal columns, so the last one on a wrapped line does not stretch. A Progress shows its percent on the right (never 100% before it is done) and the count beside it unless the max is 100; a done bar turns success-green with a check.

Steps are marks joined by a line, left to right in a row and top to bottom in a column, the line green after a done step. The current step is an accent disc with a halo and an accent title, and it does not move: a pulse was the first proposal, but a block can stay on screen for a whole session and a loop that never ends keeps the compositor working all that time.

A form looks like the question tool's: a Choice is one option per line with our Radio or Checkbox, so one-or-several is told by the control, and an option may carry a description under its label as the tool's do. Chips were tried first: the chosen state of a chip barely shows in some themes, and a single choice looked the same as a multiple one. The option rows get no fill on hover or when chosen (no hover fills on rows anywhere in the app); the control and a heavier label show the choice. Text fields are the app's own Input and Textarea, the card and page notes too: a flat box of the chat's own looked like no field the app has.

A DateInput is the scheduled task editor's calendar and time field (`components/ui/date-time.tsx`), not a copy, so the 12/24-hour and week-start settings hold in both. A Slider is the voice settings' slider with its value beside the label. A field the agent prefills, or a slider's starting point, is part of the answer until the user changes it, normalised to what the answer carries: a date field holds a time only when it asks for one, and a slider starts on a step its thumb can stand on. Details folds a section under its title, as Markdown folds `<details>`; its fields stay mounted while it is closed.

The chat is where a person and an agent decide things together, so the catalog has controls for what they decide (a date to schedule, an amount, a section to read later), not only what an agent needs to show code. Switches stay out: a Choice with several options already asks several yes-or-no questions.

A Callout is a tinted banner only for a warning or an error, with its title in the tone, as the git and MCP banners are; a note, info or success is an icon and text with no box, since five tinted boxes in a reply read as stripes. KeyValue is two columns, labels and values at the end, joined by a dotted leader, as the shortcuts dialog lists keys, and stays narrow so the eye does not cross a wide reply. A long value wraps inside its column: in one flex row a wrapped label or value kept its box wider than its lines, and the leader stopped short of the text; moving the value to a line of its own left it dangling under the label. A tab's content sits in a tile under the strip and frames what it holds as a card does. A Table inside a card or tab spans it without its own frame or column lines; a Table elsewhere, and every table written in a reply's Markdown, stays the chat's table.

### Why a waiting form always offers a note

A form an agent waits on (`openchamber_render` with `ui` and `awaitAnswer`) shows "Add a note" whether or not the agent asked for one. Users pick an option that is close but not exact and need to add conditions to it ("the minimal fix, with a regression test"); the question tool only takes an option or free text instead of it. Agents do not reliably add such a field themselves, so the form does. The note sits before the form's last run of buttons (`noteSlot`), so it is written before one of them is pressed, and reaches the agent as `data.note` and as the last line of the summary.

In a reply each decision card takes its own note. Its toggle is an icon at the end of the card's buttons, so a card is no taller until the user wants a note; the note opens above the buttons, and "Answer with the note only" takes the icon's place at once, disabled until the note has text, so the row does not shift while typing. A note alone answers the card: the user can say "not like this, ask the author first" without picking an option that does not fit.

### Why a titled card is one decision whatever its buttons' values say

The guidance asks for one `value` per item, but in the triage benchmark four of five blocks gave every option its own value ("#6101: investigate", "#6101: defer"). Read by value, each button was a decision of its own: no card folded, and the answers waited for every button of every card to be pressed. A card is the item in the guidance's own words ("a Card per item, a Button per option"), so its title names the decision. Two cards that share a title fall back to their values, so they never merge into one answer. A page keeps telling buttons apart by value: it answers on the first press, and the agent reads `data.value`.

### Why an answered card folds

A triage of five cards was a wall of buttons in which the undecided cards were hard to find. A card folds once answered, so what is left to decide stays open and what is decided reads as one line: the title, the answer, "Change". The recommended button is tinted rather than marked by its text colour, which did not read as a recommendation; with the chosen card folded, a tint no longer looks like a choice already made.

### Why OpenUI's state, bindings and actions are left out

The language can declare `$state`, bind fields and run action plans. Each needs a reactive store and its own security review, while a question needs only fields whose values a Button sends. A finished block that declares state, a query or a mutation is invalid.
