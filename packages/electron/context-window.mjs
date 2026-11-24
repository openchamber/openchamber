import { z } from 'zod';

const CONTEXT_WINDOW_PARAM = 'contextWindow';

const ownerIdSchema = z.string().regex(/^[A-Za-z0-9-]{8,64}$/);

const boundsSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().finite().positive(),
  height: z.number().finite().positive(),
  maximized: z.boolean().catch(false),
});

const stateSchema = z.object({
  owners: z.array(ownerIdSchema).catch([]),
  bounds: boundsSchema.nullable().catch(null),
}).catch({ owners: [], bounds: null });

export const isContextWindowOwnerId = (value) => ownerIdSchema.safeParse(value).success;

export const buildContextWindowUrl = (pageUrl, ownerId) => {
  const url = new URL(pageUrl);
  url.search = '';
  url.hash = '';
  url.searchParams.set(CONTEXT_WINDOW_PARAM, ownerId);
  return url.toString();
};

export const readContextWindowState = (value) => stateSchema.parse(value ?? {});
