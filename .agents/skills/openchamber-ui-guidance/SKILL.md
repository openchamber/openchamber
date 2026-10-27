---
name: openchamber-ui-guidance
description: Use when designing, building or reviewing how OpenChamber UI looks or behaves on screen: composing a panel, dialog, card, list row or control; choosing surfaces, depth and borders; spacing, sizing and text density; or what moves when the user interacts.
---

# OpenChamber UI Guidance

OpenChamber's visual language and the interaction patterns the maintainer
expects without having to say them. Mechanics live elsewhere: tokens,
primitives, icons and animation styling in `theme-system`; Settings page
composition in `settings-ui-patterns`; every visible string in
`locale-ui-patterns`. This skill decides *what* a screen should look and feel
like; those decide *how* to write it.

How something looks and behaves is the maintainer's decision. Build to these
patterns, and when a change needs a pattern this skill does not cover or would
bend one, raise it as a product question before building (root `AGENTS.md`).
Tuned values (sheen, shadow, top line strength) were set by eye by the
maintainer; keep them as they are unless asked.

## Depth: controls stand up, layout lies flat

The app has one rule for depth, and every surface follows from it:

- **Controls are raised.** Anything you press or type into (buttons, dropdown
  triggers, the chosen option of a segmented choice, text fields, the
  composer) carries a hairline edge, a lit top line and a short shadow. In
  dark themes fields, buttons and pickers share one light; in light themes a
  field is pressed in, because it is a place to type, not something to press.
- **Layout is flat and set off by tone.** Cards, list tiles, groups and
  panels have no border; each is a tone step from what it sits on. A block
  inside a tile is the next step. Never box a box: a card inside a card, a
  bordered row inside a bordered list.
- **A line means something.** Draw one only where it carries meaning: a
  section divider, a dashed empty slot ("Add …"), the drop target while
  dragging, the frame of a large code canvas (Files panes, a diff) that would
  otherwise merge with the page. Decoration is never a reason.
- **Floating is glass plus light.** Menus, popovers, autocompletes, the
  selection and quote menus, floating comment fields: blur behind, lit top
  edge, hairline, layered shadow, the same look as a dropdown. Surfaces always on screen
  over the moving transcript (the composer, status pills) are opaque with the
  same light, never blurred.
- **Status speaks through fill.** A banner or error box is a tinted fill with
  no border; the fill already says warning, error or info.
- **Focus draws no ring.** A focused control takes the hover fill; a focused
  field brightens its own edge.

Light and dark themes differ on purpose: light themes paint the elevated
surface darker than the canvas, so a raised control takes the canvas colour
there and a text field reads pressed into the page. Which class gives each of
these, and the traps that silently undo them, is in
[references/surfaces.md](references/surfaces.md); read it before styling any
surface or control.

## Stability: interaction moves only what it touches

Using a control must not shift anything the user did not touch.

- **Reveal in place.** An option that reveals more (a radio whose choice shows
  a field, a mode that adds a row) shows it where the layout already has room
  or in space the container reserves for it, so the dialog, row or page keeps
  its height. Choosing between options swaps content of the same height, or
  reserves the tallest variant; a disabled stand-in shown for the other options
  has the real control's exact shape, its reserved lines included.
- **Status lines have a reserved slot.** A control whose state can produce a
  message (loading, empty, error, done) keeps one line for it under the
  control, present even when empty, and shows the most important message
  there, truncated with the full text in a tooltip. A status that must stay
  visible stays visible in that slot; visibility is never a reason to grow the
  container.
- **Grow away from the user's focus.** A row a composer mode adds goes above
  the input, so the field the user types into stays put.
- **States keep their size.** Selected, hover, active and loading states change
  colour and fill, never width, weight-driven reflow, padding or borders that
  appear from nothing. A button showing a spinner keeps its width; a skeleton
  matches what it stands in for; hover actions fade in over reserved space.
- **Collapse and expand** move only what is below them; the clicked header
  stays under the pointer.
- **Popups open where they fit.** Every dropdown, select, menu or picker
  opens toward the side with room for its options, never into a sliver at the
  window's edge (Mini Chat, a composer at the bottom or top). Base UI flips to
  the roomier side by default; keep that. A popup that must hold its side
  while open (a search field that stays put while results filter) turns flips
  off and takes its side from `usePopupSideOnOpen` (`components/ui/popup-side.ts`),
  with its search field on the trigger's edge. The composer's model and agent
  menus are a known exception: their search stays at the top when they open
  upward. Check every popup in the smallest window that shows it.

## Vertical space: content gets the height

Every row of chrome above the content is height the content loses. A surface
stacks as few rows as it can; the context panel refactor (#4687) is the
reference.

- **One header row per surface.** A surface's title, tabs, primary actions and
  its toggle for search share the header row it already has, rather than a
  header with a tabs row, a toolbar row and a search row under it. In the
  context panel a surface fills the panel header's toolbar slot
  (`ContextPanelHeaderToolbar`): Git puts its branch and sync controls there,
  the session context puts the session title there.
- **Name it once.** When a header or tab already names the surface or the
  session, the body shows no large title repeating it, and a generic label
  ("Context") steps aside when the surface brings its own toolbar.
- **Overflow before wrap.** A toolbar never wraps onto a second row. As width
  shrinks, the path or title truncates first, then trailing secondary actions
  move into a "More actions" menu; the primary ones stay visible (the docked
  Files toolbar).
- **Merge duplicate action rows.** Two neighbouring areas that each had a row
  of actions (the file tree and the editor) share one strip; the areas
  themselves keep their own bounds.
- **A second row carries state, never controls.** A row under the header earns
  its place only with status that belongs to the surface, such as Git's
  identity, pull request and upstream state.
- **Search where it is used.** A search that filters what the header switches
  between is a toggle in the header that opens in place (`theme-system`
  describes the toggle). A search that is the main way into a list, like the
  file tree's, stays a field at the top of that list.

## Size to content

A control is as wide as what it says, up to a cap where long values truncate:
dropdown triggers (chevron right after the value), segmented choices, chips,
buttons. Fill a column only for text fields in forms, where a full-width input
is the expected shape, and for canvases (editors, diffs, transcripts). A
segmented choice of two options stretched across a pane reads as two empty
bars.

## Composition

- **Icons sit in the line they label.** A decorative or kind icon goes inline at
  the start of the title, the size of its text; secondary lines start under the
  icon, at the row's edge. A separate leading column, with the title and
  subtitle stacked beside it, leaves the icon floating in a tall empty slot and
  wastes the width under it. The one exception is an identity mark the eye scans
  down a list, such as a brand logo or an avatar, kept no taller than the text
  block beside it.
- **One row, one line where it fits.** Question every piece of metadata before
  showing it: most rows read fine with the title alone. What earns its place
  joins on one line with ` · `, never a stacked subtitle and meta line.
  Truncate a long value with the full text in a tooltip rather than wrapping a
  list row.
- **Group by space before lines.** Related things sit close, unrelated things
  apart; a divider is the last resort.

## Text and density

- **Few words.** A label names the thing; a description adds only what the
  label does not say. Explanations go behind an info hint, warnings and status
  stay visible (`settings-ui-patterns` owns the Settings policy). Wording rules
  are in `locale-ui-patterns` and `communication-style`.
- **Readable secondary text.** Secondary text is `text-muted-foreground` at
  full strength, never a fraction of it (`/50`, `/70`): every theme keeps the
  muted colour at 4.5:1, and an opacity on top drops it below. A quieter step
  between body and muted text mixes the two instead: `oc-title-rest` for a
  list title at rest, `oc-group-label` for a container's label. Only text
  nobody needs to read may fade: separators (`·`, `/`), disabled controls,
  calendar days outside the month, large empty-state illustrations. Never
  muted text on a muted fill, or a list whose every line is grey.
- **Dense, not cramped.** Rows are compact; tap targets meet the mobile touch
  floor; text never drops below the typography scale for density's sake.

## States

- Hover fills only what is clickable. Text-like buttons and list rows show
  hover by colour (text at 80% turning full) rather than a fill; sidebar
  session rows are the exception and keep their faint fill.
- Selection uses the selection tokens; primary colour means "act", never
  "chosen".
- Tooltips on dense rows open above their element so they never cover the
  neighbouring actions.

## Review before finishing

A UI change is done when each holds on the changed screens:

- every surface follows the depth rule, with no box inside a box and no line
  without a meaning;
- interacting with each control moves nothing it did not touch, and each
  popup opens toward the room in the smallest window that shows it;
- no surface stacks a header, tabs, toolbar and search as separate rows, and
  no toolbar wraps;
- controls hug their content; only form fields and canvases fill;
- icons sit inline, rows read in one line where they fit;
- the screen was checked in both light and dark themes.
