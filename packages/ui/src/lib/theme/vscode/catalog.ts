import { z } from 'zod';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { importVSCodeTheme } from './import';
import { requireTheme, type ThemeDefinition } from '../definition';

const extensionSchema = z.object({
  namespace: z.string(), name: z.string(), version: z.string(), label: z.string(),
  icon: z.string().url().refine((url) => {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && ['open-vsx.org', 'openvsx.eclipsecontent.org'].includes(parsed.hostname);
  }).nullable(),
});
export type ThemeExtension = z.infer<typeof extensionSchema>;

export async function searchThemeCatalog(query: string, signal: AbortSignal) {
  const response = await runtimeFetch('/api/config/themes/catalog/search', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query }), signal,
  });
  if (!response.ok) throw new Error('catalog');
  return z.object({ items: z.array(extensionSchema).max(24) }).parse(await response.json()).items;
}

export async function readThemePackage(extension: ThemeExtension, signal: AbortSignal) {
  const response = await runtimeFetch('/api/config/themes/catalog/package', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(extension), signal,
  });
  if (!response.ok) throw new Error('catalog');
  const { items } = z.object({ items: z.array(z.object({ path: z.string(), name: z.string(), text: z.string(), error: z.boolean() })).max(40) }).parse(await response.json());
  const variants = items.map((item, index) => {
    const key = `${index}:${item.path}`;
    try {
      if (item.error) throw new Error('invalid');
      const definition = importVSCodeTheme(item.text, item.path);
      // Manifest labels are display names, even when they resemble a slug.
      definition.metadata.name = item.name;
      definition.metadata.author = extension.namespace;
      return { status: 'ready' as const, key, name: item.name, definition, theme: requireTheme(definition) };
    } catch {
      return { status: 'invalid' as const, key, name: item.name };
    }
  });
  return withoutRepeatedPalettes(variants);
}

// Words that name a font-style edition: "Eva Dark Bold", "Night Owl (No Italics)".
const FONT_STYLE_WORDS = /\b(?:(?:no|non|without)[\s-]*)?(?:italics?|bold)\b/gi;
const baseName = (name: string) => name.replace(FONT_STYLE_WORDS, '').replace(/\(\s*\)/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Packages often ship italic and bold editions of one palette. The import keeps
 * colors and drops font styles, so such editions add nothing here. An edition
 * goes when it imports to the same colors as an earlier variant, or when its
 * name differs from an earlier variant of the same appearance only by
 * font-style words (Night Owl's "No Italics" also nudges one token color).
 * The first variant, in the package's own order, stays.
 */
export function withoutRepeatedPalettes<T extends { status: 'ready'; name: string; definition: ThemeDefinition } | { status: 'invalid' }>(variants: T[]): T[] {
  const palettes = new Set<string>();
  const names = new Set<string>();
  return variants.filter((variant) => {
    if (variant.status !== 'ready') return true;
    const appearance = variant.definition.metadata.variant;
    const palette = `${appearance}:${JSON.stringify(variant.definition.colors)}`;
    const name = `${appearance}:${baseName(variant.name)}`;
    if (palettes.has(palette) || names.has(name)) return false;
    palettes.add(palette);
    names.add(name);
    return true;
  });
}
