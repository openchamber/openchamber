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

/** A classification provider: which service answers Jev requests, or `off` for none. */
const classifierSourceSchema = z.enum(['off', 'zen-promo', 'zen-key', 'openrouter', 'vercel', 'typesafe', 'custom']);

/** The custom System One endpoint as the server shows it: the key stays on the server. */
// `pinned`: set by the server environment (OPENCHAMBER_JEV_URL), read-only here.
const customEndpointSchema = z.object({ url: z.string().min(1), model: z.string().min(1), keyPresent: z.boolean(), pinned: z.boolean().default(false) });

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
 * three-source view kept for v2.0.2 clients (null once OpenRouter, Vercel or a
 * custom endpoint is involved); `classification` is the full picture and wins
 * when present.
 */
export const routingStateSchema = z.object({
  available: z.boolean(),
  autoReady: z.boolean(),
  jevAvailable: z.boolean().default(true),
  tokenPresent: z.boolean(),
  // Servers before the custom source never send it.
  customEndpoint: customEndpointSchema.nullable().default(null),
  // An administrator turned Jev off for this server; servers before it never did.
  enterpriseMode: z.boolean().default(false),
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

/**
 * What Settings saves for the custom endpoint. `key`: a string replaces the
 * saved key, null removes it, absent keeps it.
 */
export interface CustomEndpointInput {
  url: string;
  model: string;
  key?: string | null;
}

export const ROUTING_UNAVAILABLE: RoutingState = {
  available: false,
  autoReady: false,
  jevAvailable: false,
  tokenPresent: false,
  customEndpoint: null,
  enterpriseMode: false,
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

export const saveCustomEndpoint = async (endpoint: CustomEndpointInput): Promise<RoutingState> =>
  readState(await runtimeFetch('/api/routing/classifier/custom', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(endpoint),
  }));

export const clearCustomEndpoint = async (): Promise<RoutingState> =>
  readState(await runtimeFetch('/api/routing/classifier/custom', { method: 'DELETE' }));

const sourceSchema = classifierSourceSchema.exclude(['off']);
// Two shapes, told apart by `ok`: a discriminated union needs one variant
// per discriminator value, so every failure shares one object and only
// `unavailable` comes without a source and model.
const classifierTestSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), source: sourceSchema, model: z.string(), ms: z.number() }),
  z.object({
    ok: z.literal(false),
    reason: z.enum(['unavailable', 'http', 'timeout', 'unparsable', 'network']),
    source: sourceSchema.optional(),
    model: z.string().optional(),
    status: z.number().optional(),
    message: z.string().optional(),
  }),
]);
export type ClassifierTestResult = z.infer<typeof classifierTestSchema>;

/**
 * One Jev request through the provider answering now, or through `custom`
 * endpoint fields as typed (an empty key reuses the saved one). Saves nothing.
 */
export const parseClassifierTestResult = (payload: unknown): ClassifierTestResult => classifierTestSchema.parse(payload);

export const testClassifier = async (custom?: CustomEndpointInput): Promise<ClassifierTestResult> => {
  const response = await runtimeFetch('/api/routing/classifier/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(custom ? { custom } : {}),
  });
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const failure = errorPayloadSchema.safeParse(payload);
    throw new Error(failure.success ? failure.data.error : `Routing request failed (${response.status})`);
  }
  return parseClassifierTestResult(payload);
};
