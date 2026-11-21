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

Follow the naming rules in `packages/ui/src/components/icon/README.md`.

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

## Provider Marks

A Git host or other provider mark (the `icon.path` in a server provider descriptor such as `packages/web/server/lib/forgejo/descriptor.js`) is the provider's real logo, redrawn in the line style of the other provider marks, never a generic drawing of what the name suggests:

- monochrome `currentColor`, a 24x24 box with about 2px inset, line weight about 2px like Remixicon;
- readable at 16px: simplify detail when it blurs (Gerrit's mark keeps one -/+ pair instead of two);
- when the logo's license requires attribution, credit it in a comment beside the path (Forgejo: CC BY-SA 4.0, by Caesar Schinas).

Gitea's teacup is OpenChamber's own drawing, not Gitea's logo; replacing it is an open product question.

## Key Files

- Component: `packages/ui/src/components/icon/Icon.tsx`
- Types: `packages/ui/src/components/icon/icons.ts`
- Generated sprite: `packages/ui/src/components/icon/sprite.ts`
- Generator: `scripts/generate-icon-sprite.mjs`
- Documentation: `packages/ui/src/components/icon/README.md`
