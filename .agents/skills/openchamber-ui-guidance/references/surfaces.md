# Surfaces and controls

Which class gives each surface of the depth rule, and the traps that undo it.
All classes live in `packages/ui/src/styles/design-system.css`; that file is
the source of the values. Its comments say why each value is what it is.

## Pick the surface

| Element | Class | Notes |
|---|---|---|
| Card, list tile, group, collapsible card | `oc-tile` | No border. Add `oc-tile-hover` when the whole tile or its header row is clickable. |
| Block inside a tile: icon square, neutral pill, nested list, chip, keycap | `oc-tile-inset` | One tone step above its parent, so it reads on a tile, the canvas or a dialog. |
| Text field, hand-rolled field wrapper, textarea box | `oc-raised oc-field` | Focus brightens the hairline; `aria-invalid` or `data-invalid` turns it red. No `border`, no `focus-within:ring`. |
| Dropdown trigger | `dropdownTriggerVariants()` / `SelectTrigger` | Already raised and hugging its value; call sites add only a `max-w-*` cap. |
| Button | `Button` variants | `default`/`destructive`/`info` keep a tinted border and add `oc-raised-button`; `outline`/`neutral` are `oc-raised` with no border; `ghost`, `chip`, `link` stay flat. |
| Choice of one among a few | `SettingsChipGroup`, or `SortableTabsStrip variant="active-pill"` for tabs | A recessed track (`oc-recessed`) with the chosen option raised. Independent toggles stay chips. |
| Menu, popover, autocomplete, floating comment field | `oc-glass-popover oc-glass-floating` | No border and no extra `shadow-*` on it or a wrapper: either replaces the light. |
| Surface always on screen over the transcript (composer, status pills) | `oc-surface-floating` + `oc-glass-floating` | Opaque on purpose: a blur there is redrawn every streamed frame. The composer adds `oc-composer-sheen`. |
| Panel in the layout beside the chat (context panel card, work status card) | `oc-panel-edge` | A hairline ring and a short shadow, plus a faint lit top line in dark themes. Its page colour is the sidebar's (the theme's muted surface; halfway to it in light themes): JS-painted surfaces inside take it from `usePageColors`; it gains the full dropdown edge only while floating over the chat. |
| Modal window | `DialogContent` (`oc-modal-shadow`) | Canvas tone (`bg-background`), the same as the Settings window; a sticky header inside paints `bg-background` too. No `border`: the shadow carries the half-pixel ring. Focus on open goes to the first text field, else the window, so no ring lands on the close cross. |
| Banner: warning, error, info | status background fill | No border. A very faint fill gets a stronger tint rather than a border back. |
| Large code canvas (Files editor and tree, a diff) | its existing frame | The one place a full border stays: without it the canvas merges with the page. |

## Elevation and edge tokens

All in `design-system.css`; the surface classes above are built on them.

| Token | Use |
|---|---|
| `--oc-elevation-button` / `-raised` / `-floating` | The three lifts. Tailwind's `shadow-sm` / `shadow-md` / `shadow-lg` (and `shadow-xl`) map onto them, so a call site's `shadow-*` lands on the same scale. |
| `--oc-elevation-ring` | The half-pixel ring alone, for an inset edge where an outer one would be clipped (`oc-panel-edge`). |
| `border-edge-muted` / `border-edge` / `border-edge-strong` | Lines at 40%, 70% and 100% of the theme's border colour (also `bg-`, `divide-`). Muted for quiet dividers, base for a frame, strong for what must hold its shape. Pick a level; an opacity of `border-border` is the old way. |

A line between layout regions is a half-pixel inset hairline in
`--oc-edge-strong` drawn as a shadow, so it takes no width (the sidebar's
edge).

## Light and dark

Light themes paint `--surface-elevated` darker than the canvas. So in light
themes a raised control takes the canvas colour
(`bg-[var(--surface-background)] dark:bg-surface-elevated`) and lifts on a
short shadow, while a text field is pressed into the page by a faint inner
shadow.

Tone steps (`oc-tile`, `oc-tile-inset`, `oc-tile-hover`) mix the text colour
into whatever is underneath, so one class reads correctly in both themes and
on any parent. `--surface-muted` is darker than the canvas in dark themes:
used as a fill inside a tile it makes a dark hole with a visible edge.

## Traps that silently undo the look

- **A call site's own shadow replaces the light.** `oc-raised`, `oc-field`,
  `oc-tile*` and `oc-raised-button` sit in `@layer components`, so any
  `shadow-*` utility on the same element wins. That is how a chromeless field
  drops its edge on purpose (`shadow-none`), and how an accidental
  `shadow-[...]` flattens a control. `oc-glass-floating` is unlayered; a
  shadow on a wrapper around it doubles up.
- **A dark-mode background does not merge away.** A raised control's base
  carries `dark:bg-surface-elevated`. A call site that sets `bg-transparent`
  must also set `dark:bg-transparent`, or the dark theme paints it anyway.
- **`Button variant="outline"` around a trigger** brings its own surface back.
  Wrap trigger styling in `variant="ghost"`.
- **A background-image hover replaces the sheen.** Hover and focus overlays are
  `background-image` gradients; on a dark raised control they stand in for the
  sheen while active. That is intended; do not add a second sheen.
- **Rules on `.chat-message-column` repeat.** Message columns nest (a turn's
  activity sits inside one), so a width or padding rule on the column applies
  at every level. Space the transcript on its scroller (`.chat-scroll`).
- **Focus utilities are inert.** A global unlayered rule clears every `ring-*`
  on `:focus-visible`. Leave `focus-visible:ring-*` and
  `focus-visible:border-ring` off new code.

## Extensions follow the app

Shared controls and their SDK UI kit twins follow `theme-system`, *Button Contract*.
