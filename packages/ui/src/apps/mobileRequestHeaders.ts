import { z } from 'zod';

const headerValuesSchema = z.record(z.string(), z.string());
export const mobileRequestHeadersSchema = z.object({
  url: z.string(),
  values: headerValuesSchema,
});

export type MobileRequestHeaders = z.infer<typeof mobileRequestHeadersSchema>;
export type MobileHeaderDraft = { id: string; name: string; value: string };

export const createMobileHeaderDrafts = (values: Record<string, string> = {}): MobileHeaderDraft[] =>
  Object.entries(values).map(([name, value]) => ({ id: crypto.randomUUID(), name, value }));

export const buildMobileHeaderValues = (drafts: Pick<MobileHeaderDraft, 'name' | 'value'>[]): Record<string, string> => {
  const headers = new Headers();
  for (const { name, value } of drafts) {
    const key = name.trim();
    if (key && value.trim() && key.toLowerCase() !== 'authorization') headers.set(key, value.trim());
  }
  return Object.fromEntries(headers);
};

// A saved instance may also have LAN and relay candidates. Proxy credentials
// belong only to the address the user configured, including its base path.
export const mobileHeadersForUrl = (url: string, config?: MobileRequestHeaders): Record<string, string> =>
  config && url.replace(/\/+$/, '') === config.url.replace(/\/+$/, '')
    ? buildMobileHeaderValues(Object.entries(config.values).map(([name, value]) => ({ name, value })))
    : {};
