import { create } from 'zustand';
import { z } from 'zod';
import type { Event } from '@opencode-ai/sdk/v2';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeKey } from '@/lib/runtime-switch';

// Which backing model a proxied provider actually served, per session. The
// server captures it from LiteLLM-fronted gateway response headers (see the
// resolved-model server module) and owns the authoritative state; this store
// only holds the latest projection. Sessions on direct (non-proxied)
// providers never report, so absence means "nothing to show", not "unknown".
const resolvedModelEntrySchema = z.object({
  sessionId: z.string().min(1),
  model: z.string().min(1),
  modelGroup: z.string().min(1).optional(),
  callId: z.string().min(1).optional(),
  updatedAt: z.number(),
});
type ResolvedModelEntry = z.infer<typeof resolvedModelEntrySchema>;

export const resolvedModelUpdatedEventSchema = z.object({
  type: z.literal('openchamber:resolved-model'),
  properties: resolvedModelEntrySchema,
});
export type ResolvedModelUpdatedEvent = z.infer<typeof resolvedModelUpdatedEventSchema>;

const serverSnapshotSchema = z.object({
  sessions: z.array(resolvedModelEntrySchema),
  serverTime: z.number(),
});

type ResolvedModelState = {
  /** Bounded, never persisted: a restart simply has nothing to show yet. */
  bySessionId: ReadonlyMap<string, ResolvedModelEntry>;
};

export const useResolvedModelStore = create<ResolvedModelState>(() => ({
  bySessionId: new Map(),
}));

/** `openchamber:resolved-model` broadcast → projection. */
export const applyResolvedModelUpdatedEvent = (
  payload: Event | ResolvedModelUpdatedEvent,
  expectedRuntimeKey: string,
): void => {
  if (expectedRuntimeKey !== getRuntimeKey()) return;
  const parsed = resolvedModelUpdatedEventSchema.safeParse(payload);
  if (!parsed.success) return;
  const entry = parsed.data.properties;
  useResolvedModelStore.setState((state) => {
    const current = state.bySessionId.get(entry.sessionId);
    // Replays and out-of-order deliveries lose to the newer observation.
    if (current && current.updatedAt > entry.updatedAt) return state;
    const bySessionId = new Map(state.bySessionId);
    bySessionId.delete(entry.sessionId);
    bySessionId.set(entry.sessionId, entry);
    return { bySessionId };
  });
};

/**
 * Authoritative snapshot for a client that joined after the events fired.
 * A failed fetch throws and leaves the projection untouched — failure is not
 * an authoritative empty result.
 */
export const resyncResolvedModels = async (): Promise<void> => {
  const runtimeKey = getRuntimeKey();
  const response = await runtimeFetch('/api/resolved-model');
  if (!response.ok) {
    throw new Error(`Resolved model request failed (${response.status})`);
  }
  const parsed = serverSnapshotSchema.safeParse(await response.json());
  if (!parsed.success) {
    throw new Error('Invalid resolved model response');
  }
  if (runtimeKey !== getRuntimeKey()) return;
  const bySessionId = new Map<string, ResolvedModelEntry>();
  for (const entry of parsed.data.sessions) {
    bySessionId.set(entry.sessionId, entry);
  }
  useResolvedModelStore.setState({ bySessionId });
};

/** Nothing to show (no session, no report, or a non-proxied provider) is undefined. */
export const useResolvedModel = (sessionId: string | null | undefined): ResolvedModelEntry | undefined =>
  useResolvedModelStore((state) => (sessionId ? state.bySessionId.get(sessionId) : undefined));
