import { z } from 'zod';

import { runtimeFetch } from '@/lib/runtime-fetch';

/**
 * The limit failover's account list and per-session pin, as the server keeps
 * them. The plugin sweeps each stored Claude account's plan usage and reports
 * the windows it has seen run out; the UI reads both here.
 */

const ROUTE = '/api/openchamber/limit-failover';

const windowSchema = z.object({ usedPercent: z.number().nullable().optional() });
const usageSchema = z.object({
  windows: z.record(z.string(), windowSchema).optional(),
  models: z.record(z.string(), z.object({ windows: z.record(z.string(), windowSchema).optional() })).optional(),
});

const accountSchema = z.object({
  id: z.string(),
  label: z.string(),
  usage: usageSchema.nullable(),
  exhausted: z.array(z.object({ scope: z.string(), resetAt: z.number() })),
});

const accountsResponseSchema = z.object({
  providerID: z.string(),
  usageAt: z.number().nullable(),
  accounts: z.array(accountSchema),
});

const sessionAccountSchema = z.object({
  sessionID: z.string(),
  providerID: z.string(),
  mode: z.enum(['preferred', 'fixed']),
  credentialID: z.string(),
  updatedAt: z.number(),
});

export type LimitAccount = z.infer<typeof accountSchema>;
type LimitAccountUsage = z.infer<typeof usageSchema>;
export type SessionAccountPin = z.infer<typeof sessionAccountSchema>;

/** A window's used percent, or null when the sweep has not seen it. */
export const windowPercent = (usage: LimitAccountUsage | null, window: string): number | null => {
  const percent = usage?.windows?.[window]?.usedPercent;
  return percent != null ? percent : null;
};

/** Per-model weekly windows the sweep reported, as display name and percent. */
export const modelWindows = (usage: LimitAccountUsage | null): { model: string; usedPercent: number }[] => {
  if (!usage?.models) return [];
  return Object.entries(usage.models).flatMap(([model, entry]) => {
    const percent = entry.windows?.['7d']?.usedPercent;
    return percent != null ? [{ model, usedPercent: percent }] : [];
  });
};

const parseBody = async <T>(response: Response, schema: z.ZodType<T>): Promise<T> => {
  if (!response.ok) throw new Error(`Limit failover request failed (${response.status})`);
  return schema.parse(await response.json());
};

/** The provider's accounts with their last swept usage and live exhaustion marks. */
export const fetchLimitAccounts = async (providerId: string): Promise<LimitAccount[]> => {
  const response = await runtimeFetch(`${ROUTE}/accounts?providerID=${encodeURIComponent(providerId)}`);
  return (await parseBody(response, accountsResponseSchema)).accounts;
};

/** The session's pin, or null when it follows the global settings. */
export const fetchSessionAccount = async (sessionId: string): Promise<SessionAccountPin | null> => {
  const response = await runtimeFetch(`${ROUTE}/session-account?sessionID=${encodeURIComponent(sessionId)}`);
  return (await parseBody(response, z.object({ config: sessionAccountSchema.nullable() }))).config;
};

/** Sets the session's pin. `global` clears it; the others name an account. */
export const setSessionAccount = async (input: {
  sessionId: string;
  providerId: string;
  mode: 'global' | 'preferred' | 'fixed';
  credentialId?: string;
}): Promise<SessionAccountPin | null> => {
  const response = await runtimeFetch(`${ROUTE}/session-account`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      sessionID: input.sessionId,
      providerID: input.providerId,
      mode: input.mode,
      credentialID: input.credentialId,
    }),
  });
  return (await parseBody(response, z.object({ config: sessionAccountSchema.nullable() }))).config;
};
