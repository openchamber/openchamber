# Settings Layout

## Visual Hierarchy

- Prefer spacing and typography over boxed backgrounds.
- Avoid wrappers that mix unrelated controls.
- Omit redundant headings when page context already names the controls.
- Keep controls compact and row chrome minimal.
- Place checkbox/radio state before its label.
- Dim inactive option labels subtly; do not use transform jumps.

## Typography

Use classes from `packages/ui/src/lib/typography.ts`:

- Page title: `typography-ui-header font-semibold text-foreground`
- Section header: `typography-ui-header font-medium text-foreground`
- Control group: `typography-ui-header font-medium` or `font-normal` when needed
- Values/labels: `typography-ui-label text-foreground`
- Helper/meta: `typography-meta text-muted-foreground` or `typography-small text-muted-foreground`
- Numeric values: add `tabular-nums`

## Spacing

- Keep section-to-section spacing larger than header-to-content spacing.
- Typical flat section: header `mb-1 px-1`, content `pt-0 pb-2 px-2`, outer `mb-8`.
- Group related controls with `space-y-3` and modest internal padding such as `p-2`.
- Avoid elevated backgrounds, rounded rows, and hover fills without explicit UX value.

## Alignment

For consistent desktop columns:

```tsx
<div className="flex items-center gap-8 py-1.5">
  <span className="w-56 shrink-0 typography-ui-label">{t(labelKey)}</span>
  <div className="flex w-fit items-center gap-2">...</div>
</div>
```

- Let narrow layouts stack or wrap.
- Compare the complete control footprint, including adjacent actions, when matching widths.
- Disable only the unavailable control; do not dim the entire label row by default.

## Responsive Grids

Use a one-column base and introduce columns at a deliberate breakpoint:

```tsx
<div className="grid grid-cols-1 gap-2 md:grid-cols-[14rem_auto] md:gap-x-8" />
```

Template fields commonly use `grid grid-cols-1 gap-2 md:grid-cols-2 md:gap-3` with flat `p-2` cells.
