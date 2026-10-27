# OpenUI context

## Ownership

This directory owns OpenUI prompt sources, tool descriptions, context assembly,
generated contracts. `assets.js` assembles root-level
instructions, schema and revision for the session instruction entry and reads requested
groups for `openchamber_openui`. The surrounding modules handle delivery.

### Context as a skill

| Current context | Skill equivalent |
| --- | --- |
| Resident `Inline UI` opening | `description`: when to use OpenUI. |
| Root `instruction.md` | Task-driven presentation, hierarchy, representation choice, readability, interaction value, delivery and reference routes. |
| Root `gen.instruction.md` and `gen.schema.md` | Common DSL and 19 display-component signatures. |
| On-demand `data`, `interaction`, `html` | Capability contracts, behavior and relevant examples. |
| On-demand `advanced` | Reactive-language references. |
| On-demand `examples` | Native composition patterns for staged explanations and relationship comparisons. |
| `openchamber_openui` declaration and `groups` | Interface for selecting and reading context. |
| `prompt_openui` | Execution tool for presenting UI and waiting for an answer. |

### Content sources

Root `instruction.md` owns resident host rules and routes. Group `instruction.md`
files contain local behavior only, except for the two composition patterns in
`examples`. Advanced has no handwritten file. Markdown changes are read immediately
without regeneration. `tools.js`
owns the tool/action descriptions, parameter schemas and group whitelist.

Run `bun run openui:generate` after changing the catalog or official library.
`generate.mjs` separates three sources within the existing groups:

- `gen.schema.md` and `generated/gen.schema.json` derive from the live catalog.
- `gen.instruction.md` derives from the installed, lockfile-pinned
  `@openuidev/lang-core` prompt and the public
  `@openuidev/react-ui/genui-lib/prompt-options` export. The current selection uses
  lang-core 1.0.1 and react-ui 0.18.1.
  Provenance and selection notes stay in this document, outside delivered context.
  Root includes basic syntax
  and hoisting/streaming; advanced includes operators and the built-in functions.
- `instruction.md` is handwritten OpenChamber policy, adapter behavior and composition examples.
  It is never rewritten by generation.

The upstream selection is explicit in `generate.mjs`. Syntax rules 1–7 and string
escaping stay resident; rules 9–16 go to advanced, renumbered. Rule 8 permits undeclared
state and is excluded because the host requires declarations. The upstream opening
requires an all-DSL answer and is excluded. Component-signature sections already
exist as catalog contracts and contain unsupported component guidance, an incorrect
Form button position and Lucide icon advice. Action prose allows absent actions
and combined host actions; OpenChamber requires explicit actions and one host step.
Those sections are excluded, along with generic Important Rules/Final Verification.
Local delivery and state declarations stay resident; interaction owns host-action policy.
Missing sections or a changed syntax-rule structure fail generation for review.

Advanced keeps the official Each signature's scope rule and omits the repeated
footer. Its reactive rule comes from `openuiAdditionalRules`, with the unsupported
"Queries and" clause removed. Interaction generates Set/Reset signatures from the
official Action section; host actions and their composition restrictions stay local.

Icon's signature stays resident with standard Remix kebab-case examples retaining
line/fill suffixes and omitting the CSS `ri-` prefix. It renders official Remix
React components directly. Its arguments are name and optional size/tone options.
No icon-name directory is delivered in context.

`assets.js` assembles local instruction.md first, followed by required official
instructions and catalog contracts. Each group declares its exact required files;
a group can consist entirely of generated references. Missing declared files fail with 503. Requested groups retain their
order and deduplicate. The version hashes all assembled groups, the routing index
and catalog at read time, so edits to optional guidance also invalidate old context.
No generated copy or build-time revision of handwritten Markdown is maintained.

The selected catalog contains 48 components with exactly one signature owner:
19 resident display components, 7 in data, 21 in interaction and 1 in html.
Generation rejects duplicate or missing assignments. Rules is defined
only in interaction, where fields consume it. The data group owns tables, charts
and chart options. Interaction owns forms, inputs and action buttons. Images,
labels, Tabs, Accordion and Carousel are resident display components.
Interaction points to advanced for expressions and derived values.

## Invariants

- Markdown structures the response. Every part suited to visual explanation uses
  rendered OpenUI diagrams beside its relevant text, with Markdown supplying
  reasoning and qualifications. This requirement applies to each key relationship
  or transformation, including within sections. Delivery checks require adding
  missing visual explanations and correcting ambiguous relationships.
  Native composition is required whenever it can achieve the needed visual or
  interaction, including components from optional groups. HTML is a last resort
  after assessing available native combinations and identifying a required effect
  they cannot achieve. Spatial content, convenience or styling preference alone
  does not justify HTML; the HTML reference points back to this root-owned rule.
- Root presentation policy applies before capability selection: choose the simplest
  effective representation for the task, keep conclusions and deciding comparisons
  visible, and use components, emphasis and controls for a concrete purpose. Markdown
  supplies reasoning and a concise text summary; diagrams select objects and connections
  for a specific explanatory goal. Grouping, sizing and labeled connections make the
  main relationship visible. Facts, state scope and action claims remain consistent
  across representations.
- Resident assets live at the context root, outside the group API. Read matching
  task and capability groups directly.
  Disclose specialized details when needed, allow
  related groups to be fetched together and reuse same-version context.
- Keep examples complete enough to teach their visual organization, retain
  source attribution in maintenance documentation and label demonstration data. Programs must pass the
  parser and host checks.

## Decisions

### Why task routing precedes syntax

The resident root leads with explanation tasks, rendering paths and delivery choice.
Group entries describe authoring needs; optional references supply component signatures. Injecting
this guidance before syntax and signatures puts selection criteria before implementation
details; this ordering is an explicit assembly contract, not evidence of improved model
behavior. Production evaluations still determine selection and explanation quality.

### Why diagram coverage is checked throughout the response

A single overview can satisfy a response-level diagram requirement while leaving
later mechanisms entirely in prose. The opening and delivery check apply to each
key relationship suited to visual explanation, with Markdown organizing the whole
response. A diagram covers only relationships it actually shows. Diagram count
follows explanatory value; the rule imposes no per-section quota.

### Why groups are file-based

Handwritten Markdown is both the editable source and the delivered guidance.
Generation owns catalog contracts and selected upstream instructions. This removes template-string
escaping and stale generated prose while retaining the existing read API.

### Why upstream instructions and local policy are separate

The official generator supplies language rules; the catalog supplies component
contracts; local Markdown supplies host delivery and adapter behavior. Explicit
selection avoids importing conflicting whole-answer and action policies. Local
files no longer repeat the selected language rules.
This source separation and pruning has no model-quality acceptance yet.

### Why common components are resident and capabilities are grouped

Layout, text, icons, images and content navigation support ordinary explanations
without extra component reads. Tabs, Accordion and Carousel stay resident because
they organize display; interaction covers input collection and explicit actions.
Tables/charts and interaction are disclosed as complete capability groups;
the prior base/content/inputs/charts split repeated signatures and hid common layout.
Resident files are outside groups. The retired base, content, inputs, charts,
forms, media and diagrams names are rejected by the same fixed-group validation as other
unknown names; the updated instruction revision and tool schema expose current routes.

### Why composition examples are read on demand

The `examples` group contains two distinct patterns: staged explanation with paired
notes, and relationship comparison with state changes. Root routes these tasks to
the examples without carrying both programs on every request. The group contains
only handwritten instructions using resident components, with no generated contract
files. Its content participates in the instruction revision like every other group.
Transfer to other tasks still requires production evaluation.

### Why image internals and icon directories are omitted

Image and ImageGallery use the existing Markdown media runtime. Context states
their input-source requirement; file authorization, initial-source checks and
resource budgets remain runtime responsibilities. Delivered instructions omit
those implementation details. The media group and its standalone examples are
removed, and Remix names are no longer enumerated. Runtime checks and budgets are
unaffected by this reference change.

### Why capability guidance is generated from selected official sources

Data includes the unmodified programs from `openuiExamples` 1 and 2, for Table and
BarChart. Interaction includes example 3, for a validated Form, plus the three
ordinary-library form rules. Data also selects the Chat rule about scaling chart
values and labeling units. Selection uses unique prefixes and fails when a source
is absent or ambiguous. Every selected program must pass the current catalog and
host inspector before generated files are published.

The Chat dashboard and travel examples require unavailable components and old Icon
arguments. They are excluded along with incompatible rules about Card-only roots,
fabricated data, implicit button actions and combined host actions. The generated
examples replace handwritten dashboard, product-comparison and travel rewrites.
Local data guidance covers chart extensions and table behavior; local interaction
guidance covers host submission and action restrictions. The official Cancel
example sends an assistant message, so the local note describes that effect.

Advanced supplies expressions, reactive behavior and functions once, without a
second handwritten tutorial. The two native layout examples remain in `examples`.
This selection has parser and packaging coverage; production evaluation is still
required to establish generation quality.

### Why delivery choice stays resident

The model chooses between an inline response and a blocking input request before
reading optional references. Resident delivery guidance owns that decision; the
waiting tool description names the required-input purpose at the point of use.
Local controls work inline and do not require a waiting call.

### Why deliver context through managed tools

Direct skill injection would require a separate pipeline. Managed tools fit
OpenChamber's existing direction for extending agent capabilities and let the
agent fetch several context groups in one call, avoiding separate skill and
reference loading steps. The skill mapping guides content organization while
tools handle delivery.

### Why groups follow authoring needs

Root instructions define Markdown/UI composition; capability groups supply
contracts and examples. These boundaries let the agent read what the
task needs without loading every example or reading each source file separately.
