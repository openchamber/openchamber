---
name: theme-system
description: Use when creating or modifying UI components, styling, visual elements, or icons in OpenChamber. All UI colors must use theme tokens - never hardcoded values or Tailwind color classes. All icons must use the shared Icon component from the SVG sprite system - never import from @remixicon/react directly.
license: MIT
compatibility: opencode
---

## Overview

OpenChamber uses a JSON-based theme system. Themes are defined in `packages/ui/src/lib/theme/themes/`. Users can also add custom themes via `~/.config/openchamber/themes/`.

**Core principle:** UI colors must use theme tokens - never hardcoded hex colors or Tailwind color classes.

## When to Use

- Creating or modifying UI components
- Working with colors, backgrounds, borders, or text
- **Working with icons — adding, changing, or creating icon usages**

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

## Icon System (MANDATORY)

OpenChamber uses an SVG sprite-based icon system. **Never import from `@remixicon/react`.** Always use the shared `Icon` component.

### Import

```tsx
import { Icon } from "@/components/icon/Icon";
import type { IconName } from "@/components/icon/icons";
```

### Usage

```tsx
<Icon name="arrow-down-s" className="h-4 w-4" />
<Icon name="loader-4" className="size-4 animate-spin" />
```

### Naming Convention

Convert Remixicon component names to kebab-case sprite names:

1. Strip `Ri` prefix
2. Strip `Line` suffix
3. Convert PascalCase to kebab-case
4. Lowercase everything

| Remixicon | Sprite name |
|-----------|-------------|
| `RiArrowDownSLine` | `arrow-down-s` |
| `RiCheckLine` | `check` |
| `RiLoader4Line` | `loader-4` |
| `RiGithubFill` | `github-fill` |
| `RiBrainAi3Line` | `brain-ai-3` |

### Fill Variants

For filled (solid) icon variants, append `-fill` explicitly. The generator tries `Line` suffix first, then `Fill`, then bare name.

```tsx
<Icon name="github-fill" />   {/* RiGithubFill */}
<Icon name="github" />        {/* RiGithubLine (default) */}
```

### Sizing

The `Icon` component has **no `size` prop**. Use Tailwind classes:

```tsx
<Icon name="check" className="h-4 w-4" />     {/* 16px - most common */}
<Icon name="check" className="size-5" />        {/* 20px */}
<Icon name="check" className="h-3 w-3" />       {/* 12px */}
```

### Adding a New Icon (Workflow)

**In order:**

1. Use the icon in code with the correct kebab-case name:
   ```tsx
   <Icon name="new-icon-name" className="h-4 w-4" />
   ```

2. If used as a value (not JSX), use `IconName` type:
   ```tsx
   const config = { icon: "new-icon-name" as const };
   ```

3. Regenerate the sprite:
   ```bash
   bun run icons:generate
   ```

4. The script scans all source files, reverse-maps to Remixicon names, extracts SVG paths, and regenerates `sprite.ts`.

5. Verify: `bun run type-check`

**Do NOT manually edit `sprite.ts`.** Always regenerate.

### Type Safety for Icon Values

When icons are stored in objects/arrays, change the type from `ComponentType` to `IconName` and render via `<Icon name={value} />`:

```tsx
// ❌ Old: component reference
const items = [{ icon: RiStackLine }];
return <items[0].icon className="h-4 w-4" />;

// ✅ New: IconName string
import type { IconName } from "@/components/icon/icons";
const items: { icon: IconName }[] = [{ icon: "stack" }];
return <Icon name={items[0].icon} className="h-4 w-4" />;
```

## Wrong vs Right

### Wrong

```tsx
// ❌ Importing from @remixicon/react
import { RiArrowDownSLine } from "@remixicon/react";
<RiArrowDownSLine className="h-4 w-4" />

// ❌ Hardcoded colors
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
// ✅ Using the Icon component
import { Icon } from "@/components/icon/Icon";
<Icon name="arrow-down-s" className="h-4 w-4" />

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
- Icon component: `packages/ui/src/components/icon/Icon.tsx`
- Icon sprite data: `packages/ui/src/components/icon/sprite.ts` (auto-generated)
- Icon types: `packages/ui/src/components/icon/icons.ts`
- Icon sprite generator: `scripts/generate-icon-sprite.mjs`
- Icon docs: `packages/ui/src/components/icon/README.md`
