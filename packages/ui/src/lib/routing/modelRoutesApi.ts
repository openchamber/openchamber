/**
 * Client for the OpenChamber model-pool routes (`/api/model-routes`). The
 * server owns the OpenCode config file; this module speaks HTTP and parses
 * what comes back. A 404 means the build has no model pools at all and is
 * reported as `available: false`, never as an empty map.
 */
import { z } from 'zod';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { storedSchedulesSchema, type ScheduleListValue } from '@/lib/routing/scheduleSchema';

export const AUTONOMY_LEVELS = ['fixed', 'rules', 'adaptive', 'predictive', 'agent'] as const;
export type AutonomyLevel = (typeof AUTONOMY_LEVELS)[number];

const targetSchema = z.union([
  z.string().min(1),
  z.object({
    model: z.string().min(1),
    defaultVariant: z.string().optional(),
    variants: z.record(z.string(), z.string()).optional(),
    until: z.number().int().positive().optional(),
  }),
]);

const healthSchema = z
  .object({
    firstTokenTimeoutMs: z.union([z.number(), z.literal(false)]).optional(),
    maxResponseTimeMs: z.number().optional(),
    minOutputTokensPerSecond: z.number().optional(),
    sampleWindow: z.number().optional(),
    slowThreshold: z.number().optional(),
    cooldownMs: z.number().optional(),
    quotaCooldownMs: z.number().optional(),
  })
  .passthrough();

const budgetSchema = z
  .object({
    requestsPerMinute: z.number().optional(),
    requestsPerDay: z.number().optional(),
    tokensPerMinute: z.number().optional(),
    tokensPerDay: z.number().optional(),
    softLimit: z.number().optional(),
  })
  .passthrough();


// The server's limits on a pool's own text (`validateModelRoute` in
// packages/web/server/lib/routing/model-routes.js); a guard test there keeps
// the two equal.
export const POOL_DESCRIPTION_MAX_LENGTH = 200;
export const POOL_DETAILS_MAX_LENGTH = 2000;

const modelRouteSchema = z
  .object({
    name: z.string().optional(),
    // OpenChamber's own keys: what the pool is for, read by Jev when a routing
    // category runs on the pool. OpenCode ignores them. Every save sends the
    // whole route map, so a hand-edited value the server would refuse (a wrong
    // type, a line break in the description, text over the limits) reads as
    // absent; otherwise one such value would block saving any pool.
    description: z.string().max(POOL_DESCRIPTION_MAX_LENGTH).regex(/^[^\r\n]*$/).optional().catch(undefined),
    details: z.string().max(POOL_DETAILS_MAX_LENGTH).optional().catch(undefined),
    targets: z.array(targetSchema),
    autonomy: z.enum(AUTONOMY_LEVELS).optional(),
    selection: z.enum(['ordered', 'round-robin', 'weighted']).optional(),
    weights: z.record(z.string(), z.number()).optional(),
    attempts: z.number().optional(),
    hedgeAfterMs: z.number().optional(),
    health: healthSchema.optional(),
    budgets: z.record(z.string(), budgetSchema).optional(),
    schedules: storedSchedulesSchema.optional(),
  })
  .passthrough();

export type ModelRoute = z.infer<typeof modelRouteSchema>;
export type ModelRouteTarget = z.infer<typeof targetSchema>;

const modelRouteTuningSchema = z
  .object({
    enabled: z.boolean().optional(),
    intervalMinutes: z.number().optional(),
    windowHours: z.number().optional(),
  })
  .passthrough();

export type ModelRouteTuning = z.infer<typeof modelRouteTuningSchema>;

const modelRoutesStateSchema = z.object({
  routes: z.record(z.string(), modelRouteSchema),
  tuning: modelRouteTuningSchema.nullable().optional(),
  schedules: storedSchedulesSchema.nullable().optional(),
  otherRoutes: z.array(z.object({ path: z.string(), routes: z.record(z.string(), modelRouteSchema) })).optional(),
  otherSchedules: z.array(z.object({ path: z.string(), schedules: storedSchedulesSchema })).optional(),
  path: z.string().optional(),
});

type ModelRoutesState = z.infer<typeof modelRoutesStateSchema> & { available: boolean };

const errorPayloadSchema = z.object({ error: z.string().min(1) });

// The project directory lets the server list the project's own pools and
// cross-pool schedules (read-only); tuning reads the same with or without it.
const withDirectory = (path: string, directory?: string | null) =>
  directory ? `${path}?directory=${encodeURIComponent(directory)}` : path;

export const fetchModelRoutes = async (directory?: string | null): Promise<ModelRoutesState> => {
  const response = await runtimeFetch(withDirectory('/api/model-routes', directory));
  if (response.status === 404) return { routes: {}, available: false };
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const failure = errorPayloadSchema.safeParse(payload);
    throw new Error(failure.success ? failure.data.error : `Model pools request failed (${response.status})`);
  }
  return { ...modelRoutesStateSchema.parse(payload), available: true };
};

const putModelRoutes = async (body: {
  routes?: Record<string, ModelRoute>;
  tuning?: ModelRouteTuning | null;
  schedules?: ScheduleListValue | null;
}, directory?: string | null): Promise<ModelRoutesState> => {
  const response = await runtimeFetch(withDirectory('/api/model-routes', directory), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const failure = errorPayloadSchema.safeParse(payload);
    throw new Error(failure.success ? failure.data.error : `Model pools request failed (${response.status})`);
  }
  return { ...modelRoutesStateSchema.parse(payload), available: true };
};

export const saveModelRoutes = (routes: Record<string, ModelRoute>): Promise<ModelRoutesState> => putModelRoutes({ routes });

/** Saves the automatic-review settings; null removes them so OpenCode's defaults apply. */
export const saveModelRouteTuning = (tuning: ModelRouteTuning | null): Promise<ModelRoutesState> => putModelRoutes({ tuning });

/** Saves the schedules that apply across pools; null removes the list from the config. */
export const saveModelRouteSchedules = (schedules: ScheduleListValue | null, directory?: string | null): Promise<ModelRoutesState> =>
  putModelRoutes({ schedules }, directory);

const routeTargetStatsSchema = z.object({
  providerID: z.string(),
  modelID: z.string(),
  attempts: z.number(),
  failures: z.number(),
  timeouts: z.number(),
  avgFirstTokenMs: z.number().nullable(),
  avgTokensPerSecond: z.number().nullable(),
  lastAttempt: z.number().nullable().optional(),
});

const routeErrorSchema = z.object({
  providerID: z.string(),
  modelID: z.string(),
  tag: z.string().nullable(),
  code: z.string().nullable(),
  status: z.number().nullable(),
  count: z.number(),
  lastTime: z.number().nullable().optional(),
  lastMessage: z.string().nullable(),
});

const hedgeAccuracySchema = z.object({
  providerID: z.string(),
  modelID: z.string(),
  hedges: z.number(),
  wins: z.number(),
});

const routeStatsSchema = z.object({
  available: z.boolean(),
  reason: z.string().optional(),
  windowHours: z.number().optional(),
  targets: z.array(routeTargetStatsSchema).optional(),
  errors: z.array(routeErrorSchema).optional(),
  hedges: z.array(hedgeAccuracySchema).optional(),
});

export type RouteTargetStats = z.infer<typeof routeTargetStatsSchema>;
export type RouteErrorGroup = z.infer<typeof routeErrorSchema>;
export type HedgeAccuracy = z.infer<typeof hedgeAccuracySchema>;
type RouteStats = z.infer<typeof routeStatsSchema>;

export const fetchRouteStats = async (hours = 24): Promise<RouteStats> => {
  const response = await runtimeFetch(`/api/model-routes/stats?hours=${hours}`);
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const failure = errorPayloadSchema.safeParse(payload);
    throw new Error(failure.success ? failure.data.error : `Routing telemetry request failed (${response.status})`);
  }
  return routeStatsSchema.parse(payload);
};

const messageAttributionSelectionSchema = z.object({
  mode: z.string(),
  reason: z.string(),
});

const messageAttributionFailoverSchema = z.object({
  providerID: z.string(),
  modelID: z.string(),
  variant: z.string().nullable(),
  errorTag: z.string().nullable(),
  errorMessage: z.string().nullable(),
});

const messageAttributionSchema = z.object({
  providerID: z.string(),
  modelID: z.string(),
  variant: z.string().nullable(),
  routeID: z.string().nullable(),
  selection: messageAttributionSelectionSchema.nullable(),
  failover: messageAttributionFailoverSchema.nullable(),
});

const messageModelAttributionResponseSchema = z.object({
  available: z.boolean(),
  reason: z.string().optional(),
  messages: z.record(z.string(), messageAttributionSchema).optional(),
});

export type MessageModelAttribution = z.infer<typeof messageAttributionSchema>;
type MessageModelAttributionResponse = z.infer<typeof messageModelAttributionResponseSchema>;

/** Per-assistant-message pool/selection/failover attribution for one session, from OpenCode's routing tables. */
export const fetchMessageModelAttribution = async (sessionID: string): Promise<MessageModelAttributionResponse> => {
  const response = await runtimeFetch(`/api/model-routes/turns?sessionID=${encodeURIComponent(sessionID)}`);
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const failure = errorPayloadSchema.safeParse(payload);
    throw new Error(failure.success ? failure.data.error : `Routing telemetry request failed (${response.status})`);
  }
  return messageModelAttributionResponseSchema.parse(payload);
};
