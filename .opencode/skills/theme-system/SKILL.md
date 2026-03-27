---
name: theme-system
description: Use when creating or modifying UI components, styling, or visual elements in OpenChamber. All UI colors must use theme tokens - never hardcoded values or Tailwind color classes.
license: MIT
compatibility: opencode
---

## Overview

OpenChamber uses a JSON-based theme system. Themes are defined in `packages/ui/src/lib/theme/themes/`. Users can also add custom themes via `~/.config/openchamber/themes/`.

**Core principle:** UI colors must use theme tokens - never hardcoded hex colors or Tailwind color classes.

## When to Use

- Creating or modifying UI components
- Working with colors, backgrounds, borders, or text

## Quick Decision Tree

1. **Code display?** → `syntax.*`
2. **Feedback/status?** → `status.*`
3. **Primary CTA?** → `primary.*`
4. **Interactive/clickable?** → `interactive.*`
5. **Background layer?** → `surface.*`
6. **Text?** → `surface.foreground` or `surface.mutedForeground`

## Critical Rules

- `surface.elevated` = inputs, cards, panels
- `interactive.hover` = **ONLY on clickable elements**
- `interactive.selection` = active/selected states (not primary!)
- Status colors = **ONLY for actual feedback** (errors, warnings, success)
- Input footers = `bg-transparent` on elevated background

## Button Rules (MANDATORY)

Use only the shared `Button` component from `packages/ui/src/components/ui/button.tsx`.

- Do not create wrapper button components (for example `ButtonLarge`, `ButtonSmall`).
- Do not hardcode button height/padding classes when a `size` variant exists.
- Use semantic button variants consistently; avoid ad-hoc one-off button styling.

### Allowed Button Variants

| Variant | Use for | Token direction |
|-------|-------|-------|
| `default` | Primary action in a local section/dialog | `primary.*` |
| `outline` | Secondary visible action | `surface.elevated` + `interactive.*` |
| `secondary` | Soft secondary action | `interactive.hover` / `interactive.active` |
| `ghost` | Low-emphasis row/toolbar action | transparent + `interactive.hover` |
| `destructive` | Destructive actions (`Delete`, `Revert all`) | `status.error*` |
| `link` | Rare inline text action only | text-link style |

### Allowed Button Sizes

| Size | Use for |
|------|---------|
| `xs` | Dense controls in rows/lists |
| `sm` | Default compact action buttons |
| `default` | Standard form/page actions |
| `lg` | Prominent large actions |
| `icon` | Icon-only square button |

### Button Selection Quick Guide

1. Main CTA in section/dialog -> `default`
2. Side action next to CTA -> `outline`
3. Quiet auxiliary action -> `ghost`
4. Dangerous action -> `destructive`
5. Tiny row action -> keep same variant, set `size="xs"`

### Never Use

- Hardcoded hex colors (`#FF0000`)
- Tailwind colors (`bg-white`, `text-blue-500`, `bg-gray-*`)
- Deprecated: `bg-secondary`, `bg-muted`

## Usage

### Via Hook
```tsx
import { useThemeSystem } from '@/contexts/useThemeSystem';
const { currentTheme } = useThemeSystem();

<div style={{ backgroundColor: currentTheme.colors.surface.elevated }}>
```

### Via CSS Variables
```tsx
<div className="bg-[var(--surface-elevated)] hover:bg-[var(--interactive-hover)]">
```

## Color Tokens

### Surface Colors

| Token | Usage |
|-------|-------|
| `surface.background` | Main app background |
| `surface.elevated` | Inputs, cards, panels, popovers |
| `surface.muted` | Secondary backgrounds, sidebars |
| `surface.foreground` | Primary text |
| `surface.mutedForeground` | Secondary text, hints |
| `surface.subtle` | Subtle dividers |

### Interactive Colors

| Token | Usage |
|-------|-------|
| `interactive.border` | Default borders |
| `interactive.hover` | Hover on **clickable elements only** |
| `interactive.selection` | Active/selected items |
| `interactive.selectionForeground` | Text on selection |
| `interactive.focusRing` | Focus indicators |

### Status Colors

| Token | Usage |
|-------|-------|
| `status.error` | Errors, validation failures |
| `status.warning` | Warnings, cautions |
| `status.success` | Success messages |
| `status.info` | Informational messages |

Each has variants: `*`, `*Foreground`, `*Background`, `*Border`.

### Primary Colors

| Token | Usage |
|-------|-------|
| `primary.base` | Primary CTA buttons |
| `primary.hover` | Hover on primary elements |
| `primary.foreground` | Text on primary background |

**Primary vs Selection:** Primary = "click me" (CTA), Selection = "currently active" (state).

### Syntax Colors

For code display only. Never use for UI elements.

| Token | Usage |
|-------|-------|
| `syntax.base.background` | Code block background |
| `syntax.base.foreground` | Default code text |
| `syntax.base.keyword` | Keywords |
| `syntax.base.string` | Strings |
| `syntax.highlights.diffAdded` | Added lines |
| `syntax.highlights.diffRemoved` | Removed lines |

## Examples

### Input Area

```tsx
const { currentTheme } = useThemeSystem();

<div style={{ backgroundColor: currentTheme.colors.surface.elevated }}>
  <textarea className="bg-transparent" />
  <div className="bg-transparent">{/* Footer - transparent! */}</div>
</div>
```

### Active Tab

```tsx
<button className={isActive 
  ? 'bg-interactive-selection text-interactive-selection-foreground'
  : 'hover:bg-interactive-hover/50'
}>
```

### Error Message

```tsx
<div style={{ 
  color: currentTheme.colors.status.error,
  backgroundColor: currentTheme.colors.status.errorBackground 
}}>
```

### Card

```tsx
<div style={{ backgroundColor: currentTheme.colors.surface.elevated }}>
  <h3 style={{ color: currentTheme.colors.surface.foreground }}>Title</h3>
  <p style={{ color: currentTheme.colors.surface.mutedForeground }}>Description</p>
</div>
```

## Wrong vs Right

### Wrong

```tsx
// Hardcoded colors
<div style={{ backgroundColor: '#F2F0E5' }}>
<button className="bg-blue-500">

// Primary for active tab
<Tab className="bg-primary">Active</Tab>

// Hover on static element
<div className="hover:bg-interactive-hover">Static card</div>

// Colored footer on input
<div style={{ backgroundColor: currentTheme.colors.surface.elevated }}>
  <textarea />
  <div style={{ backgroundColor: currentTheme.colors.surface.muted }}>Footer</div>
</div>
```

### Right

```tsx
// Theme tokens
<div style={{ backgroundColor: currentTheme.colors.surface.elevated }}>
<button style={{ backgroundColor: currentTheme.colors.primary.base }}>

// Selection for active tab
<Tab style={{ backgroundColor: currentTheme.colors.interactive.selection }}>Active</Tab>

// Hover only on clickable
<button className="hover:bg-[var(--interactive-hover)]">Click</button>

// Transparent footer
<div style={{ backgroundColor: currentTheme.colors.surface.elevated }}>
  <textarea className="bg-transparent" />
  <div className="bg-transparent">Footer</div>
</div>
```

## References

- **[Adding Themes](references/adding-themes.md)** - Built-in and custom themes

## Key Files

- Theme types: `packages/ui/src/types/theme.ts`
- Theme hook: `packages/ui/src/contexts/useThemeSystem.ts`
- CSS generator: `packages/ui/src/lib/theme/cssGenerator.ts`
- Built-in themes: `packages/ui/src/lib/theme/themes/`
