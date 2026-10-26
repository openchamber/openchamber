# Icon System

## Contract

Use `Icon` from `@/components/icon/Icon` and `IconName` from `@/components/icon/icons`. Do not import icon components directly from `@remixicon/react`.

```tsx
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';

<Icon name="arrow-down-s" className="size-4" />
```

`Icon` has no `size` prop. Size it with classes.

## Naming

Convert Remixicon names to sprite names:

1. Remove `Ri`.
2. Remove the `Line` suffix.
3. Convert PascalCase to lowercase kebab-case.
4. Preserve filled variants with explicit `-fill`.

| Remixicon | Sprite name |
|---|---|
| `RiArrowDownSLine` | `arrow-down-s` |
| `RiCheckLine` | `check` |
| `RiLoader4Line` | `loader-4` |
| `RiGithubFill` | `github-fill` |

## Config Values

Store icon names, not component references:

```tsx
const items: Array<{ icon: IconName }> = [{ icon: 'stack' }];

return <Icon name={items[0].icon} className="size-4" />;
```

Use literal inference (`as const`) only when the surrounding type does not already provide `IconName`.

## Adding An Icon

1. Use the correct kebab-case name in source.
2. Type non-JSX values as `IconName`.
3. Run `bun run icons:generate`.
4. Inspect generated changes and run relevant type-check/build validation.

Never edit `packages/ui/src/components/icon/sprite.ts` manually. The generator scans source usages, maps names to Remixicon, and regenerates the sprite.

## Key Files

- Component: `packages/ui/src/components/icon/Icon.tsx`
- Types: `packages/ui/src/components/icon/icons.ts`
- Generated sprite: `packages/ui/src/components/icon/sprite.ts`
- Generator: `scripts/generate-icon-sprite.mjs`
- Documentation: `packages/ui/src/components/icon/README.md`
