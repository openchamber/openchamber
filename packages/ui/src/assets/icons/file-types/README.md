# File Type Icons Sprite

This directory keeps the source file-type SVG icons and the generated sprite used by the UI.

## Runtime behavior

- The UI resolves an icon id in `packages/ui/src/lib/fileTypeIcons.ts`.
- Valid icon ids are loaded from `packages/ui/src/lib/fileTypeIconIds.ts`.
- `packages/ui/src/components/icons/FileTypeIcon.tsx` renders the icon with `<use href="...#icon-id" />` from `sprite.svg`.
- Vite handles `sprite.svg` as a normal asset URL automatically.

The sprite generator rewrites internal SVG ids per icon (gradients, clip paths, filters) so ids do not collide after packing all icons into one file.

## Build step

- No special step is required for normal `dev`/`build`.
- Regenerate the sprite only when icon source files in this folder change:

```bash
bun run icons:sprite
```

The command regenerates both `sprite.svg` and `packages/ui/src/lib/fileTypeIconIds.ts`.
Both generated files are committed and consumed automatically by app builds.

If you only run `bun run dev`, `bun run build`, `bun run lint`, or `bun run type-check`, no extra sprite step is needed unless the source icon files changed.
