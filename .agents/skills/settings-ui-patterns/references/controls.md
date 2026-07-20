# Settings Controls

Load `theme-system` for button/icon/color contracts and `locale-ui-patterns`
for every visible or accessible string. All primitives/constants come from
`packages/ui/src/components/sections/shared/SettingsSection.tsx` (+
`SettingsInfoHint.tsx`).

## Standard Sizes And Widths

One control size across Settings — `h-8`:

- `SelectTrigger`: `size={SETTINGS_SELECT_SIZE}` ('settings' → h-8, rounded-md, px-3).
- Custom dropdown triggers (ModelSelector / AgentSelector): `SETTINGS_CUSTOM_TRIGGER_CLASS`.
- Text `Input` next to dropdowns: `h-8 rounded-md px-3` (match the trigger footprint).
- Icon action next to a control: `SETTINGS_ICON_BUTTON_CLASS`.

Widths are capped — never let controls span the pane:

- Field-row control cluster / stacked-field default cap: `max-w-[24rem]` (built into `SettingsStackedField`; use `SETTINGS_CONTROL_CLUSTER_CLASS` elsewhere).
- Field-row selects: `SETTINGS_SELECT_ROW_TRIGGER_CLASS` (full width narrow, `@xl:w-56` wide).
- Stacked-field selects: `SETTINGS_SELECT_TRIGGER_CLASS` (fills the capped container).
- Genuinely full-width content (dialog textareas): opt out with `controlClassName="w-full max-w-none"`.

## Field Rows

```tsx
<SettingsFieldRow
  label={t('...label')}
  info={t('...hint')}                 // helper text behind the info icon
  settingsItem="page.some-setting"
>
  <Select …>
    <SelectTrigger size={SETTINGS_SELECT_SIZE} className={SETTINGS_SELECT_ROW_TRIGGER_CLASS} aria-label={t('...aria')}>…
```

Use `SettingsStackedField` (label above control) inside `SettingsTwoColumn`
cells or when the control is wide; same `info` / `settingsItem` props.

## Boolean

```tsx
<SettingsCheckboxRow
  checked={value}
  onChange={setValue}
  label={t('...label')}
  ariaLabel={t('...aria')}
  info={t('...explanation')}          // optional; see Description Policy
  settingsItem="page.some-setting"
/>
```

Row click + keyboard toggling are built in. A visible `description` is only
for text that must stay visible (warnings, dynamic status).

## Mutually Exclusive Options

```tsx
<SettingsRadioGroup aria-label={t('...group')}>
  <SettingsRadioOption selected={…} onSelect={…} label={t('...')} ariaLabel={t('...')} />
</SettingsRadioGroup>
```

Skip per-option descriptions when labels are self-explanatory. For short
segmented choices use `SettingsChipGroup` (chips with `aria-pressed`).

## Numeric Value / Override

`NumberInput` inside `SETTINGS_NUMBER_STEPPER_ROW_CLASS`, with
`SETTINGS_NUMBER_UNIT_CLASS` for the unit and an adjacent
`SETTINGS_ICON_BUTTON_CLASS` reset button. Never flex-grow the stepper.
Optional overrides: empty means "inherit"; provide `fallbackValue`,
`onClear`, `emptyLabel="—"`.

## Info Hints

`SettingsInfoHint` is the only info-icon implementation: it opens on hover
AND on click (touch devices have no hover), and closes on outside tap.
Prefer the `info` prop of the enclosing primitive; use the component
directly only next to raw labels/headings. Never build info icons from raw
`<Tooltip>` + `<Icon name="information">` — those don't work on mobile.

## Mobile Constraints

- `packages/ui/src/styles/mobile.css` may force `.overflow-hidden` to scroll; use explicit x/y clipping only when required.
- Touch CSS enforces minimum button height. Do not put custom segmented buttons in a container too short for them.

## Picker Rows

- Place icon/color palettes beneath their label.
- Keep option dimensions and gaps consistent.
- Use stable border/ring/background selection; avoid scale transforms that shift layout.

## Dialogs

Dialogs reuse the same primitives (`SettingsCheckboxRow`,
`SETTINGS_FIELD_LABEL_CLASS`, `SettingsStackedField`) and the same sizes.
Dividers between dialog form groups are acceptable; wizard step
instructions guiding an active flow stay visible (not behind info).
