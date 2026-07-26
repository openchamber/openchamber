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

Settings are built from the shared primitives in
`packages/ui/src/components/sections/shared/SettingsSection.tsx`,
`SettingsPageLayout.tsx`, and `SettingsInfoHint.tsx`. Never hand-roll page
chrome, section headers, field rows, checkbox rows, or info tooltips with raw
divs — use the primitives, and extend them (in the shared file) when a new
shape is genuinely missing.

- Flat hierarchy through spacing and typography; no cards, boxed backgrounds, or row chrome.
- Secondary helper text is hidden behind an info icon (`info` prop); the default view stays quiet.
- Controls have one standard size (`h-9` / select `size="settings"`) and capped widths — no full-bleed inputs.
- Layouts respond to the settings pane width via container queries (`@xl:` / `@3xl:`), never viewport `sm:`/`lg:` breakpoints (the pane is much narrower than the viewport inside the dialog).
- Checkbox/radio state comes before labels; selected states are subtle and never shift layout.

## Load References By Task

| Task | Required reference |
|---|---|
| Page skeleton, sections, hierarchy, nav placement, spacing, columns, responsiveness | `references/layout.md` |
| Field rows, checkboxes, radios, chips, selects, inputs, numeric steppers, info hints | `references/controls.md` |
| Adding/moving controls, pages, availability, anchors, or search entries | `references/search.md` |

Load every matching reference before editing.

## Quick Primitive Selection

| Need | Shared primitive |
|---|---|
| Page wrapper (title, description, save status, scrolling, `@container`) | `SettingsPageLayout` |
| Titled block with divider | `SettingsSection` (`divider={false}` for the first one) |
| Label left / control right | `SettingsFieldRow` |
| Label above control (two-column cells, wide controls) | `SettingsStackedField` |
| Boolean | `SettingsCheckboxRow` |
| Mutually exclusive list | `SettingsRadioGroup` + `SettingsRadioOption` |
| Short segmented options | `SettingsChipGroup` |
| Sub-cluster with a quiet L3 title inside a section | `SettingsControlGroup` |
| Two-column area on wide panes | `SettingsTwoColumn` |
| Helper text on demand (hover + tap) | `info` prop or `SettingsInfoHint` |

Do not introduce raw `<Tooltip>`-based info icons, direct Remixicon components, hardcoded user-facing strings, or one-off color/button systems. New icons: reference a Remix icon name in code, then run `bun run icons:generate` to add it to the sprite.

## Description Policy (info hints)

- Explanatory prose (what a feature does, when it applies) goes behind the info icon via the `info` prop — never as always-visible `description`.
- Stays visible: security/data-loss warnings, destructive consequences, required syntax/placeholder lists the user reads while typing, dynamic status, empty states, validation errors, active-flow wizard instructions.
- Mixed text: keep the warning sentence visible, move the explanation to `info`.

## Save Feedback

`SettingsPageLayout showSaveStatus` renders the shared quiet indicator: success is silent, "Saving…" appears only past ~500 ms, failures show "Save failed". Anything persisted through `updateDesktopSettings` reports automatically; page-specific APIs must call `reportSettingsSaveState` from `@/lib/persistence`. Never add per-page save badges or success toasts for ordinary setting writes.

## Settings Search Contract

Every stable Settings control addition or move must consider search in the same change:

- explicit registry item in `packages/ui/src/lib/settings/search.ts` when searchable;
- matching `data-settings-item` anchor (primitives accept `settingsItem`);
- localized title/description keys;
- availability matching actual render conditions;
- when a control moves to another page, update the item's `page` too.

Dynamic entity rows normally are not indexed. Load `references/search.md` for exact rules.

## Review Checklist

- Built from shared primitives; no ad-hoc page/section/row markup.
- Explanatory text hidden behind `info`; warnings/syntax/status still visible.
- Container-query (`@xl:`/`@3xl:`) responsiveness — no viewport breakpoints in pane content.
- Controls use the standard size and width caps; no stretched full-width inputs.
- Localized visible and accessibility text everywhere.
- Search registry, anchor, page, localization, and availability agree.
- Nearby Settings precedent and relevant tests remain consistent.
