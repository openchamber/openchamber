---
name: settings-ui-patterns
description: Use when creating or modifying UI components, styling, or visual elements related to Settings in OpenChamber.
license: MIT
compatibility: opencode
---

# Settings UI Patterns Skill

## Purpose
This skill provides instructions for creating or redesigning Settings pages, informational panels, and configuration interfaces within the OpenChamber application.

## Current Canonical Look (2026)
Use this as source of truth for new settings UI work.

- **Flat hierarchy first**: Prefer spacing + typography hierarchy over boxed backgrounds.
- **No unnecessary wrappers**: Avoid extra section wrappers that mix unrelated controls.
- **No redundant section titles**: Do not add headers like `Theme Preferences` or `Scaling & Layout` when controls are already self-explanatory.
- **Compact controls**: Option chips and radio rows should be dense, not tall.
- **Left-leading state icon**: Radio/checkbox state icon appears before text.
- **Subtle state contrast**: Inactive radio labels should be visibly dimmer than active labels.
- **Minimal row chrome**: Avoid row hover/background highlighting by default; keep only where explicitly needed.

## Typography Guidelines
Always utilize the standard OpenChamber typography classes defined in `packages/ui/src/lib/typography.ts`.

- **Page Title**: Use `typography-ui-header font-semibold text-foreground` for the top-most title of a settings page/dialog.
- **Section Header**: Use `typography-ui-header font-medium text-foreground` for settings sections (e.g. `Notification Events`, `Session Defaults`).
- **Control Group Header**: Use `typography-ui-header font-medium text-foreground` (or `font-normal` if it reads too loud) for grouped controls inside a section (e.g. `Default Tool Output`, `Diff Layout`).
- **Values / Primary Text**: Use `typography-ui-label text-foreground`. Add `tabular-nums` if displaying numbers or stats to ensure vertical alignment.
- **Option Labels**: Use non-bold label text in compact option controls (`font-normal` when needed to override).
- **Meta / Helper Text**: Use `typography-meta text-muted-foreground` or `typography-small text-muted-foreground` for supplemental text.

## Layout and Spacing Patterns

### 1. Main Backgrounds
Main wrappers should generally use `bg-background` or `bg-[var(--surface-background)]`. Ensure adequate padding (e.g., `px-5 py-6` or `p-6`).

### 2. Subsection Grouping
Group related controls with vertical spacing, not mandatory cards.

- Use `space-y-3` between logical subsections.
- Use `p-2` for subsection internal padding.
- Avoid adding `bg-[var(--surface-elevated)]` unless there is a clear reason.
- Avoid extra row decorations (`rounded-md`, hover fills) unless there is explicit UX value.

### 3. Header-to-Content Hierarchy (critical)
When removing cards/background wrappers, spacing must be rebalanced so header ownership stays clear.

- Keep **section-to-section spacing larger** than **header-to-own-content spacing**.
- Typical pattern:
  - header wrapper `mb-1 px-1`
  - content wrapper `pt-0 pb-2 px-2`
  - outer section spacing `mb-8`
- Do not leave legacy `mb-3` style gaps after flattening a section; it makes headers look detached.

### 4. Headerless Blocks (when context is obvious)
If the page title already provides enough context, remove redundant local headers and place controls directly below the title.

- Example: project page identity controls can sit directly under project name/path.
- Tighten top gap for this pattern (e.g. top header `mb-4` instead of larger section spacing).

```tsx
<div className="space-y-3">
  <section className="p-2">...</section>
  <section className="p-2">...</section>
</div>
```

## Structural Patterns

### 1. Segmented Option Buttons (compact)
Use for short option sets where button-style segmented choice reads best (e.g. Default Tool Output).

```tsx
<div className="mt-1 flex flex-wrap items-center gap-1">
  <ButtonSmall
    variant="outline"
    size="xs"
    className={cn('!font-normal', isSelected ? 'border-[var(--primary-base)] text-[var(--primary-base)] bg-[var(--primary-base)]/10' : 'text-foreground')}
  >
    Collapsed
  </ButtonSmall>
</div>
```

### 2. Radio Option Lists (compact rows)
Use for mutually exclusive mode/layout settings (e.g. Diff Layout, Diff View Mode).

- Use shared `Radio` component from `@/components/ui/radio`.
- Icon first, label second.
- Row container compact: `py-0.5`.
- Inactive label can use `text-foreground/50`.

```tsx
<div role="radiogroup" aria-label="Diff layout" className="mt-1 space-y-0">
  <div className="flex w-full items-center gap-2 py-0.5">
    <Radio checked={selected} onChange={onSelect} ariaLabel="Diff layout: Dynamic" />
    <span className={cn('typography-ui-label font-normal', selected ? 'text-foreground' : 'text-foreground/50')}>Dynamic</span>
  </div>
</div>
```

### 3. Checkbox Setting Rows
Use shared `Checkbox` component from `@/components/ui/checkbox` for boolean toggles.

- Icon first, text immediately after (`gap-2`).
- Typical row spacing for checkbox rows: `py-1.5`.
- Keep row click and keyboard toggle support.
- Prefer checkbox over binary show/hide button pairs for pure boolean state.

```tsx
<div
  className="group flex cursor-pointer items-center gap-2 py-1.5"
  role="button"
  tabIndex={0}
>
  <Checkbox checked={value} onChange={setValue} ariaLabel="Show Dotfiles" />
  <span className="typography-ui-label text-foreground">Show Dotfiles</span>
</div>
```

### 4. Invisible Two-Column Alignment
Use consistent label/control columns across settings rows so controls align on a shared vertical line.

- Desktop row pattern: `flex items-center gap-8`
- Label column width: `w-56 shrink-0`
- Control cluster: `w-fit`

```tsx
<div className="flex items-center gap-8 py-1.5">
  <span className="typography-ui-label text-foreground w-56 shrink-0">Interface Font Size</span>
  <div className="flex items-center gap-2 w-fit">...</div>
</div>
```

#### Disabled control rule
If a control is unavailable, disable the control only. Do not dim the label row by default.

#### Width-matching rule
When matching visual widths across different rows, compare full row footprint (control + adjacent action buttons), not just input width.

### 5. Theme Row Composition
For theme controls in Appearance:

- `Color Mode` header on first line; option chips below it.
- `Light Theme` and `Dark Theme` on one row where possible, wrapping on small widths.
- Keep selectors near labels and aligned to existing column rhythm.
- Replace persistent helper text with an info tooltip icon near the related action.

```tsx
<div className="grid grid-cols-1 gap-2 py-1.5 md:grid-cols-[14rem_auto] md:gap-x-8 md:gap-y-2">
  <div className="flex min-w-0 items-center gap-2">Light Theme ...</div>
  <div className="flex min-w-0 items-center gap-2">Dark Theme ...</div>
</div>
```

### 6. Numeric Controls in Settings
Use compact stepper input (`- value +`) plus reset button.

- Prefer shared `NumberInput` stepper style over slider + numeric combo in dense settings pages.
- Keep reset button adjacent to control (`gap-2`).
- Avoid using Tailwind `overflow-hidden` on mobile for controls; `packages/ui/src/styles/mobile.css` forces `.overflow-hidden { overflow-y: auto !important; }`.
  Use `overflow-x-hidden overflow-y-hidden` if you truly need clipping.
- Touch devices: `packages/ui/src/styles/mobile.css` enforces `min-height: 36px` on `button`. If you build custom segmented controls with `<button>`, ensure the container height can accommodate that (e.g. `h-9`).

#### Optional numeric overrides
For "override unless empty" fields (e.g. agent Temperature/Top P), keep the value optional and provide a fallback for stepping.

```tsx
<NumberInput
  value={temperature}
  fallbackValue={0.7}
  onValueChange={setTemperature}
  onClear={() => setTemperature(undefined)}
  min={0}
  max={2}
  step={0.1}
  inputMode="decimal"
  emptyLabel="—"
/>
```

```tsx
<div className="flex items-center gap-2 w-fit">
  <NumberInput value={fontSize} onValueChange={setFontSize} min={50} max={200} step={5} />
  <ButtonSmall variant="ghost" className="h-7 w-7 px-0">...</ButtonSmall>
</div>
```

### 7. Inputs and Select Triggers (settings density)
Keep form controls in settings compact and aligned.

- Prefer `Input` with `className="h-7"` in dense settings rows.
- Prefer default `SelectTrigger` sizing (avoid `size="lg"` in settings).
- For icon-only actions next to inputs, use `ButtonSmall` with `h-7 w-7 p-0`.

```tsx
<div className="flex items-center gap-2">
  <Input className="h-7" />
  <ButtonSmall variant="outline" size="xs" className="h-7 w-7 p-0" aria-label="Browse">
    <RiFolderLine className="h-4 w-4" />
  </ButtonSmall>
</div>
```

### 8. Template Grids (text fields)
For template-like settings (title/message pairs), use a simple grid and flat cells.

- Grid: `grid grid-cols-1 gap-2 md:grid-cols-2 md:gap-3`
- Cell: `section p-2`
- Field: `Input className="h-7"`

### 9. Icon/Color Picker Rows
For dense icon/color pickers in settings:

- Place options under the field label when they are a palette/grid choice.
- Use stable selected-state styling (`border`/`ring`/subtle background), avoid transform jumps (`scale-*`).
- Keep chip size compact (`h-7 w-7`) and spacing consistent (`gap-2`).

## Control Selection Rules

- **Use compact option buttons** for short, chip-like selection groups.
- **Use radios** for explicit mode/layout choices where list scanning is better.
- **Use checkboxes** for true/false settings.
- **Avoid show/hide button pairs** when a checkbox maps directly to the boolean.
- **Do not couple unrelated toggles** under one synthetic section header; keep hierarchy clear.

## Best Practices
- **Density**: Keep options compact; avoid oversized rows/chips in dense settings pages.
- **Consistency**: Reuse shared controls (`Checkbox`, `Radio`, `ButtonSmall size="xs"`) instead of inline icon logic.
- **Reuse via composition**: Prefer a single settings component with a `visibleSettings` subset (like `OpenChamberVisualSettings`) for multiple tabs (Appearance/Chat) instead of duplicating markup.
- **Hierarchy**: Page title = `font-semibold`; section header = `font-medium`; control group header = `font-medium` (or `font-normal` if needed); option labels = non-bold.
- **Subsection depth**: Nested subgroup headings under a section should usually be one step lighter than parent heading weight.
- **Hierarchy sanity check**: after flattening UI, verify visual grouping by spacing first (not color).
- **Helper blocks**: For small notes/errors under a section, use `mt-1 px-2` with `typography-meta text-muted-foreground/70` (and status token for errors).
- **Truncation**: Always consider long text. Use `min-w-0 flex-1 truncate` on text containers that sit next to buttons or icons to prevent layout breakage.
- **Theme Variables**: *Always* use CSS variables for colors (e.g., `var(--status-success)`) rather than hardcoded hex values or generic Tailwind colors when indicating semantic states.
