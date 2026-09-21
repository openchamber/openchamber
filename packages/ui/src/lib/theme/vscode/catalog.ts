import { z } from 'zod';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { importVSCodeTheme } from './import';
import { requireTheme } from '../definition';

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
  return items.map((item, index) => {
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
}
