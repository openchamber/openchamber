# Adding Themes

## Custom Themes (User)

User themes are JSON files in `~/.config/openchamber/themes/`, loaded without a rebuild; the format is in `docs/CUSTOM_THEMES.md`.

## Built-in Themes (Development)

### 1. Create JSON Files

Add to `packages/ui/src/lib/theme/themes/`:
- `<id>-light.json`
- `<id>-dark.json`

Use existing themes (e.g., `flexoki-dark.json`) as reference for the full structure.

Read `packages/ui/src/lib/theme/DOCUMENTATION.md` before changing the format or
its consumers. JSON stores authored colors and exceptions; `requireTheme`
resolves the complete runtime palette. Keep syntax inheritance in `syntax.ts`.

### 2. Register in presets.ts

```typescript
import { requireTheme } from '../definition';
import mytheme_light_Raw from './mytheme-light.json';
import mytheme_dark_Raw from './mytheme-dark.json';

export const presetThemes: Theme[] = [
  // ... existing themes
  mytheme_light_Raw,
  mytheme_dark_Raw,
].map(requireTheme);
```

### 3. Validate

Run `bun run build`; the JSON is imported at build time.

### Judging a palette

- Status colours keep their everyday meaning in light and dark variants: success green, info blue, error red, warning amber. Tune the shade to its background, not the hue family.
- Contrast numbers only point at candidates; the verdict comes from the real UI: body text, bold chat text and borders on the canvas, the sidebar and elevated surfaces. Dark built-ins share one band: body text about 13.3 to 13.6:1 and secondary text about 6:1, reached by raising OKLab lightness only so hue holds. Too low reads dim on external monitors; too high reads harsh. Catppuccin stays on its official palette.

## Authoring Tools

Both do the mechanical work of steps 1–2 and are run by hand:

- `node scripts/convert-vscode-theme.cjs <vscode-theme.json>` converts a VS Code
  theme with the same importer as Settings and registers its compact definition
  in `presets.ts`. It also accepts Zed input, normalized through that importer.
- `node scripts/harmonize-theme.mjs <theme.json> [--write]` aligns accent roles
  to one chroma/lightness target in OKLCH so borrowed colors read as one family.

## Key Files

- Theme types: `packages/ui/src/types/theme.ts`
- Presets: `packages/ui/src/lib/theme/themes/presets.ts`
- Example: `packages/ui/src/lib/theme/themes/flexoki-dark.json`
- Custom themes doc: `docs/CUSTOM_THEMES.md`
