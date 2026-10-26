/**
 * Work-item trackers over `/api/tracker/:provider/*`, for the UI's
 * `RuntimeAPIs.trackers`. Desktop and the phone reuse it; VS Code has none.
 *
 * A server older than `GET /api/tracker/providers` answers 404 there (or a
 * 2xx page that is not JSON, from whatever serves its unknown paths). It
 * serves exactly Linear, through `/api/linear/*` in Linear's own shapes, so
 * this adapter then answers with Linear's built-in descriptor and reads every
 * call through those routes, mapped to the neutral shapes here
 * (`trackers-legacy-linear.ts`). `packages/ui` never sees the difference.
 */
import { z } from 'zod';
import type {
  TrackerAPI,
  TrackerAuthOrigin,
  TrackerAuthStart,
  TrackerAuthStatus,
  TrackerDescriptor,
  TrackerItemResult,
  TrackerListOptions,
  TrackerListResult,
  TrackerMappingResult,
  TrackerMappingWrite,
  TrackerPreferences,
  TrackerProviderId,
  TrackerSessionStatusPostInput,
  TrackerSessionStatusPostResult,
  TrackerStatesResult,
  TrackerStateUpdateInput,
} from '@openchamber/ui/lib/api/types';
import { trackerDescriptorListSchema } from '@openchamber/ui/lib/trackers/descriptor';
import { runtimeFetch } from '@openchamber/ui/lib/runtime-fetch';
import { getRuntimeKey } from '@openchamber/ui/lib/runtime-switch';
import { BUILT_IN_LINEAR_TRACKER, createLegacyLinearTrackerAPI } from './trackers-legacy-linear';
import {
  authStartSchema,
  authStatusSchema,
  itemResultSchema,
  listResultSchema,
  mappingResultSchema,
  preferencesSchema,
  sessionStatusResultSchema,
  failureOf,
  requestJson,
  statesResultSchema,
  type TrackerFetch,
  type TrackerRequest,
} from './trackers-schemas';

export { BUILT_IN_LINEAR_TRACKER } from './trackers-legacy-linear';

const providersResponseSchema = z.object({ providers: z.array(z.unknown()) });

const isJsonContentType = (value: string | null): boolean => {
  const type = value?.split(';')[0]?.trim().toLowerCase() ?? '';
  return type === 'application/json' || type.endsWith('+json');
};

type Wire = { kind: 'tracker'; descriptors: TrackerDescriptor[] } | { kind: 'legacy-linear' };

/**
 * The server's trackers; Linear on a server that predates the route. Throws on
 * any other failure, and when the server listed trackers but none could be
 * read: that answer is unreadable, not empty.
 */
async function readWire(fetch: TrackerFetch): Promise<Wire> {
  const response = await fetch('/api/tracker/providers', { headers: { Accept: 'application/json' } });
  if (response.status === 404) return { kind: 'legacy-linear' };
  if (!response.ok) throw await failureOf(response, 'Failed to load trackers');
  // An older server hands an unknown path on to whatever sits behind it, and
  // some answer 2xx with a page (a SPA fallback, OpenCode 1.x's app proxy).
  // A new server always answers this route with JSON, so a non-JSON answer
  // means the route is not there. A JSON answer that does not parse still fails.
  if (!isJsonContentType(response.headers.get('content-type'))) return { kind: 'legacy-linear' };
  const listed = providersResponseSchema.parse(await response.json().catch(() => null)).providers;
  const descriptors = trackerDescriptorListSchema.parse(listed);
  if (listed.length > 0 && descriptors.length === 0) {
    throw new Error('Trackers response contained no readable tracker');
  }
  return { kind: 'tracker', descriptors };
}

const trackerPath = (provider: TrackerProviderId, path: string): string => `/api/tracker/${encodeURIComponent(provider)}${path}`;

export const createWebTrackerAPI = ({
  fetch = runtimeFetch,
  runtimeKey = getRuntimeKey,
}: { fetch?: TrackerFetch; runtimeKey?: () => string } = {}): TrackerAPI => {
  const legacy = createLegacyLinearTrackerAPI(fetch);

  // Which wire the connected server speaks, asked once and again by every
  // `providers()`. A failed read is not remembered: the next call asks again.
  // The adapter outlives a runtime switch, so the answer belongs to the
  // runtime it was read on; another runtime asks its own server.
  let wire: { runtimeKey: string; request: Promise<Wire> } | null = null;
  const readWireOnce = (): Promise<Wire> => {
    const request = readWire(fetch);
    const entry = { runtimeKey: runtimeKey(), request };
    wire = entry;
    request.catch(() => {
      if (wire === entry) wire = null;
    });
    return request;
  };
  const onLegacyWire = async (): Promise<boolean> => {
    const held = wire?.runtimeKey === runtimeKey() ? wire.request : null;
    return (await (held ?? readWireOnce())).kind === 'legacy-linear';
  };

  const call = <T>(provider: TrackerProviderId, path: string, request: TrackerRequest, schema: z.ZodType<T>, failure: string) => (
    requestJson(fetch, trackerPath(provider, path), request, schema, failure)
  );
  const GET = { method: 'GET' } as const;

  const listQuery = (options: TrackerListOptions | undefined): string => {
    const params = new URLSearchParams();
    const set = (key: string, value: string | null | undefined) => {
      const trimmed = value?.trim();
      if (trimmed) params.set(key, trimmed);
    };
    set('query', options?.query);
    set('cursor', options?.cursor);
    set('state', options?.state);
    set('people', options?.people);
    set('priority', options?.priority);
    set('containerId', options?.containerId);
    const query = params.toString();
    return query ? `?${query}` : '';
  };

  return {
    async providers(): Promise<TrackerDescriptor[]> {
      const answer = await readWireOnce();
      return answer.kind === 'legacy-linear' ? [BUILT_IN_LINEAR_TRACKER] : answer.descriptors;
    },

    async authStatus(provider): Promise<TrackerAuthStatus> {
      if (await onLegacyWire()) return legacy.authStatus(provider);
      return call(provider, '/auth/status', GET, authStatusSchema, 'Failed to load tracker status');
    },

    async authStart(provider, origin?: TrackerAuthOrigin): Promise<TrackerAuthStart> {
      if (await onLegacyWire()) return legacy.authStart(provider, origin);
      return call(provider, '/auth/start', { method: 'POST', body: JSON.stringify({ origin }) }, authStartSchema, 'Failed to start tracker sign-in');
    },

    async authDisconnect(provider): Promise<{ removed: boolean }> {
      if (await onLegacyWire()) return legacy.authDisconnect(provider);
      return call(provider, '/auth', { method: 'DELETE' }, z.object({ removed: z.boolean().catch(false) }), 'Failed to disconnect tracker')
        .then(({ removed }) => ({ removed }));
    },

    async authActivate(provider, accountId): Promise<TrackerAuthStatus> {
      if (await onLegacyWire()) return legacy.authActivate(provider, accountId);
      return call(provider, '/auth/activate', { method: 'POST', body: JSON.stringify({ accountId }) }, authStatusSchema, 'Failed to switch tracker account');
    },

    async list(provider, options): Promise<TrackerListResult> {
      if (await onLegacyWire()) return legacy.list(provider, options);
      return call(provider, `/items/list${listQuery(options)}`, GET, listResultSchema, 'Failed to load tracker items');
    },

    async refreshListReads(provider): Promise<void> {
      if (await onLegacyWire()) return legacy.refreshListReads(provider);
      await call(provider, '/read-cache/refresh?scope=lists', { method: 'POST' }, z.unknown(), 'Failed to refresh tracker lists');
    },

    async get(provider, id): Promise<TrackerItemResult> {
      if (await onLegacyWire()) return legacy.get(provider, id);
      return call(provider, `/items/get?${new URLSearchParams({ id }).toString()}`, GET, itemResultSchema, 'Failed to load tracker item');
    },

    async states(provider, containerId): Promise<TrackerStatesResult> {
      if (await onLegacyWire()) return legacy.states(provider, containerId);
      return call(provider, `/states?${new URLSearchParams({ containerId }).toString()}`, GET, statesResultSchema, 'Failed to load workflow states');
    },

    async updateState(provider, input: TrackerStateUpdateInput): Promise<TrackerItemResult> {
      if (await onLegacyWire()) return legacy.updateState(provider, input);
      return call(provider, '/items/update', { method: 'POST', body: JSON.stringify({ id: input.id, stateId: input.stateId }) }, itemResultSchema, 'Failed to update tracker item');
    },

    async mappingGet(provider): Promise<TrackerMappingResult> {
      if (await onLegacyWire()) return legacy.mappingGet(provider);
      return call(provider, '/mapping', GET, mappingResultSchema, 'Failed to load project mapping');
    },

    async mappingSet(provider, mapping: TrackerMappingWrite): Promise<TrackerMappingResult> {
      if (await onLegacyWire()) return legacy.mappingSet(provider, mapping);
      return call(
        provider,
        '/mapping',
        { method: 'PUT', body: JSON.stringify({ defaultProjectPath: mapping.defaultProjectPath, containerProjectPaths: mapping.containerProjectPaths }) },
        mappingResultSchema,
        'Failed to save project mapping',
      );
    },

    async sessionStatusPost(provider, input: TrackerSessionStatusPostInput): Promise<TrackerSessionStatusPostResult> {
      if (await onLegacyWire()) return legacy.sessionStatusPost(provider, input);
      return call(provider, '/session-status', {
        method: 'POST',
        body: JSON.stringify({ kind: input.kind, sessionId: input.sessionId, identifier: input.identifier, sessionOrigin: input.sessionOrigin }),
      }, sessionStatusResultSchema, 'Failed to post session status');
    },

    async preferencesGet(provider): Promise<TrackerPreferences> {
      if (await onLegacyWire()) return legacy.preferencesGet(provider);
      return call(provider, '/preferences', GET, preferencesSchema, 'Failed to load tracker preferences');
    },

    async preferencesSet(provider, preferences: TrackerPreferences): Promise<TrackerPreferences> {
      if (await onLegacyWire()) return legacy.preferencesSet(provider, preferences);
      return call(provider, '/preferences', { method: 'PUT', body: JSON.stringify({ sessionComments: preferences.sessionComments }) }, preferencesSchema, 'Failed to save tracker preferences');
    },
  };
};

