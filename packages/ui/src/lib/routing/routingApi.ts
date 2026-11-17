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
  preserveCache: z.boolean().optional(),
  safetyNet: z.object({ enabled: z.boolean(), threshold: z.number() }),
  categories: z.array(routingCategorySchema),
});

const heldPermissionSchema = z.object({ permissionId: z.string(), score: z.number(), kind: z.string().nullable() });

const builtinCategorySchema = z.object({ id: z.string().min(1), name: z.string().min(1), description: z.string().min(1) });

const jevSourceSchema = z.enum(['typesafe', 'zen-free']);

const classifierSourceSchema = z.enum(['off', 'zen-promo', 'zen-key', 'openrouter', 'vercel', 'gemini', 'typesafe', 'custom']);

const customEndpointSchema = z.object({ url: z.string().min(1), model: z.string().min(1), keyPresent: z.boolean(), pinned: z.boolean().default(false) });

const knownSourceOrNullSchema = classifierSourceSchema.nullable().catch(null);

const classifierSchema = z.object({
  selected: knownSourceOrNullSchema,
  effective: knownSourceOrNullSchema,
  sources: z.array(z.object({ id: z.string(), usable: z.boolean() })).transform((sources) => sources.flatMap((source) => {
    const id = classifierSourceSchema.safeParse(source.id);
    return id.success ? [{ id: id.data, usable: source.usable }] : [];
  })),
});

export const routingStateSchema = z.object({
  available: z.boolean(),
  autoReady: z.boolean(),
  jevAvailable: z.boolean().default(true),
  tokenPresent: z.boolean(),
  geminiKeyPresent: z.boolean().default(false),
  customEndpoint: customEndpointSchema.nullable().default(null),
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
  geminiKeyPresent: false,
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

export const saveGeminiKey = async (key: string): Promise<RoutingState> =>
  readState(await runtimeFetch('/api/routing/classifier/gemini', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key }),
  }));

export const clearGeminiKey = async (): Promise<RoutingState> =>
  readState(await runtimeFetch('/api/routing/classifier/gemini', { method: 'DELETE' }));

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
