# Theme Tokens And Examples

## Token Families

### Surface

| Token | Usage |
|---|---|
| `surface.background` | Main app background |
| `surface.elevated` | Inputs, cards, panels, popovers |
| `surface.muted` | Secondary backgrounds and sidebars |
| `surface.foreground` | Primary text |
| `surface.mutedForeground` | Secondary text and hints |
| `surface.subtle` | Subtle dividers |

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

### Primary

- `primary.base`: primary CTA
- `primary.hover`: primary hover
- `primary.foreground`: content on primary

Primary means “act”; selection means “currently active.” Do not use primary to mark ordinary selected tabs or rows.

### Syntax

Use `syntax.*` only for code display: code backgrounds/text, keywords, strings, and diff highlights. Never use syntax colors for ordinary UI chrome.

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

### Active Item

```tsx
<button className={isActive
  ? 'bg-interactive-selection text-interactive-selection-foreground'
  : 'hover:bg-interactive-hover'
} />
```

### Error Feedback

```tsx
<div className="bg-[var(--status-error-background)] text-[var(--status-error-foreground)]" />
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
