---
name: theme-system
description: Use when creating or modifying OpenChamber UI components, styling, colors, buttons, visual states, themes, or icons.
---

# Theme System

## Core Rules

- Use semantic OpenChamber theme tokens; never hardcode hex colors or generic Tailwind palette colors.
- Use shared UI primitives before introducing feature-local controls.
- Use the shared `Button`; do not create button wrappers such as `ButtonSmall` or `ButtonLarge`.
- Every dropdown-style value-picker trigger (shows current value, opens a picker) takes its chrome from `dropdownTriggerVariants` in `packages/ui/src/components/ui/dropdown-trigger.ts` (sizes: `sm` dense h-6, `default` forms h-8; native `SelectTrigger` consumes it). Call sites add layout classes only (width/truncation) — never re-declare border/radius/bg/hover. Deliberately chrome-less pickers (chat composer, headers) are the only exception.
- Use the sprite-based `Icon`; never import icons directly from `@remixicon/react`.
- Apply hover tokens only to interactive elements.
- Use status colors only for actual status/feedback.
- Use selection tokens for selected state and primary tokens for primary actions.

## Load References By Task

| Task | Required reference |
|---|---|
| Choosing colors/tokens or reviewing styled examples | `references/tokens-and-examples.md` |
| Adding, converting, storing, or generating icons | `references/icons.md` |
| Adding built-in or custom themes | `references/adding-themes.md` |

Load every matching reference before editing. Settings work must also load `settings-ui-patterns`; user-facing or accessible text must load `locale-ui-patterns`.

## Token Decision

1. Code display -> `syntax.*`
2. Error/warning/success/info -> `status.*`
3. Primary CTA -> `primary.*`
4. Hover/pressed/focus -> `interactive.*`
5. Selected/active state -> `interactive.selection*`
6. Background/text/border layer -> `surface.*` and semantic utility classes

Prefer CSS variables/classes for component styling. Use `useThemeSystem()` only when an API requires resolved color values.

## Button Contract

Use `Button` from `packages/ui/src/components/ui/button.tsx`.

| Variant | Use |
|---|---|
| `default` | Primary local action |
| `outline` | Visible secondary action |
| `secondary` | Soft secondary action |
| `ghost` | Quiet row/toolbar action |
| `destructive` | Destructive action |
| `chip` | Compact selectable option with `aria-pressed` |
| `link` | Rare inline text action |

| Size | Use |
|---|---|
| `xs` | Dense row/list control |
| `sm` | Compact action |
| `default` | Standard action |
| `lg` | Prominent action |
| `icon` | Icon-only square action |

Do not hardcode button height/padding when a size variant exists. Do not recreate selection/destructive styling with ad-hoc classes.

## Icon Contract

```tsx
import { Icon } from '@/components/icon/Icon';

<Icon name="check" className="size-4" />
```

Use `IconName` for icon values stored in arrays, objects, state, or config. `Icon` has no `size` prop. Run `bun run icons:generate` when introducing a sprite name, and never edit `sprite.ts` manually. Load `references/icons.md` for the complete workflow.

## Verification

- No hardcoded/palette colors were introduced.
- Buttons use shared variants and sizes.
- Icons use `Icon`/`IconName`, and generated sprite changes are intentional.
- Hover, selection, primary, and status semantics are distinct.
- Light/dark/high-contrast and long-text states remain legible.
- Relevant type-check, visual/runtime validation, and generated-asset checks ran.
