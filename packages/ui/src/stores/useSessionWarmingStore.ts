import { create } from 'zustand';
import { z } from 'zod';
import { runtimeFetch } from '@/lib/runtime-fetch';


export const sessionWarmingSnapshotSchema = z.object({
  revision: z.number(),
  enabled: z.boolean(),
  minutes: z.number(),
  sessions: z.array(z.object({ sessionId: z.string().min(1), warmUntil: z.number().nullable() })),
});

export type SessionWarmingSnapshot = z.infer<typeof sessionWarmingSnapshotSchema>;

export type SessionWarmingMode = 'off' | 'all' | 'session';

export const WARMING_DURATION_STEPS = [30, 60, 120, 180] as const;

type SessionWarmingState = {
  status: 'loading' | 'ready' | 'unavailable';
  revision: number | null;
  enabled: boolean;
  minutes: number;
  sessions: Record<string, number | null>;
  applySnapshot: (snapshot: SessionWarmingSnapshot) => void;
  refresh: (isCurrent?: () => boolean) => Promise<void>;
  setMode: (mode: SessionWarmingMode) => Promise<void>;
  setMinutes: (scope: 'all' | 'session', minutes: number) => Promise<void>;
  setSessionWarm: (sessionId: string, directory: string, warm: boolean) => Promise<void>;
  reset: () => void;
};

const readSnapshot = async (path: string, init?: { method: 'PUT'; body: string }): Promise<SessionWarmingSnapshot> => {
  const headers = new Headers({ Accept: 'application/json' });
  if (init) headers.set('Content-Type', 'application/json');
  const response = await runtimeFetch(path, { ...init, headers });
  if (!response.ok) throw new Error(`Session warming request failed with ${response.status}`);
  return sessionWarmingSnapshotSchema.parse(await response.json());
};

export const useSessionWarmingStore = create<SessionWarmingState>()((set, get) => ({
  status: 'loading',
  revision: null,
  enabled: false,
  minutes: 60,
  sessions: {},

  applySnapshot: (snapshot) => {
    const current = get().revision;
    if (current !== null && snapshot.revision < current) return;
    set({
      status: 'ready',
      revision: snapshot.revision,
      enabled: snapshot.enabled,
      minutes: snapshot.minutes,
      sessions: Object.fromEntries(snapshot.sessions.map((entry) => [entry.sessionId, entry.warmUntil])),
    });
  },

  refresh: async (isCurrent = () => true) => {
    let snapshot: SessionWarmingSnapshot;
    try {
      snapshot = await readSnapshot('/api/session-warming');
    } catch (error) {
      if (isCurrent() && get().revision === null) set({ status: 'unavailable' });
      throw error;
    }
    if (isCurrent()) get().applySnapshot(snapshot);
  },

  setMode: async (mode) => {
    if (get().status === 'unavailable') {
      if (mode === 'session') throw new Error('per-session warming is unavailable on this server');
      const response = await runtimeFetch('/api/config/warming', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ enabled: mode === 'all' }),
      });
      if (!response.ok) throw new Error(`Session warming request failed with ${response.status}`);
      return;
    }
    get().applySnapshot(await readSnapshot('/api/session-warming/mode', {
      method: 'PUT',
      body: JSON.stringify({ mode }),
    }));
  },

  setMinutes: async (scope, minutes) => {
    get().applySnapshot(await readSnapshot('/api/session-warming/duration', {
      method: 'PUT',
      body: JSON.stringify({ scope, minutes }),
    }));
  },

  setSessionWarm: async (sessionId, directory, warm) => {
    get().applySnapshot(await readSnapshot(`/api/session-warming/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'PUT',
      body: JSON.stringify({ directory, warm }),
    }));
  },

  reset: () => set({ status: 'loading', revision: null, enabled: false, minutes: 60, sessions: {} }),
}));

export const useSessionWarmUntil = (sessionId: string | null): number | null | undefined =>
  useSessionWarmingStore((state) => (sessionId && sessionId in state.sessions ? state.sessions[sessionId] : undefined));
