---
name: theme-system
description: Use when creating or modifying OpenChamber UI components, styling, colors, buttons, visual states, themes, or icons.
---

# Theme System

## Core Rules

- Use semantic OpenChamber theme tokens; never hardcode hex colors or generic Tailwind palette colors.
- Use shared UI primitives before introducing feature-local controls.
- Use the shared `Button`; do not create button wrappers such as `ButtonSmall` or `ButtonLarge`.
- Every dropdown-style value-picker trigger takes its chrome from `dropdownTriggerVariants` in `packages/ui/src/components/ui/dropdown-trigger.ts`; call sites add layout classes only. Deliberately chrome-less pickers in composers or headers are the exception.
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

Load every matching reference before editing. User-facing or accessible text must load `locale-ui-patterns`. Settings composition is owned by `settings-ui-patterns`, which declares `theme-system` as its one-way companion.

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

## Keyboard Navigation Contract

- Menus, selects, and autocomplete pickers with ArrowDown/ArrowUp navigation must also support Ctrl+N/Ctrl+P, including submenus and searchable lists.
- Keep this behavior in shared components so callers inherit it. Use the keyboard mapping in `packages/ui/src/components/ui/dropdown-navigation.ts`; feature code must not duplicate key detection.
- Lists that own their active option or stop keyboard propagation must call the shared navigation helper at their own event boundary. Wrapping a custom list in a dropdown does not guarantee that its navigation events reach the wrapper.
- Route both key pairs through the same selection logic, preserving disabled-item skipping, boundary or wrap behavior, highlight, and scroll visibility. Consume each navigation event once, only while the menu or picker is active; preserve IME text entry and other modifier chords.
- Verify Ctrl+N/P alongside arrow keys in the real component, including search-input focus, submenus, and closed state. A key-mapping unit test alone does not verify event propagation or focus behavior.

## Icon Contract

```tsx
import { Icon } from '@/components/icon/Icon';

<Icon name="check" className="size-4" />
```

Use `IconName` for icon values stored in arrays, objects, state, or config. `Icon` has no `size` prop. Run `bun run icons:generate` when introducing a sprite name, and never edit `sprite.ts` manually. Load `references/icons.md` for the complete workflow.

## Animation Contract

Animate only `transform` and `opacity`. Use `transform: rotate(...)`, not the individual `rotate` property. Non-composited properties recalculate style continuously; geometry also triggers layout, and wrappers, `will-change`, `contain`, or stepped timing do not remove that cost. Animate only while conveying live information.

For any other technique, load `performance-engineering` and `scripts/perf/DOCUMENTATION.md`, measure it with `bun run profile:animation`, and add a fixture variant when needed. This skill owns animation styling; `performance-engineering` owns performance evidence.

## Completion Criteria

- Animations are limited to `transform` and `opacity`, or their cost was measured and accepted.
- No hardcoded/palette colors were introduced.
- Buttons use shared variants and sizes.
- Menus and pickers satisfy the keyboard navigation contract without caller-specific key handling for standard shared components.
- Icons use `Icon`/`IconName`, and generated sprite changes are intentional.
- Hover, selection, primary, and status semantics are distinct.
- Light/dark/high-contrast and long-text states remain legible.
- Every applicable contract and loaded task reference was verified with relevant type-check, visual/runtime validation, and generated-asset checks.
