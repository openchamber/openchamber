/**
 * Client for pool health (`/api/model-routes/health`, `/api/model-routes/plan-links`):
 * how many sessions are on each pool target right now, and, for a target
 * linked to a plan, a rough projection against that plan's quota window. Read
 * `packages/web/server/lib/routing/pool-health.js` for what the numbers mean
 * and why they are an estimate, not a meter.
 */
import { z } from 'zod';
import { runtimeFetch } from '@/lib/runtime-fetch';

const projectionSchema = z.object({
  quotaName: z.string(),
  unit: z.enum(['requests', 'messages', 'tokens']),
  limit: z.number(),
  windowHours: z.number(),
  projected: z.number(),
  source: z.enum(['traffic-estimate', 'provider-reading']),
  ratio: z.number(),
  status: z.enum(['ok', 'warn', 'over']),
});

const unprojectedQuotaSchema = z.object({
  quotaName: z.string(),
  unit: z.enum(['usd', 'percent', 'other']),
  reason: z.enum(['needs-pricing', 'needs-provider-meter', 'unsupported-unit']),
});

const planInfoSchema = z.object({
  id: z.string(),
  label: z.string(),
  providerID: z.string(),
  siblingRefs: z.array(z.string()),
  projection: projectionSchema.nullable(),
  unprojectedQuotas: z.array(unprojectedQuotaSchema),
});

const targetHealthSchema = z.object({
  ref: z.string(),
  activeSessions: z.number().nullable(),
  plan: planInfoSchema.nullable(),
  missingPlanID: z.string().nullable().optional(),
  blastRadius: z.boolean(),
  suggestion: z.literal('lower-weight').nullable(),
});

const poolHealthSchema = z.object({
  selection: z.string(),
  targets: z.array(targetHealthSchema),
});

const poolHealthStateSchema = z.object({
  available: z.boolean(),
  statsAvailable: z.boolean().optional(),
  statsReason: z.string().optional(),
  planError: z.string().nullable().optional(),
  linksError: z.string().nullable().optional(),
  generatedAt: z.number().optional(),
  pools: z.record(z.string(), poolHealthSchema),
});

export type PoolTargetHealth = z.infer<typeof targetHealthSchema>;
export type PoolHealthState = z.infer<typeof poolHealthStateSchema>;

const errorSchema = z.object({ error: z.string().min(1) });

export const fetchPoolHealth = async (): Promise<PoolHealthState> => {
  const response = await runtimeFetch('/api/model-routes/health');
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const failure = errorSchema.safeParse(payload);
    throw new Error(failure.success ? failure.data.error : `Pool health request failed (${response.status})`);
  }
  return poolHealthStateSchema.parse(payload);
};

const linksSchema = z.object({ version: z.literal(1), links: z.record(z.string(), z.string()) });
type PoolPlanLinks = z.infer<typeof linksSchema>;

/** Links `target` (a `provider/model` reference) to `planID`, or clears the link when `planID` is null. */
export const savePoolPlanLink = async (target: string, planID: string | null): Promise<PoolPlanLinks> => {
  const response = await runtimeFetch('/api/model-routes/plan-links', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ target, planID }),
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const failure = errorSchema.safeParse(payload);
    throw new Error(failure.success ? failure.data.error : `Could not save the pool-plan link (${response.status})`);
  }
  return linksSchema.parse(payload);
};

const rotationMoveSchema = z.object({
  at: z.number(),
  poolID: z.string(),
  sessionID: z.string(),
  subagent: z.boolean(),
  from: z.string(),
  to: z.string(),
});

const rotationStateSchema = z.object({
  settings: z.object({ enabled: z.boolean(), intervalMinutes: z.number() }),
  moves: z.array(rotationMoveSchema),
});

export type RotationState = z.infer<typeof rotationStateSchema>;
type RotationSettings = RotationState['settings'];

/** Staggered rotation: its settings and the sessions it moved since the server started. */
export const fetchRotation = async (): Promise<RotationState> => {
  const response = await runtimeFetch('/api/model-routes/rotation');
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const failure = errorSchema.safeParse(payload);
    throw new Error(failure.success ? failure.data.error : `Rotation request failed (${response.status})`);
  }
  return rotationStateSchema.parse(payload);
};

export const saveRotation = async (patch: Partial<RotationSettings>): Promise<RotationState> => {
  const response = await runtimeFetch('/api/model-routes/rotation', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const failure = errorSchema.safeParse(payload);
    throw new Error(failure.success ? failure.data.error : `Could not save rotation settings (${response.status})`);
  }
  return rotationStateSchema.parse(payload);
};
