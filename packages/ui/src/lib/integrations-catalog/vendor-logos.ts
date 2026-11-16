
// external: https://vite.dev/guide/features.html#glob-import Vite transforms import.meta.glob; Bun lacks that transform, so tests fall back to sprite icons.
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
