import { z } from 'zod';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { isVSCodeRuntime } from '@/lib/desktop';
import { getBotsRuntime } from './botsRuntime';
import { botDefinitionSchema, botsConfigSchema, type BotsConfig } from './bots/config';
import { botItemSchema, type BotEvidence, type BotSource } from './bots/items';
import { botIdentitySchema, botPolicySchema, type BotIdentityInput } from './bots/management';

const snapshotSchema = z.object({
  config: botsConfigSchema, revision: z.number().int().nonnegative(), items: z.array(botItemSchema),
  presets: z.array(botDefinitionSchema),
});
const itemDetailSchema = z.object({
  item: botItemSchema, reports: z.record(z.string(), z.json()),
  sessionDirectories: z.record(z.string(), z.string().min(1)).default({}),
  snapshot: z.object({ baseSha: z.string(), headSha: z.string(), diff: z.string(), changes: z.array(z.object({ oldPath: z.string().nullable().optional(), newPath: z.string().nullable().optional() })) }).nullable(),
});
export type BotsSnapshot = z.infer<typeof snapshotSchema>;

export class BotsApiError extends Error {
  readonly name = 'BotsApiError';
  constructor(readonly status: number, readonly code: string) { super(code); }
}
const errorSchema = z.object({ code: z.string().optional(), error: z.string().optional() });

/** Parse every response here. No response body from credential writes is echoed into UI errors. */
async function request<T>(path: string, schema: z.ZodType<T>, options?: { readonly body?: string; readonly method?: string; readonly signal?: AbortSignal }): Promise<T> {
  if (isVSCodeRuntime()) throw new BotsApiError(501, 'bots_unsupported');
  const runtime = getBotsRuntime();
  const signal = options?.signal ? AbortSignal.any([runtime.signal, options.signal]) : runtime.signal;
  const init: RequestInit = {
    method: options?.method ?? 'GET', signal,
  };
  if (options?.body !== undefined) {
    init.body = options.body;
    init.headers = { 'Content-Type': 'application/json' };
  }
  const response = await runtimeFetch(path, init);
  if (!response.ok) {
    const parsed = errorSchema.safeParse(await response.json().catch(() => null));
    throw new BotsApiError(response.status, parsed.success ? parsed.data.code ?? `http_${response.status}` : `http_${response.status}`);
  }
  const result = schema.parse(await response.json());
  signal.throwIfAborted();
  return result;
}
const root = (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}/bots`;

export const fetchBots = (projectId: string) => request(root(projectId), snapshotSchema);
export const saveBotsConfig = (projectId: string, config: BotsConfig) => request(`${root(projectId)}/config`, z.object({ config: botsConfigSchema }), {
  method: 'PUT', body: JSON.stringify({ config: botsConfigSchema.parse(config) }),
});
export const runBot = (projectId: string, botId: string) => request(`${root(projectId)}/${encodeURIComponent(botId)}/run`, z.json(), { method: 'POST', body: '{}' });
export type CreateBotItem = { readonly botId: string; readonly source: BotSource; readonly title: string; readonly description?: string; readonly evidence?: readonly BotEvidence[] };
export const createBotItem = (projectId: string, input: CreateBotItem) => request(`${root(projectId)}/items`, z.object({ item: botItemSchema }), { method: 'POST', body: JSON.stringify(input) });
export const fetchBotItem = (projectId: string, itemId: string) => request(`${root(projectId)}/items/${encodeURIComponent(itemId)}`, itemDetailSchema);
export const actOnBotItem = (projectId: string, itemId: string, action: { readonly kind: 'stop' | 'resume' } | { readonly kind: 'answer'; readonly text: string; readonly eventId: string }) => request(
  `${root(projectId)}/items/${encodeURIComponent(itemId)}/${action.kind}`, z.json(),
  { method: 'POST', body: JSON.stringify(action.kind === 'answer' ? { text: action.text, eventId: action.eventId } : {}) },
);
export const fetchBotArchive = (projectId: string, month: string) => request(`${root(projectId)}/archive?month=${encodeURIComponent(month)}`, z.object({ items: z.array(botItemSchema) }));
export const fetchBotPolicy = (projectId: string) => request(`${root(projectId)}/policy`, botPolicySchema);
export const approveBotPolicy = (projectId: string, approval: { readonly file: string; readonly fingerprint: string }) => request(`${root(projectId)}/policy/approve`, z.json(), { method: 'POST', body: JSON.stringify(approval) });
export const fetchBotIdentities = (projectId: string) => request(`${root(projectId)}/identities`, z.object({ identities: z.array(botIdentitySchema) }));
export const writeBotIdentity = (projectId: string, input: BotIdentityInput, current?: { readonly id: string; readonly revision: number }) => request(
  `${root(projectId)}/identities${current ? `/${encodeURIComponent(current.id)}` : ''}`, z.object({ identity: botIdentitySchema }),
  { method: current ? 'PUT' : 'POST', body: JSON.stringify(current ? { definition: input, expectedRevision: current.revision } : input) },
);
export const deleteBotIdentity = (projectId: string, current: { readonly id: string; readonly revision: number }) => request(
  `${root(projectId)}/identities/${encodeURIComponent(current.id)}`, z.object({ removed: z.boolean() }),
  { method: 'DELETE', body: JSON.stringify({ expectedRevision: current.revision }) },
);
