# Theme definitions and rendering

`definition.ts` parses authored JSON into the complete runtime `Theme`. Built-ins and custom-file responses use this same boundary. Embedded windows receive an already resolved theme. The server checks required authored roles and file limits; the UI validates all supported overrides before rendering. An invalid sibling is skipped, while an invalid response shape leaves the previous custom library intact. Theme values are written into a `<style>` element, so the boundary also guards CSS: a colour must be a hex value, a keyword or a colour function (`rgb()`, `hsl()`, `oklch()`, `color-mix()` and kin), and fonts and transitions may not contain `; { } < > \` or load anything (`url()`, `image-set()`, `@import`). A theme that fails is skipped like any other invalid sibling.

Keep authored definitions separate from runtime colors. Optional values are meaningful defaults, not missing rendering data. `compactTheme` removes semantic defaults; the maintainer script checks resolved-color equality before replacing JSON files. Existing custom files are read without rewriting them.

`syntax.ts` owns syntax inheritance. Chat's static worker theme and the file/diff TextMate theme use `buildSyntaxTokenRules`; CodeMirror uses the same resolved palette. Changes to inheritance must preserve explicit overrides and pass compact round-trip tests. The worker theme contains CSS variables so switching palettes does not require tokenizing code again.

CodeMirror, Shiki/Pierre and chat/tool output use the authored
`syntax.base.background` directly, exposed as `--syntax-background` in CSS.
There is no global opacity or canvas-mixing adjustment. Built-in palettes keep
that background close to the canvas, using OpenChamber Light's quiet separation
as a reference. Their background-to-background contrast stays at or below 1.10;
this is a surface distinction budget, not a text contrast target. Custom themes
retain their exact authored background. Bodies and gutters use the same fill.

`color.ts` owns alpha composition and readable text selection. A solid status foreground is not the text for a tinted alert. `readableColors.ts` computes the palette used by both `cssGenerator.ts` and the extension host snapshot, including the corrected selection foreground. The SDK receives the computed text colors as required fields and applies them directly, without a second color algorithm. Color calculations run when the theme changes, not on each button render or session update.

For authoring and supported fields, see `docs/CUSTOM_THEMES.md`. Surface semantics belong to `.agents/skills/theme-system/references/tokens-and-examples.md`.

`scripts/port-opencode-theme.ts` is the maintainer's OpenCode App converter,
promoted from the personal converter that produced the `OpenCode App / …`
library. It reads an installed sibling `../opencode` checkout, using its actual
v2 UI and v1 syntax resolvers, then the shared VS Code importer. The sibling
checkout is a development prerequisite, not a shipped dependency. Run its explicit
integration suite with `bun run themes:port:opencode:test`; it needs that checkout
and is kept outside the ordinary self-contained test suite.

The command uses `--theme ID`, `--mode`, `--output`, `--list` and `--dry-run`.
The previous positional/TUI converter and its `--force` option are replaced.
Output retains the personal library's IDs and compact format. Publication skips
identical files and refuses edited files or symlinks; use a fresh output directory
to review regenerated palettes. Markdown, surfaces, text, borders, bubbles and
status/PR semantics follow the shared VS Code adaptation. The converter adds source
metadata, the overlay and the syntax regex token without overriding adapted UI roles.

Elevated surfaces scope `--foreground` to `surface.elevatedForeground`, so neutral
children do not accidentally paint canvas text inside a popup. Opaque canvas
and secondary surfaces reset that context; code establishes its own syntax text.
Palette files are not retuned to conceal incorrect role usage.

Built-in palettes place the sidebar below the chat canvas in luminance. Fields
and elevated panels are lighter than the canvas in dark mode and darker in light
mode. Mono and Mono Plus keep their pure-black dark canvas, so their sidebars are
the exception. User-message backgrounds carry a faint primary tint, with enough
separation from the canvas to remain visible. Mono keeps every role grayscale.
Body, secondary and bold text retain the palette's neutral cast with distinct
contrast levels; bold text is a stronger body color rather than a syntax accent.
These authored choices apply to built-ins, not to existing custom theme files.

Built-in border strength uses OpenChamber's matching light/dark palette as the
reference. Compare alpha-composited contrast on canvas, sidebar and elevated
surfaces separately for ordinary borders, hover borders, tool outlines and
dividers. Only soften roles exceeding the reference's strongest contrast across
those surfaces; retain quieter authored borders and their hue. Markdown rules
and quote borders use the divider reference. Focus and status borders keep their
own emphasis.

The VS Code adapter maps the main canvas from chat/editor, secondary layout from
sidebar/panel, and the shared elevated role from an editor-widget, dropdown or
input pair in that order. OpenChamber currently has one elevated role for fields
and floating UI, so it cannot retain different VS Code input and popup fills at
the same time. Always keep the foreground paired with the chosen source.
Selection prefers the authored list pair, then menu and editor pairs, but skips
a candidate that becomes indistinguishable from a shared canvas, sidebar or
elevated surface when another authored pair remains visible. Keep the matching
foreground. The shared adaptation pass then makes an indistinct selection visible
on the final surfaces. Pressed controls use toolbar-active, never list-selection. Input backgrounds are not hover
states, chat bubbles are not sidebars, and diagnostic colors are not search highlights.

A transparent input/widget border does not disable the app's generic borders;
use the next painted border role from the source palette. Transparent editor
diagnostic fills likewise fall back to status tints, because an editor underline
and an app alert have different background needs. Focus rings retain the authored
focus color and alpha rather than replacing its opacity with a fixed percentage.

`vscode/adapt.ts` applies the shared UI policy once, at the end of
`buildVSCodeThemeFromPalette`. File imports and live VS Code theme changes both
use it. The adapter also owns missing-role fallbacks, so the same source colors
produce the same UI palette through either route. High-contrast light and dark
palettes retain their authored contrasts; the live reader recognizes VS Code's
high-contrast body classes. Existing saved custom files are not rewritten.

Ordinary palettes retain their canvas and hue, but sidebar and elevated layers
follow the built-in hierarchy. Surface contrast stays within 1.04–1.10 where
the canvas permits it; a black canvas keeps a black sidebar. Body text is softened
to a canvas contrast ceiling of 10 in dark and 9 in light, with a readability
floor of 7 across shared surfaces when possible. Secondary text targets 4.6–6.
Readability takes precedence over ceilings. Bubble text is checked after adding
the faint primary tint. Bold uses stronger neutral text. Code backgrounds stay
within 1.10 of the canvas; syntax token and diff colors retain their source values.

Borders use the matching OpenChamber role's contrast on each corresponding
surface as a baseline, including explicit tool and quote borders. Each cap allows
20% of the gap toward the role's strongest reference contrast to retain a little
more definition. The sidebar's
stronger edge is not the budget for an elevated control. Quieter authored borders remain intact. Hover
and pressed fills have their own quiet caps. Selection retains its hue with a
quiet fill capped at 1.50 on elevated surfaces, and derives readable labels from
body text rather than a harsh source selection foreground. High contrast keeps
the authored selection pair. Focus retains its source color unless effectively invisible.

An unusable button fill falls back to a visible authored link, badge or highlight
accent. Status shades may retain the source color only within the semantic hue
family: info blue, success green, error red, warning amber. PR blocked is orange,
merged purple and draft secondary text. Status fills and borders follow the final
status shade. A blue primary may share the info hue; hue rotation no longer moves
info into another semantic family.

`vscode/import.ts` owns file conversion for Settings and the maintainer CLI.
It accepts bounded JSON/JSONC with literal VS Code colors. Missing neutral roles
derive from the imported canvas, while the adapter owns UI role precedence.
General semantic selectors override general TextMate rules unless semantic
highlighting is disabled. Language-specific selectors do not become global colors.
Missing code categories inherit code text, not the default OpenChamber syntax.
`include` and external token files fail explicitly instead of guessing missing data.

The provider persists imports through `POST /api/config/themes` before adding them
to its runtime-scoped library. A successful save invalidates older reloads. Runtime
switches reject late application, and newer theme choices/imports win over an
upload in flight. The server assigns content-based IDs and atomically publishes
new files without overwrite; identical retries reuse the file. VS Code keeps the
import action unavailable because its active theme belongs to VS Code.

`vscode/catalog.ts` parses server catalog/package responses and runs resolved
package sources through the same converter. Manifest labels remain authoritative;
standalone file import humanizes lowercase slug names. The dialog keeps at most
24 search results and 40 variants, debounces searches, aborts obsolete reads, and
discards the dialog on runtime changes. Batch saves are sequential, retain each
successful theme after a sibling failure, and leave the active selection alone.
Completion has a success toast and full-opacity checked rows;
partial failures remain explicit and successful variants stay installed.

All server-loaded custom themes, including manually added JSON files, expose
deletion in the existing picker. `customThemeIds` records that source independently
of ID spelling or tags. The provider commits a
successful DELETE before removing the item, invalidates older reloads, and resets
only a selected deleted ID to its built-in mode default. Runtime generations
prevent old mutations applying even after switching away and back.

`RuntimeAPIs.themeFiles` is an optional local native picker. The web adapter exposes
it only to trusted desktop pages; browser/hosted-mobile/Capacitor use file inputs.
VS Code returns 501 for theme management routes and exposes no import controls.

On mobile, theme import uses `MobileOverlayPanel`, with actions in its footer and
the catalog body in its single shared scroller. The panel owns keyboard insets and
safe-area sizing; avoid nested viewport-height lists inside it. Search, variant
selection and pending imports stay in the same controller across layout changes.
Theme pickers use the shared Select's safe-area-aware collision padding so long
lists can scroll without reaching under the native status bar or home indicator.

The desktop import dialog explicitly renders its backdrop when nested inside Settings.
Base UI omits nested backdrops by default, so a click on the parent's backdrop
does not dismiss the child modal. Keep dismissal with the dialog primitive.

Agent identity colors are allocated by `lib/agentColors.ts` from the resolved
theme and full visible agent roster. Build retains `status.success`; the other
agents use distinct syntax colors, excluding near-duplicates of Build's color.
Primary/all-mode agents allocate before subagents. Sorting by name makes results
independent of server ordering or picker search. Reuse starts only after the
available distinct colors are exhausted; unknown historical names have a stable
syntax fallback without extending the roster.

`hooks/useAgentColors.ts` shares one resolver per immutable theme/agent-array pair
across composer menus, mobile controls and message footers. Weak keys release
obsolete snapshots. A theme or roster replacement recomputes assignments; ordinary
message renders and unrelated config changes reuse them. CSS classes and inline
labels resolve the same existing theme variables, with no separate agent palette.
