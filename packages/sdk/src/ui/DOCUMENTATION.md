# Guest UI kit

## Purpose

`@openchamber/sdk/ui` is a plain-DOM drawing kit for guest panels in the sandboxed iframe. Primitives only. The guest composes them into screens and owns the data. No React, no dependencies, no zod.

Do not import this from `packages/ui`. The iframe is not the host React tree.

## Entrypoints

Every `mountX(root, props)` returns `{ update(partial), dispose() }`.

- `theme.ts`: `applyHostReady(ctx, document.documentElement)` writes host tokens as CSS variables (both host names and `--oc-*` aliases) plus `data-oc-surface` / `data-oc-theme`. `applyHostTheme` writes tokens only.
- `button.ts`: `mountButton`. Variants `default` (tinted primary), `secondary`, `outline`, `ghost`, `destructive`; sizes `default` 36px, `sm` 32px, `xs` 24px. `loading` shows a ring and blocks clicks.
- `field.ts`: `mountTextField`. Input or textarea (`multiline`), optional label, helper, error, `password`, `mono`.
- `search.ts`: `mountSearchField`. Leading search icon, clear button when non-empty, Escape clears.
- `select.ts`: `mountSelect`. Trigger plus popup listbox. `searchable` adds a filter box; `filterSelectOptions` is the pure filter.
- `checkbox.ts`: `mountCheckbox` (`role="checkbox"`) and `mountSwitch` (`role="switch"`), same props.
- `tabs.ts`: `mountTabs`. Pill tabs, `role="tablist"`, left/right arrows move.
- `badge.ts`: `mountBadge`. Pill with `tone`. Also exports `applyTone`, used by list and progress.
- `list.ts`: `mountList`. `role="listbox"` rows with leading, title, subtitle, meta, badge. Up/down/home/end/enter.
- `navigation.ts`: `moveListSelection(items, currentId, key)` and `navigationKey(event)`. Pure; shared by list, select, menu, tabs. Ctrl+N / Ctrl+P mirror the arrows.
- `empty.ts`: `mountEmpty`. Centered title, body, optional outline `sm` button.
- `spinner.ts`: `mountSpinner`. 16px ring, `role="status"`.
- `banner.ts`: `mountBanner`. Toned box with title, body, optional `xs` outline action.
- `separator.ts`: `mountSeparator`. Hairline, optional label.
- `progress.ts`: `mountProgress`. `role="progressbar"`, value clamped to 0..100.
- `menu.ts`: `mountMenu`. Button trigger plus `role="menu"` popup. Items may be `destructive`, `disabled`, or `{ separator: true }`.
- `text.ts`: `mountText`. Plain text through `textContent`; `![alt](https://…)` becomes `img`, `[label](https://…)` becomes `a` that calls `onOpenUrl`. `splitTextMedia` is the pure splitter.
- `style.ts`: the one CSS string. `dom.ts` `ensureStyle` injects it once. `popup.ts` places fixed popups (flips above when short on room) and wires outside-click, resize, and scroll to close. `option.ts` is the popup row shared by select and menu. `icons.ts` holds the four inline SVG shapes.

## Invariants

- Call `applyHostReady` from `onReady` before the first mount. Without those tokens the kit has no colours.
- Colours come only from `var(--host-name, var(--oc-alias, fallback))`. No literal hex in `style.ts`.
- A mount paints from `props`. The only hidden state is UI state: open popup, highlighted row, typed filter. `update()` merges props and keeps that state unless the related prop changed.
- Every string lands through `textContent`. `mountText` is the only place that creates `a` and `img`, and only for `http(s)` URLs.
- `dispose()` removes the node and every listener, including the document and window listeners a popup added.
- Focus is `box-shadow` on `:focus-visible`, never `outline`. Disabled is `opacity: .5; pointer-events: none`.
- Popups render inside the mount wrapper with `position: fixed`; a transformed ancestor would break placement, so guests should not transform the kit's parents.
- Tests run in `bun:test` without a DOM. Test the pure helpers (`navigation.ts`, `filterSelectOptions`, `splitTextMedia`, `clampProgress`); keep painting thin.
