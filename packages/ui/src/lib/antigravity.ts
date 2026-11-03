import { z } from 'zod';
import { runtimeFetch } from '@/lib/runtime-fetch';

export interface AntigravityModel {
  id: string;
  name: string;
}

export interface AntigravityStatus {
  installed: boolean;
  binaryPath: string | null;
  version: string | null;
  models: AntigravityModel[];
  /** Why the model list is empty although the CLI is installed (sign-in, quota). */
  error: { code: string; message: string } | null;
  /** Enterprise mode: the CLI is not run at all. */
  blocked: boolean;
  /** False when OpenChamber talks to an external OpenCode server. */
  managed: boolean;
  checkedAt: number;
}

const modelSchema = z.object({
  id: z.string().min(1),
  name: z.string().catch(''),
}).transform((model): AntigravityModel => ({ id: model.id, name: model.name || model.id }));

const statusSchema = z.object({
  installed: z.boolean(),
  binaryPath: z.string().nullable().catch(null),
  version: z.string().nullable().catch(null),
  models: z.array(modelSchema.nullable().catch(null)).catch([])
    .transform((models) => models.filter((model) => model !== null)),
  error: z.object({ code: z.string(), message: z.string().catch('') }).nullable().catch(null),
  blocked: z.boolean().catch(false),
  managed: z.boolean().catch(true),
  checkedAt: z.number().catch(() => Date.now()),
});
const statusErrorSchema = z.object({ error: z.string().min(1) });

/**
 * Parse the status route at the boundary. The page decides what to show from
 * this shape alone, so an unexpected payload is a failed read rather than a
 * half-filled screen.
 */
export const parseAntigravityStatus = statusSchema.nullable().catch(null).parse;

/**
 * Read the CLI's state on the host that runs OpenCode. `refresh` asks the
 * server to skip its short cache, for a user who just signed in or installed
 * the CLI.
 */
export const fetchAntigravityStatus = async ({ refresh = false } = {}): Promise<AntigravityStatus> => {
  const response = await runtimeFetch('/api/antigravity/status', {
    method: 'GET',
    headers: { Accept: 'application/json' },
    query: refresh ? { refresh: '1' } : undefined,
  });
  if (!response.ok) {
    const body = statusErrorSchema.safeParse(await response.json().catch(() => null));
    const message = body.success ? body.data.error : `HTTP ${response.status}`;
    throw new Error(message);
  }
  const parsed = parseAntigravityStatus(await response.json().catch(() => null));
  if (!parsed) throw new Error('The Antigravity status response was not readable');
  return parsed;
};
