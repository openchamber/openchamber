import { z } from 'zod';

const integrationListSchema = z.object({
  data: z.array(z.looseObject({ id: z.string(), connections: z.array(z.record(z.string(), z.unknown())) })),
});
export const parseIntegrationConnections = (body: string) => integrationListSchema.parse(JSON.parse(body)).data;

const pluginListSchema = z.object({ data: z.array(z.unknown()) });
export const parsePluginList = (body: string) => pluginListSchema.parse(JSON.parse(body)).data;

export const sessionCookieOf = (headers: Record<string, string[]>) => {
  const [header] = headers['set-cookie'] ?? [];
  if (header === undefined) throw new Error('The server inside the space set no session cookie');
  const [cookie = ''] = header.split(';');
  return cookie;
};
