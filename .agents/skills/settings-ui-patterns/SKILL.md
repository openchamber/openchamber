---
name: settings-ui-patterns
description: Use when creating or modifying OpenChamber Settings pages, dialogs, controls, configuration surfaces, responsive Settings layouts, or Settings search behavior.
---

# Settings UI Patterns

## Required Companion Skills

- Load `theme-system` for colors, buttons, icons, and visual states.
- Load `locale-ui-patterns` for every visible string, tooltip, placeholder, and accessible label.
- Load `ui-api-decoupling` when a setting reads/writes runtime data or adds a capability.

When examples conflict, shared component/theme and localization contracts win. Stop on unresolved material conflicts.

## Canonical Direction

- Prefer flat hierarchy built with spacing and typography.
- Avoid unnecessary cards, wrappers, row chrome, and redundant headings.
- Keep controls compact and align related rows consistently.
- Put checkbox/radio state before labels.
- Use subtle, stable selected-state styling without layout shifts.
- Preserve responsive wrapping/stacking and long-text behavior.

## Load References By Task

| Task | Required reference |
|---|---|
| Page hierarchy, typography, spacing, columns, responsive grids | `references/layout.md` |
| Chips, radios, checkboxes, numeric overrides, inputs, icon actions, pickers | `references/controls.md` |
| Adding/moving controls, pages, availability, anchors, or search entries | `references/search.md` |

Load every matching reference before editing.

## Quick Control Selection

| Need | Shared pattern |
|---|---|
| Short selectable options | `Button variant="chip" size="xs"` + `aria-pressed` |
| Mutually exclusive mode list | `Radio` rows |
| Boolean | `Checkbox` |
| Numeric value/override | `NumberInput` |
| Text/path | `Input` with shared adjacent actions |
| Icon-only action | `Button size="icon"` + sprite `Icon` + localized `aria-label` |

Do not introduce `ButtonSmall`, direct Remixicon components, hardcoded user-facing strings, or one-off color/button systems.

## Settings Search Contract

Every stable Settings control addition or move must consider search in the same change:

- explicit registry item in `packages/ui/src/lib/settings/search.ts` when searchable;
- matching `data-settings-item` anchor;
- localized title/description keys;
- availability matching actual render conditions;
- state preparation before highlighting conditional targets.

Dynamic entity rows normally are not indexed. Load `references/search.md` for exact rules.

## Review Checklist

- Hierarchy reads through spacing and typography without unnecessary boxes.
- Shared controls are used with localized visible/accessibility text.
- Desktop alignment degrades cleanly on narrow/mobile layouts.
- Disabled state affects the control, not unrelated labels, unless intentional.
- Long labels and adjacent actions do not overflow.
- Search registry, anchor, localization, and availability agree.
- Nearby Settings precedent and relevant tests remain consistent.
