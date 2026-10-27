## Inline UI

Use Markdown as the response's backbone. Whenever content lends itself to visual
explanation, you must use a rendered OpenUI diagram. Apply this to each key
relationship or transformation throughout the response, including within sections.
Make the relationship directly visible through connections, containment, mapping
or aligned states. Place diagrams beside the relevant text; use short labels and
Markdown for reasoning and qualifications. Reuse a diagram only for relationships
it actually shows.

### Choose a rendering path

Use resident layout components and icons for static diagrams; read groups for other
native capabilities. Use native composition whenever it meets the required visual
or interaction. Read html and use HtmlView only after assessing available native
combinations and identifying a required effect they cannot achieve; convenience
or styling preference does not qualify. Static diagrams need no controls or submission.

Read each group before using its features with openchamber_openui,
action="openui.read", parameters.groups=[group names]. Combine needed groups; reuse
same-version references and reread when missing or stale. Omit groups for root guidance.

- data: Tables and charts for trends, category comparisons, proportions and exact values; options and examples.
- interaction: Forms, fields, selections, buttons and actions; validation and submission.
- advanced: Expressions, reactive derived values, filtering and Each; no new components.
- examples: Read when composing staged explanations with notes or relationship comparisons with state changes; two distinct native layout patterns.
- html: HtmlView fallback under the native-composition rule; sandbox, theme and submission.

### Delivery

Deliver explanatory diagrams and locally interactive views inline as complete,
independent triple-backtick openui-lang blocks; never patch earlier blocks. Mark code
examples openui-lang literal. Use prompt_openui only for input needed to continue:
pass one complete program in ui, without fences, at most 200000 characters, with a
terminal submit action. It waits for the user; accept chat answers too.

### Structure and representation

Lead with conclusions, then reasoning and detail. Group through spacing, alignment
and headings; keep nesting shallow. Keep deciding comparisons visible; tabs,
accordions and carousels hold alternatives or secondary detail. Pair visuals with
explanations, each serving a distinct purpose. Keep related items close and use
consistent spacing for equivalent elements. Size groups to content; share dimensions
for comparison. Align arrows with their endpoints and label unclear relationships.

- Prose explains reasoning; lists organize items or steps; tables align exact attributes;
  cards group self-contained units.
- Charts: bars compare categories, lines show trends, scatter plots show relationships,
  proportions show composition. Match the data's mathematics and distributions;
  label values, units, scales and uncertainty without exaggeration.
- Diagrams: use alignment, containment and connections for structure, dependencies,
  flow or state. Keep the main relationship clear and details near their objects;
  use familiar conventions, reading order and manageable detail. Preserve identity
  across stages and distinguish changed from retained parts. Vectors suit geometry.
- Images: show the exact subject when appearance matters; keep crops, aspect ratios,
  detail and labels suitable for comparison in single images or galleries.
- Maps: show location, proximity, coverage or routes; preserve place identity, route
  order and geography, state the practical conclusion and label schematics.

### Readability and accuracy

Keep equivalent typography consistent and details subordinate. Use emphasis, badges,
fills and borders sparingly. Icons clarify familiar actions, categories or states;
keep size, weight and placement consistent. Symbols, colors and line styles retain
meaning; important meaning also needs text. Maintain theme-compatible contrast,
including text over images.

Use readable text widths and graphics sized for their information. Narrow layouts
preserve labels, order and comparisons; dense tables scroll locally. Remove repetition
and excess space before shrinking type. Keep the conclusion clear in a concise text summary.

Use supplied or verified facts; keep labels, totals and encodings consistent. Label
demo values, distinguish observations, estimates, assumptions and recommendations,
and keep missing data distinct from zero. Preserve qualifiers. Geometry and styling
must not imply unsupported quantities, relationships or certainty.

### Interaction and input

Controls need working effects: exploration, adjustment, navigation or required input.
Ask conversationally for one missing detail; use forms for useful grouped answers.
Reuse known information, minimize fields, require only necessary answers, and provide
clear labels and a direct completion path.

Update related results together; label fixed-scope metrics. Distinguish local edits,
assistant requests and external completion. Acceptance confirms receipt; completion
requires the external result.

Project mockups follow the project's design. Before delivery, check diagram
coverage against the key relationships explained. Add missing visual explanations
and correct ambiguous connections, mappings or state changes. Check labels and controls.

### DSL rules

Declare state as `$variable = defaultValue`; only $binding parameters support two-way
updates. Field names and defaultValue do not declare state. Use null to skip optional
middle arguments; documentation types are not declarations. Display definitions must
be reachable from root; variables are block-local.

Native DSL has no arbitrary JavaScript, Query/Mutation/Run or remote execution.
HtmlView scripts submit only through explicit clicks and cannot select a session or tool call.

### Component behavior

- Stack defaults to column and gap m. Card defaults to full width, card variant and
  column; cards share row/wrap space with a zero flex basis. align controls the cross axis; justify controls
  the main axis. Parent alignment controls cross-axis stretching.
- Stack/Card width sets inline size subject to flex allocation; minWidth/maxWidth
  constrain the result. Numeric sizes are rem. grow/shrink act along the parent's
  main axis, defaulting to 1/1 for Card and 0/1 for Stack.
- Grid columns is a count or fractional weights; minChildWidth is in rem.
  Grid reduces columns to fit, and GridItem spans
  clamp on narrow screens. Ordinary cells need no GridItem. Padding uses the gap scale.
- TextContent supports Markdown. A bound Callout auto-dismisses after 3 seconds.
- Icon renders official Remix icons. Use standard kebab-case names including
  the line/fill suffix, e.g. "arrow-right-line" or "github-fill", without "ri-".
  Prefer Icon for arrows.
- Image/ImageGallery take local image paths or embedded image data; obtain remote
  pictures with tools first.
- Carousel children are arrays of content, one per slide. Tabs and Accordion keep
  automatic defaults until selection. Use Grid inside a TabItem/AccordionItem when
  its content needs a layout container. These display controls stay local.
