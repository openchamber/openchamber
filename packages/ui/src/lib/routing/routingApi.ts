/**
 * Client for the OpenChamber routing routes. The server owns the
 * configuration and the Jev key (`packages/web/server/lib/routing`); this
 * module speaks HTTP and parses what comes back.
 *
 * Every function throws on failure. A 404 means the build has no routing at
 * all and is reported as `available: false`, never as an empty config.
 */
import { z } from 'zod';
import { runtimeFetch } from '@/lib/runtime-fetch';

const modelRefSchema = z.object({ providerID: z.string().min(1), modelID: z.string().min(1) });

const routingCategorySchema = z.object({
  id: z.string().min(1),
  builtin: z.boolean(),
  enabled: z.boolean(),
  name: z.string().min(1),
  description: z.string().min(1),
  model: modelRefSchema.nullable(),
  variant: z.string().nullable(),
  agent: z.string().nullable(),
});

const routingConfigSchema = z.object({
  enabled: z.boolean(),
  fallback: z.object({ model: modelRefSchema, variant: z.string().nullable() }).nullable(),
  minConfidence: z.number(),
  safetyNet: z.object({ enabled: z.boolean(), threshold: z.number() }),
  categories: z.array(routingCategorySchema),
});

const heldPermissionSchema = z.object({ permissionId: z.string(), score: z.number(), kind: z.string().nullable() });

const builtinCategorySchema = z.object({ id: z.string().min(1), name: z.string().min(1), description: z.string().min(1) });

/** Which Jev endpoint the server is calling: the user's TypeSafe key, or zen. */
const jevSourceSchema = z.enum(['typesafe', 'zen-free']);

/** A classification provider: which service answers Jev requests. */
const classifierSourceSchema = z.enum(['zen-promo', 'zen-key', 'openrouter', 'vercel', 'typesafe']);

// A source this build does not know (a newer server) reads as no source and is
// left out of the list, so it cannot fail the whole routing state.
const knownSourceOrNullSchema = classifierSourceSchema.nullable().catch(null);

const classifierSchema = z.object({
  selected: knownSourceOrNullSchema,
  effective: knownSourceOrNullSchema,
  sources: z.array(z.object({ id: z.string(), usable: z.boolean() })).transform((sources) => sources.flatMap((source) => {
    const id = classifierSourceSchema.safeParse(source.id);
    return id.success ? [{ id: id.data, usable: source.usable }] : [];
  })),
});

/**
 * `/api/routing` as this build reads it, from any server version. Servers from
 * before the classifier pick send neither `jevAvailable` nor `classifier`; Jev
 * always answered there, through the free zen model. `classifier` is the
 * three-source view kept for v2.0.2 clients (null once OpenRouter or Vercel is
 * involved); `classification` is the full picture and wins when present.
 */
export const routingStateSchema = z.object({
  available: z.boolean(),
  autoReady: z.boolean(),
  jevAvailable: z.boolean().default(true),
  tokenPresent: z.boolean(),
  jevSource: jevSourceSchema,
  classifier: classifierSchema.nullable().default(null),
  classification: classifierSchema.nullable().default(null),
  config: routingConfigSchema.nullable(),
  builtins: z.array(builtinCategorySchema),
  heldPermissions: z.array(heldPermissionSchema).optional(),
}).transform(({ classification, ...state }) => ({ ...state, classifier: classification ?? state.classifier }));

export type RoutingCategory = z.infer<typeof routingCategorySchema>;
export type RoutingConfig = z.infer<typeof routingConfigSchema>;
export type RoutingHeldPermission = z.infer<typeof heldPermissionSchema>;
export type RoutingJevSource = z.infer<typeof jevSourceSchema>;
export type ClassifierSource = z.infer<typeof classifierSourceSchema>;
export type RoutingState = z.infer<typeof routingStateSchema>;

export const ROUTING_UNAVAILABLE: RoutingState = {
  available: false,
  autoReady: false,
  jevAvailable: false,
  tokenPresent: false,
  jevSource: 'zen-free',
  classifier: null,
  config: null,
  builtins: [],
  heldPermissions: [],
};

const errorPayloadSchema = z.object({ error: z.string().min(1) });

const readState = async (response: Response): Promise<RoutingState> => {
  if (response.status === 404) return ROUTING_UNAVAILABLE;
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const failure = errorPayloadSchema.safeParse(payload);
    throw new Error(failure.success ? failure.data.error : `Routing request failed (${response.status})`);
  }
  return routingStateSchema.parse(payload);
};

export const fetchRoutingState = async (): Promise<RoutingState> => readState(await runtimeFetch('/api/routing'));

export const saveRoutingConfig = async (config: RoutingConfig): Promise<RoutingState> =>
  readState(await runtimeFetch('/api/routing', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ config }),
  }));

export const saveRoutingToken = async (token: string): Promise<RoutingState> =>
  readState(await runtimeFetch('/api/routing/token', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  }));

export const clearRoutingToken = async (): Promise<RoutingState> =>
  readState(await runtimeFetch('/api/routing/token', { method: 'DELETE' }));

export const saveClassifierSource = async (source: ClassifierSource): Promise<RoutingState> =>
  readState(await runtimeFetch('/api/routing/classifier', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source }),
  }));
