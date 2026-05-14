# Icon System

OpenChamber uses an SVG sprite-based icon system for performance. All icons are rendered via a single hidden SVG sprite injected into the DOM, referenced by `<use href="#oc-icon-name"/>`.

## Usage

```tsx
import { Icon } from "@/components/icon/Icon";

<Icon name="arrow-down-s" className="h-4 w-4" />
<Icon name="loader-4" className="size-4 animate-spin" />
```

## Icon Names

Icons use kebab-case names based on Remixicon. To find an icon name:

1. Start from the Remixicon component name: `RiArrowDownSLine`
2. Remove `Ri` prefix → `ArrowDownSLine`
3. Convert to kebab-case → `arrow-down-s`

Common suffixes:
- `Line` / `Fill` are dropped from the sprite name
- Numbers are preserved: `RiChat4Line` → `chat-4`

## Adding a New Icon

1. Import and use it in your code: `<Icon name="new-icon-name" />`
2. Run `bun run icons:sprite` to regenerate the sprite with the new icon
3. The script scans `packages/ui/src` for all `RiX` usages and extracts SVG paths

If the icon doesn't exist in the sprite, the script will warn you.

## Sizing

The `Icon` component does not have a `size` prop. Use Tailwind classes instead:

```tsx
<Icon name="arrow-down-s" className="h-4 w-4" />   {/* 16px */}
<Icon name="arrow-down-s" className="size-5" />      {/* 20px */}
<Icon name="arrow-down-s" className="h-6 w-6" />     {/* 24px */}
```

## Type Safety

```tsx
import type { IconName } from "@/components/icon/icons";

const icon: IconName = "arrow-down-s"; // type-checked
```

## Architecture

- `sprite.ts` — Auto-generated SVG path data (run `bun run generate-icon-sprite` to regenerate)
- `Icon.tsx` — The `<Icon>` component, injects sprite on first mount
- `icons.ts` — TypeScript type `IconName`

The sprite is injected as a hidden `<svg id="openchamber-icon-sprite">` element containing `<symbol>` elements. Each `<Icon>` renders `<svg><use href="#oc-{name}"/></svg>`.

## Migration from @remixicon/react

Old:
```tsx
import { RiArrowDownSLine } from "@remixicon/react";
<RiArrowDownSLine className="h-4 w-4" />
```

New:
```tsx
import { Icon } from "@/components/icon/Icon";
<Icon name="arrow-down-s" className="h-4 w-4" />
```

If an icon is used as a component reference (not JSX):
```tsx
// Old: const icon = RiStackLine; return <icon />;
// New: const icon: IconName = "stack"; return <Icon name={icon} />;
```
