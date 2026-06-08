---
title: Adding Themes
---

# Adding Themes

## Custom Themes (User)

Drop a JSON file into `~/.config/openchamber/themes/`. No rebuild needed.

1. Create theme file (e.g., `my-theme.json`)
2. In app: **Settings → Theme → Reload themes**
3. Select from dropdown

See `docs/CUSTOM_THEMES.md` for full format reference.

## Built-in Themes (Development)

### 1. Create JSON Files

Add to `packages/ui/src/lib/theme/themes/`:
- `<id>-light.json`
- `<id>-dark.json`

Use existing themes (e.g., `flexoki-dark.json`) as reference for the full structure.

### 2. Register in presets.ts

```typescript
import mytheme_light_Raw from './mytheme-light.json';
import mytheme_dark_Raw from './mytheme-dark.json';

export const presetThemes: Theme[] = [
  // ... existing themes
  mytheme_light_Raw as Theme,
  mytheme_dark_Raw as Theme,
];
```

### 3. Validate

```bash
bun run type-check && bun run lint && bun run build
```

## Key Files

- Theme types: `packages/ui/src/types/theme.ts`
- Presets: `packages/ui/src/lib/theme/themes/presets.ts`
- Example: `packages/ui/src/lib/theme/themes/flexoki-dark.json`
- Custom themes doc: `docs/CUSTOM_THEMES.md`
