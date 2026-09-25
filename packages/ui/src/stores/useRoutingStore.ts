/**
 * Projection of the server's routing state: whether Auto can be offered, the
 * config the settings page edits, the last routing decision per session, and
 * the permissions the safety net is holding. The server is authoritative; this
 * store is refreshed from `/api/routing` and kept current by control-stream
 * events. Nothing here is persisted.
 */
import { create } from 'zustand';
import {
  clearRoutingToken,
  fetchRoutingState,
  ROUTING_UNAVAILABLE,
  saveRoutingConfig,
  saveRoutingToken,
  type RoutingConfig,
  type RoutingHeldPermission,
  type RoutingJevSource,
  type RoutingState,
} from '@/lib/routing/routingApi';

interface RoutingDecision {
  sessionId: string;
  at: number;
  category: string | null;
  confidence: number;
  reason: 'routed' | 'low-confidence' | 'unknown-category' | 'error' | 'not-ready';
  providerID?: string;
  modelID?: string;
  variant?: string | null;
  agent?: string | null;
  error?: string;
}

interface RoutingStoreState extends RoutingState {
  loaded: boolean;
  loadError: string | null;
  decisions: Record<string, RoutingDecision>;
  held: Record<string, RoutingHeldPermission>;
  load: () => Promise<void>;
  resetForRuntime: () => void;
  applyState: (state: RoutingState) => void;
  applyAvailability: (state: { available: boolean; autoReady: boolean; tokenPresent: boolean; jevSource: RoutingJevSource }) => void;
  recordDecision: (decision: RoutingDecision) => void;
  holdPermission: (held: RoutingHeldPermission) => void;
  releasePermission: (permissionId: string) => void;
  saveConfig: (config: RoutingConfig) => Promise<void>;
  setToken: (token: string) => Promise<void>;
  clearToken: () => Promise<void>;
}

/** Bumped on every load and every runtime switch; a response from an older generation is dropped. */
let loadGeneration = 0;

const heldRecord = (list: RoutingHeldPermission[] | undefined): Record<string, RoutingHeldPermission> =>
  Object.fromEntries((list ?? []).map((entry) => [entry.permissionId, entry]));

export const useRoutingStore = create<RoutingStoreState>()((set, get) => ({
  ...ROUTING_UNAVAILABLE,
  loaded: false,
  loadError: null,
  decisions: {},
  held: {},

  load: async () => {
    const generation = ++loadGeneration;
    try {
      const state = await fetchRoutingState();
      if (generation !== loadGeneration) return;
      set({ ...state, held: heldRecord(state.heldPermissions), loaded: true, loadError: null });
    } catch (error) {
      if (generation !== loadGeneration) return;
      // A failed read keeps whatever was known from this same server; it is not "routing is off".
      set({ loaded: true, loadError: error instanceof Error ? error.message : String(error) });
    }
  },

  resetForRuntime: () => {
    // Another server means another config, key and set of held requests; nothing
    // from the previous one may be offered while the new one loads.
    loadGeneration += 1;
    set({ ...ROUTING_UNAVAILABLE, loaded: false, loadError: null, decisions: {}, held: {} });
  },

  applyState: (state) => {
    set({ ...state, held: state.heldPermissions ? heldRecord(state.heldPermissions) : get().held, loaded: true, loadError: null });
  },

  applyAvailability: ({ available, autoReady, tokenPresent, jevSource }) => {
    set({ available, autoReady, tokenPresent, jevSource });
    // The config behind the change lives on the server; re-read rather than guess.
    if (available) void get().load();
  },

  recordDecision: (decision) => {
    set((state) => ({ decisions: { ...state.decisions, [decision.sessionId]: decision } }));
  },

  holdPermission: (held) => {
    set((state) => ({ held: { ...state.held, [held.permissionId]: held } }));
  },

  releasePermission: (permissionId) => {
    set((state) => {
      if (!(permissionId in state.held)) return state;
      const next = { ...state.held };
      delete next[permissionId];
      return { held: next };
    });
  },

  saveConfig: async (config) => {
    const generation = loadGeneration;
    const state = await saveRoutingConfig(config);
    if (generation === loadGeneration) get().applyState(state);
  },

  setToken: async (token) => {
    const generation = loadGeneration;
    const state = await saveRoutingToken(token);
    if (generation === loadGeneration) get().applyState(state);
  },

  clearToken: async () => {
    const generation = loadGeneration;
    const state = await clearRoutingToken();
    if (generation === loadGeneration) get().applyState(state);
  },
}));

/** Whether the composer may offer the Auto row right now. */
export const selectAutoReady = (state: RoutingStoreState): boolean => state.available && state.autoReady;
