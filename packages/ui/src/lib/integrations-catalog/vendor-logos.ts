/**
 * Vendor app icons for catalog entries simple-icons has no glyph for, written
 * by generate-vendor-logos.mjs into assets/integration-logos as `<entry id>.webp`.
 */

// Vite rewrites `import.meta.glob` at build time. The bun test runner has no
// such transform and throws, so tests see no logos and the tile falls back to
// its sprite icon.
const loadLogoUrls = (): Record<string, string> => {
  try {
    return import.meta.glob<string>('../../assets/integration-logos/*.webp', {
      eager: true,
      import: 'default',
    });
  } catch {
    return {};
  }
};

const LOGO_BY_ID = new Map(
  Object.entries(loadLogoUrls()).flatMap(([file, url]) => {
    const id = file.match(/([^/]+)\.webp$/)?.[1];
    return id ? [[id, url] as const] : [];
  }),
);

export const vendorLogoFor = (id: string): string | undefined => LOGO_BY_ID.get(id);
