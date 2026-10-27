# OpenUI catalog

## Ownership

This folder owns the fixed OpenUI catalog, its data producer, field/action adapters and the theme bridge. Browser/server program rules are ordinary ESM source in `packages/web/shared/openui/`. Markdown provenance, Renderer lifetime, submission and media loading remain with their existing owners. The HTML module owns HtmlView's frame.

## Invariants

- `chamberLibrary` stays module-stable and exposes exactly the selected 48 component names.
- The context generator exposes every component signature exactly once. The 19 resident components cover layout, text, icons, images and content navigation; data, input/action interaction and HTML are disclosed on demand. Renderer availability remains the full catalog.
- `openuiCatalogBase` extends the official catalog through its public extension API. `deriveOpenUICatalog` and the live adapters share its schemas, including trailing options and finite Grid slots. Browser inspection uses the live library's schema. The server reads the exported schema/spec and imports the shared program rules. A parity test compares that data with the live library.
- `Stack` is the only root. `Stack.children` and `Col.data` explicitly have unconstrained child slots. A missing slot is not a renderable child.
- Program inspection rejects incomplete programs, unresolved references, parser errors, queries, mutations and unsupported action plans. Component composition follows the official runtime, including directly nested Cards and Icons in Card children. Schema child unions describe prompt guidance and traversal; they are not an additional fatal admission check. Reactive bindings remain valid.
- Admitted Markdown previews pass accumulated original DSL to the official streaming Renderer before complete inspection. Preview disables field edits and actions, creates no HtmlView frame and grants no new media. Confirmed completion runs full inspection and settles the same runtime when the Markdown parent remains stable.
- The core evaluator supplies all 14 official built-ins without the React catalog or copied function implementations. Inspection catches parser/evaluator failures and returns diagnostics without logging source.
- Buttons validate their current evaluated action at the event boundary. Host actions cannot be combined with local Set/Reset steps. Native fields and delayed callbacks recheck host authority; pending and terminal controls are disabled.
- Field defaults are registered in the official form store. Input and TextArea share text-edit handlers: focus and edits clear errors, blur validates, and writes recheck current authority. React IDs connect mount-local labels and controls; logical store names stay unchanged. Stable occurrence paths identify HtmlViews across remounts.
- Ordinary field-default registration follows the official streaming hook. Bound Callout dismissal starts when interaction becomes available, cancels when disabled and checks current authority again when the timer fires.
- Ordinary field edits retain their component type in the official field envelope. Reactive bindings still write through `useStateField`. Empty single choices use an empty string so default hydration never reselects a cleared value.
- TextContent and Callout use the shared Markdown renderer's embedded screen mode: inherited typography, safe external links, inert code, and no media or file activation. Export mode is not a screen renderer.
- Image and ImageGallery render through assistant MarkdownMediaOwner using only `host.initialMediaSources`. Current edits and restored field snapshots cannot expand that set, including through the VS Code workspace bridge. The browser uses `walkRenderedOpenUINodes` and `nativeOpenUIImageSources` to select initial sources from evaluated nodes. Gallery records retain the upstream `{src, alt?, details?}` contract. Images share the existing 12-source owner budget, remote URL policy and message preview.
- Image ratio and fit opt into geometry overrides. Caption/source metadata alone preserves natural image sizing and its existing height limit. Source links use the existing chat-link handler. The preview dialog loads on demand; source replacement and Activity cleanup close its popup.
- Theme changes update the public local provider without replacing the catalog or renderer identity. All mounted providers share one root appearance observer and resize listener, removed after the last unmount. Resolved font shorthands and chart palettes follow CSS changes; downloading fonts does not change these values. Official portals receive elevated text pairing.
- Theme tokens own shared colors, typography, spacing, radii and portal shadows. Scoped CSS owns component-specific density and flat layout surfaces. Buttons and TagBlock use the official catalog implementations; Tag delegates its visuals to the public component and renders its icon through the catalog.
- Renderer diagnostics marked as warnings do not retire the whole program. Complete inspection failures and non-warning runtime diagnostics retain the existing source fallback.
- Card and Stack keep official flex behavior. Card retains grow/shrink factors of 1, a 0% basis and a zero minimum inline size with empty or partial options. Explicit overrides, including zero, apply until removed. Table keeps the official 10-row default. Tabs and Accordion keep the official automatic page/section behavior and attach trusted paths to recursive children.
- Stack/Card sizing and padding use trailing options, preserving old positional signatures. Grid measures its own container, reduces columns when minimum track widths do not fit and clamps GridItem spans. Resizing preserves child identity and field state. Carousel uses upstream visual components and their public `CarouselRef.scrollDivRef` with local navigation and logical scroll alignment; browsing does not submit actions or consume embedded field keys.
- Stack/Card retain one component tree when options change between absent, empty and populated values. Their adapters preserve official flex defaults; options only update styles, keeping child DOM and focus intact.
- Stack/Card width, minWidth and maxWidth map to logical inline sizes, with numbers in rem. Width remains subject to flex allocation; Card's zero basis means width alone does not fix its size in a row. Min/max widths constrain the result. Grow/shrink act along the parent's main axis; Stack retains CSS defaults of 0/1 with an auto basis.
- Existing charts expose their supported layout, density, legend, grid and theme-palette options. Horizontal bars use BarChart. Axis captions remain visible when the legend is hidden; chart coordinates stay LTR inside an RTL interface. Icon renders official `@remixicon/react` components. Standard kebab-case names resolve to exports with their Line/Fill variant intact; no app sprite, aliases or category substitution are involved. Unknown names render nothing. Icon takes its name followed by optional size/tone options.
- `OpenUIProgram` owns the root media provider and styling scope. Layout components only render their children and assign stable occurrences.
- Host access (preview, interactive, readonly, revoked) is separate from submission progress. Submission transitions update one synchronous reference and its React view, so duplicate events cannot race React's next render. A successful receipt survives wait settlement or Activity hiding.
- `renderKey` identifies the rendered program. Only the waiting-tool boundary uses `sourceRevision`, the SHA-256 digest checked by the server. Existing page identities retain their values.

## Decisions

### Why layout adapters use flex longhands

React can clear values set by the `flex` shorthand when the same style also contains omitted or changing `flexGrow`/`flexShrink` properties. The adapter assigns longhands with Card defaults in one place so partial options and reactive removal restore those defaults. Keeping the official zero basis preserves existing space sharing; `{width: 12}` sets a 12rem inline size subject to that allocation, while `{minWidth: 12, maxWidth: 12}` constrains both bounds.

### Why OpenUI uses Remix React directly

Model-authored names need the standard Remix catalog. The app sprite renames and selects icons for application chrome, which caused standard names to resolve to question marks. OpenUI uses the installed official components directly, with only DSL name lookup and size/tone props; it maintains no generated SVG catalog or fallback loader.

### Why component composition follows the official runtime

The pinned parser and Renderer support Card/Icon and Card/Card combinations. The host schema includes both in Card's child signature so generated references describe those supported compositions. Host checks retain action and media authority while ordinary composition stays with the upstream runtime.

### Why derive the schema from the official library and not copy definitions

The official library owns parameter order, defaults, and references. Derivation keeps the server asset generator and the renderer aligned when the selected catalog changes.

### Why adapters declare only their consumed props

The pinned `/genui-lib` declaration erases individual component types. A small adapter-only contract fills that declaration gap without a schema-to-TypeScript generator or build-time source writes. The official library still owns DSL schemas, positional signatures and validation. Catalog parity and real field tests cover the adapter boundary.

### Why loaders disable automatic development tools

The shared `openuiRendererLoader` sets `Symbol.for('openui.devtools.autoMount')` before importing the renderer, as recommended by the maintainer in [openui#960](https://github.com/thesysdev/openui/issues/960#issuecomment-5279052334). Both entries reuse its resolved module synchronously on remount. This keeps the development panel out of the chat without modifying dependencies or adding network restrictions. Runtime telemetry uses the official disable flag in the reference producer and server inspector; browser telemetry is already disabled by the library.

### Why the image source set belongs above the store

The host inspects defaults through the pure evaluator before mounting the Renderer. Capturing sources from a live or restored store would let a user-edited file path reach the VS Code bridge. An absent initial-media context denies native image loading.

### Why Grid adds two layout components

Stack and Card own one-dimensional flex composition. Grid supplies shared two-dimensional tracks and GridItem supplies optional spans. Ordinary cells use their visual components directly. ImageGallery and Carousel retain upstream DSL contracts while host adapters preserve media authorization and application controls.

### Why controls use application primitives

Field and action adapters enforce current host authority, register typed defaults in the official store and connect labels with mount-local IDs. They reuse existing Chamber inputs, selects and buttons; Base UI owns radio and slider interaction. DatePicker uses native date inputs with the same Date/range store values, so selection and Reset have one owner. Slider changes reach the official store synchronously, including its numeric inputs. Charts retain the public official visual implementation and local ThemeProvider.

Discrete sliders offer a value menu for at most 100 steps. Larger ranges keep the same step snapping through numeric inputs, without allocating an unbounded option list.

### Why Form and Accordion delegate to the official catalog

The official Form owns validation providers and form names; the official Accordion owns automatic expansion and user selection. Their adapters only attach trusted child occurrences. Accordion gives each section a distinct content-array identity before passing it upstream, so repeated DSL references retain separate HtmlView paths. CSS preserves the compact form gap and accordion layout without copying state logic.

### Why Tabs retains its local implementation

The pinned official Tabs list hardcodes physical scroll checks, click centering and scroll buttons without a public opt-out. Base UI preserves the existing native overflow strip and locale-aware keyboard navigation. The adapter keeps automatic selection and trusted content paths until an upstream public interface can preserve those behaviors.

### Why chart adapters retain their data preparation

The shipped catalog adapters hide empty charts and preserve some missing series values. Chamber's existing public chart path displays empty states and fills missing values with zero. Its small shared Cartesian conversion preserves that behavior while using the official visual components.

Each chart parses its options once with its own schema. A shared Cartesian render function owns data preparation, the LTR container and axis captions; each caller selects its official chart with the public `BaseChartProps` contract. Invalid options fall back together, so a rejected orientation or density cannot leave a hidden legend or an extra caption behind.
