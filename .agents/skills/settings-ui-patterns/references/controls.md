# Settings Controls

Load `theme-system` for button/icon/color contracts and `locale-ui-patterns` for every visible or accessible string.

## Choosing A Control

- Short chip-like option set: shared `Button variant="chip" size="xs"` with `aria-pressed`.
- Explicit mutually exclusive list: shared `Radio`.
- Boolean value: shared `Checkbox`, not paired show/hide buttons.
- Numeric value: shared `NumberInput`.
- Text/path value: shared `Input` plus shared actions.

Do not couple unrelated toggles beneath a synthetic heading.

## Segmented Option

```tsx
<Button variant="chip" size="xs" aria-pressed={isSelected}>
  {t(labelKey)}
</Button>
```

## Radio Row

```tsx
<div role="radiogroup" aria-label={t(groupLabelKey)}>
  <div className="flex items-center gap-2 py-0.5">
    <Radio checked={selected} onChange={onSelect} ariaLabel={t(labelKey)} />
    <span className={cn('typography-ui-label', selected ? 'text-foreground' : 'text-foreground/50')}>
      {t(labelKey)}
    </span>
  </div>
</div>
```

## Checkbox Row

```tsx
<div className="flex cursor-pointer items-center gap-2 py-1.5">
  <Checkbox checked={value} onChange={setValue} ariaLabel={t(labelKey)} />
  <span className="typography-ui-label">{t(labelKey)}</span>
</div>
```

Preserve row click and keyboard behavior when the container is interactive.

## Optional Numeric Override

Empty means “inherit/default.” Provide fallback stepping and explicit clear:

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

Keep reset adjacent. Prefer an info tooltip over persistent helper text when the explanation is secondary.

## Inputs And Icon Actions

```tsx
<div className="flex items-center gap-2">
  <Input className="h-7" />
  <Button variant="outline" size="icon" aria-label={t(browseLabelKey)}>
    <Icon name="folder" className="size-4" />
  </Button>
</div>
```

- Prefer compact inputs in dense rows.
- Avoid large select triggers in Settings.
- Use shared `Button` and sprite `Icon`, never wrapper buttons or direct Remixicon imports.

## Mobile Constraints

- `packages/ui/src/styles/mobile.css` may force `.overflow-hidden` to scroll; use explicit x/y clipping only when required.
- Touch CSS enforces minimum button height. Do not put custom segmented buttons in a container too short for them.

## Picker Rows

- Place icon/color palettes beneath their label.
- Keep option dimensions and gaps consistent.
- Use stable border/ring/background selection; avoid scale transforms that shift layout.
