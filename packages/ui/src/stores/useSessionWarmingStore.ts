import { create } from 'zustand';
import { z } from 'zod';
import { runtimeFetch } from '@/lib/runtime-fetch';

/**
 * Per-session warming, owned by the server (`lib/session-warming`). The server
 * keeps the chosen sessions' prompt cache warm for the chosen duration after each turn;
 * this store mirrors its snapshot for the toggles and the countdown.
 */

export const sessionWarmingSnapshotSchema = z.object({
  revision: z.number(),
  enabled: z.boolean(),
  /** How long a chosen session stays warm after a reply. */
  minutes: z.number(),
  sessions: z.array(z.object({ sessionId: z.string().min(1), warmUntil: z.number().nullable() })),
});

export type SessionWarmingSnapshot = z.infer<typeof sessionWarmingSnapshotSchema>;

/** How OpenChamber keeps idle sessions warm: not at all, every session (OpenCode's config), or the chosen ones. */
export type SessionWarmingMode = 'off' | 'all' | 'session';

/** The warm durations Settings offers, in minutes; the server accepts only these. */
export const WARMING_DURATION_STEPS = [30, 60, 120, 180] as const;

type SessionWarmingState = {
  /**
   * `unavailable` when the server could not be read before any snapshot came,
   * an older server without per-session warming among the cases: Settings then
   * offers only OpenCode's switch for every session.
   */
  status: 'loading' | 'ready' | 'unavailable';
  /** Null until the first snapshot arrives. */
  revision: number | null;
  /** Per-session warming is on: the session toggles are offered. */
  enabled: boolean;
  /** How long a chosen session stays warm after a reply. */
  minutes: number;
  /** Warmed session id → end of its warm window, null while a turn runs or before the first one ends. */
  sessions: Record<string, number | null>;
  applySnapshot: (snapshot: SessionWarmingSnapshot) => void;
  /** `isCurrent` drops an answer that arrives after a runtime switch. */
  refresh: (isCurrent?: () => boolean) => Promise<void>;
  setMode: (mode: SessionWarmingMode) => Promise<void>;
  /** `all` writes OpenCode's warm duration, `session` the chosen sessions' one. */
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
      // A snapshot already shown stays; only a store that never had one gives up.
      if (isCurrent() && get().revision === null) set({ status: 'unavailable' });
      throw error;
    }
    if (isCurrent()) get().applySnapshot(snapshot);
  },

  setMode: async (mode) => {
    if (get().status === 'unavailable') {
      // The server has no per-session warming: OpenCode's switch is all there is.
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

/**
 * The session's warmth: `undefined` when it is not warmed, `null` while it is
 * warmed but its window has not started, else the end of its warm window.
 */
export const useSessionWarmUntil = (sessionId: string | null): number | null | undefined =>
  useSessionWarmingStore((state) => (sessionId && sessionId in state.sessions ? state.sessions[sessionId] : undefined));
