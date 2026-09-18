# Theme Tokens And Examples

## Token Families

### Surface

| Token | Usage |
|---|---|
| `surface.background` | Main app background |
| `surface.elevated` | Inputs, cards, dialogs, dropdowns, popovers |
| `surface.elevatedForeground` | Text and neutral controls on elevated surfaces |
| `surface.muted` | Secondary backgrounds and sidebars |
| `surface.foreground` | Primary text |
| `surface.mutedForeground` | Secondary text and hints |
| `surface.subtle` | Quiet, non-interactive background accents |

### Interactive

| Token | Usage |
|---|---|
| `interactive.border` | Default borders |
| `interactive.hover` | Hover on clickable elements only |
| `interactive.active` | Pressed interaction state |
| `interactive.selection` | Active/selected items |
| `interactive.selectionForeground` | Text on selection |
| `interactive.focusRing` | Focus indicators |

### Status

Use status colors only for actual feedback.

- `status.error`: errors and validation failures
- `status.warning`: cautions
- `status.success`: successful outcomes
- `status.info`: informational feedback

Each family may expose foreground, background, and border variants.

`status.*Foreground` is text on a solid status fill. On a tinted status background,
use the computed `--status-error-text`, `--status-warning-text`,
`--status-success-text` or `--status-info-text`. Tinted buttons use the shared
Button variants, whose labels are contrast-adjusted independently of the fill.

### Primary

- `primary.base`: primary CTA
- `primary.hover`: primary hover
- `primary.foreground`: content on primary

Primary means “act”; selection means “currently active.” Do not use primary to mark ordinary selected tabs or rows.

### Syntax

Use `syntax.*` for code display: backgrounds/text, keywords, strings and diff highlights. Agent and Git-identity markers may reuse the palette to distinguish entities; those colors carry no status meaning. Layout surfaces, borders and interaction states use their own roles.

Build's agent identity intentionally stays on `status.success`. Reserve that
visible color when allocating syntax colors to other agents.

## Usage

Prefer semantic utility classes when available:

```tsx
<div className="bg-[var(--surface-elevated)] text-foreground" />
<button className="hover:bg-interactive-hover" />
```

Use `useThemeSystem()` when a library/API requires actual color values:

```tsx
const { currentTheme } = useThemeSystem();

<Chart color={currentTheme.colors.status.error} />
```

## Common Patterns

### Input Area

```tsx
<div className="bg-[var(--surface-elevated)]">
  <textarea className="bg-transparent" />
  <div className="bg-transparent">...</div>
</div>
```

Input footers stay transparent over the elevated input surface.

Inputs, cards, dropdowns and dialogs use the elevated role. Component-level
opacity is allowed; it changes the strength of the same semantic surface.

`oc-surface-elevated` establishes the elevated text context for children that use
`text-foreground`. Glass popovers, tooltips and composers do this automatically,
as do the semantic `bg-surface-elevated`, `bg-card` and `bg-popover` classes.
An opaque `bg-background` or `bg-surface-background` restores canvas text.
Use `oc-surface-code` for code text and `syntax.background` for its painted body.
Fields retain their elevated base on hover and layer `interactive.hover` over it;
`subtle` is neither hover nor disabled state. Dividers use `interactive.border`.

Focus uses `interactive.focusRing` (`ring-ring`), not the primary action color.
Keep focus indicators on the real focused control; global rules must not erase them.

### Active Item

```tsx
<button className={isActive
  ? 'bg-interactive-selection text-interactive-selection-foreground'
  : 'hover:bg-interactive-hover'
} />
```

### Error Feedback

```tsx
<div className="bg-[var(--status-error-background)] text-[var(--status-error-text)]" />
```

### Neutral Card

```tsx
<section className="bg-[var(--surface-elevated)] text-foreground">
  <p className="text-muted-foreground">...</p>
</section>
```

## Wrong Patterns

```tsx
<div style={{ backgroundColor: '#F2F0E5' }} />
<button className="bg-blue-500" />
<div className="hover:bg-interactive-hover">Static content</div>
<Tab className="bg-primary">Active</Tab>
```

Use theme tokens, apply hover only to interactive elements, and distinguish selection from primary actions.
