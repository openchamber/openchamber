import { useLayoutEffect } from 'react';
import { create } from 'zustand';
import { z } from 'zod';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { isVSCodeRuntime } from '@/lib/desktop';
import { isSpaceDirectory } from '@/lib/spaces/space-route';
import { useSessionUIStore } from '@/sync/session-ui-store';

export const permissionReviewSchema = z.object({
  dispositionVersion: z.literal(1).optional(),
  instanceId: z.string().min(1).optional(),
  revision: z.number().int().nonnegative(),
  permissions: z.array(z.object({
    permissionId: z.string().min(1),
    remainingMs: z.number().nonnegative().max(25_000),
    phase: z.enum(['admitting', 'reviewing', 'answered', 'manual']).optional(),
  })),
}).refine((snapshot) => snapshot.dispositionVersion !== 1 || (Boolean(snapshot.instanceId)
  && snapshot.permissions.every((entry) => entry.phase === 'manual' ? entry.remainingMs === 0
    : entry.phase !== undefined && entry.remainingMs > 0)), 'Invalid permission disposition');
type PermissionReview = z.infer<typeof permissionReviewSchema>;
type Request = { id: string; sessionID: string; directory?: string };
type Presentation = { phase: 'lookup' | 'reviewing' | 'answered'; deadline: number }
  | { phase: 'manual' | 'fallback' };
const LOOKUP_TIMEOUT_MS = 5000;
const MAX_ENTRIES = 10_000;

interface PermissionReviewState {
  revision: number;
  entries: ReadonlyMap<string, Presentation>;
  deadlines: ReadonlyMap<string, number>;
  available: boolean;
  loadError: string | null;
  visible: (id: string) => boolean;
  ensure: (requests: readonly Request[]) => Promise<void>;
  applySnapshot: (snapshot: PermissionReview, startedAt?: number) => void;
  load: (options?: { refresh?: boolean }) => Promise<void>;
  disconnect: () => void;
  connect: () => void;
  reset: () => void;
}

// Presentation only: raw requests and composer blocking remain owned by sync.
export const usePermissionReviewStore = create<PermissionReviewState>()((set, get) => {
  let generation = 0;
  let instanceId: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const controllers = new Set<AbortController>();
  let loading: Promise<void> | undefined;
  let hydrationGeneration = 0;
  const commit = (entries: Map<string, Presentation>) => {
    clearTimeout(timer);
    const deadlines = new Map<string, number>();
    for (const [id, entry] of entries) if ('deadline' in entry) deadlines.set(id, entry.deadline);
    set({ entries, deadlines });
    if (!deadlines.size) return;
    timer = setTimeout(() => {
      const next = new Map(get().entries);
      for (const [id, entry] of next) {
        if ('deadline' in entry && entry.deadline <= performance.now()) next.set(id, { phase: 'fallback' });
      }
      commit(next);
    }, Math.max(0, Math.min(...deadlines.values()) - performance.now()));
  };
  const expose = (ids: Iterable<string>) => {
    const entries = new Map(get().entries);
    for (const id of ids) if (entries.has(id)) entries.set(id, { phase: 'fallback' });
    commit(entries);
  };
  const apply = (snapshot: PermissionReview, startedAt: number, replaceInstance = false) => {
    if (!get().available) return;
    if (snapshot.dispositionVersion !== 1) {
      expose(get().entries.keys());
      set({ available: false });
      return;
    }
    if (instanceId && instanceId !== snapshot.instanceId && !replaceInstance) return;
    if (instanceId === snapshot.instanceId && snapshot.revision <= get().revision) return;
    instanceId = snapshot.instanceId;
    const entries = new Map(get().entries);
    for (const item of snapshot.permissions) {
      const previous = entries.get(item.permissionId);
      // Once exposed, never take controls away because a late/reconnected review arrived.
      if (previous?.phase === 'fallback' || previous?.phase === 'manual') continue;
      if (!previous && entries.size >= MAX_ENTRIES) continue;
      if (item.phase === 'manual') entries.set(item.permissionId, { phase: 'manual' });
      else {
        const deadline = Math.min(startedAt + item.remainingMs,
          previous && previous.phase !== 'lookup' && 'deadline' in previous ? previous.deadline : Infinity);
        entries.set(item.permissionId, deadline > performance.now()
          ? { phase: item.phase === 'answered' ? 'answered' : 'reviewing', deadline }
          : { phase: 'fallback' });
      }
    }
    // Missing IDs remain unknown. A complete snapshot is not a manual verdict.
    set({ revision: snapshot.revision, loadError: null });
    commit(entries);
  };
  const lookup = async (requests: readonly Request[], hydration?: number) => {
    const owner = generation;
    const runtime = getRuntimeKey();
    const instanceAtStart = instanceId;
    const startedAt = performance.now();
    const controller = new AbortController();
    controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS);
    try {
      const response = await runtimeFetch('/api/permission-auto-accept/dispositions', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requests }), signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Permission disposition lookup returned ${response.status}`);
      const snapshot = permissionReviewSchema.parse(await response.json());
      if (owner !== generation || runtime !== getRuntimeKey() || controller.signal.aborted
        || (hydration !== undefined && hydration !== hydrationGeneration)) return;
      apply(snapshot, startedAt, instanceId === instanceAtStart);
      // A successful lookup still owes every requested ID an explicit outcome.
      expose(requests.filter(({ id }) => get().entries.get(id)?.phase === 'lookup').map(({ id }) => id));
    } catch (error) {
      if (owner !== generation || runtime !== getRuntimeKey()
        || (hydration !== undefined && hydration !== hydrationGeneration)) return;
      expose(get().entries.keys());
      set({ available: false, loadError: error instanceof Error ? error.message : 'Disposition lookup failed' });
      console.warn('[permission-review] Disposition lookup failed');
    } finally {
      clearTimeout(timeout);
      controllers.delete(controller);
    }
  };
  return {
    revision: -1, entries: new Map(), deadlines: new Map(), available: true, loadError: null,
    visible: (id) => {
      if (isVSCodeRuntime()) return true;
      const state = get();
      const entry = state.entries.get(id);
      if (!entry) return !state.available || state.entries.size >= MAX_ENTRIES;
      return entry.phase === 'manual' || entry.phase === 'fallback';
    },
    ensure: async (requests) => {
      if (isVSCodeRuntime()) return;
      // A project store or parent dock can hold a worktree child's request.
      // Resolve each session before claiming its ID, whichever consumer arrives first.
      const unknown = requests.filter((request) => !get().entries.has(request.id)).map((request) => ({
        ...request,
        directory: useSessionUIStore.getState().getDirectoryForSession(request.sessionID) ?? request.directory,
      })).filter((request) => request.directory?.trim());
      if (!unknown.length || get().entries.size >= MAX_ENTRIES) return;
      const entries = new Map(get().entries);
      const missing: Request[] = [];
      for (const request of unknown) {
        if (entries.has(request.id) || entries.size >= MAX_ENTRIES) continue;
        if (!get().available || isSpaceDirectory(request.directory)) entries.set(request.id, { phase: 'fallback' });
        else {
          entries.set(request.id, { phase: 'lookup', deadline: performance.now() + LOOKUP_TIMEOUT_MS });
          missing.push(request);
        }
      }
      if (entries.size !== get().entries.size) commit(entries);
      // One batch per caller, shared by every presentation consumer through entries.
      await Promise.all(Array.from({ length: Math.ceil(missing.length / 100) }, (_, i) => lookup(missing.slice(i * 100, i * 100 + 100))));
    },
    applySnapshot: (snapshot, startedAt = performance.now()) => apply(snapshot, startedAt),
    load: (options) => {
      if (isVSCodeRuntime()) return Promise.resolve();
      if (options?.refresh) loading = undefined;
      if (!loading) {
        const promise = lookup([], ++hydrationGeneration).finally(() => { if (loading === promise) loading = undefined; });
        loading = promise;
      }
      return loading;
    },
    disconnect: () => {
      generation += 1;
      for (const controller of controllers) controller.abort();
      loading = undefined;
      expose(get().entries.keys());
      set({ available: false });
    },
    connect: () => { set({ available: true }); },
    reset: () => {
      generation += 1;
      for (const controller of controllers) controller.abort();
      controllers.clear();
      clearTimeout(timer);
      loading = undefined;
      instanceId = undefined;
      set({ revision: -1, entries: new Map(), deadlines: new Map(), available: true, loadError: null });
    },
  };
});

export function useVisiblePermissions<T extends Request>(requests: readonly T[], directory?: string): T[] {
  const entries = usePermissionReviewStore((state) => state.entries);
  const available = usePermissionReviewStore((state) => state.available);
  useLayoutEffect(() => {
    void usePermissionReviewStore.getState().ensure(requests.map((request) => ({
      id: request.id, sessionID: request.sessionID, directory: directory ?? request.directory,
    })));
  }, [requests, directory, entries, available]);
  return requests.filter((request) => isSpaceDirectory(directory ?? request.directory) || usePermissionReviewStore.getState().visible(request.id));
}
