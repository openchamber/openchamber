import { create } from 'zustand';
import { opencodeClient } from '@/lib/opencode/client';
import { ascendingId } from '@/lib/opencode/ids';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { formatCogMapDeltaDsl } from '@/components/chat/a2ui/cogmap/graph';
import type {
  CogMapAuthor,
  CogMapLadderingIntent,
  CogMapMutationPayload,
  CogMapNode,
  CogMapPacing,
  CogMapSessionState,
  CognitiveMap,
} from '@/components/chat/a2ui/cogmap/types';

export interface CogMapUpdatedPayload {
  sessionId: string;
  directory: string | null;
  map: CognitiveMap;
  author: CogMapAuthor;
  modeActive: boolean;
  pacing: CogMapPacing;
}

export interface CogMapModePayload {
  sessionId: string;
  directory: string | null;
  active: boolean;
  pacing: CogMapPacing;
}

interface CogMapStoreState {
  sessions: Record<string, CogMapSessionState>;
  loadingBySession: Record<string, boolean>;
  // Snapshot of each map at the last point the agent saw it, used to compute minimal user deltas.
  lastSyncedByKey: Record<string, CognitiveMap>;
  // Draft toggle for brand-new sessions before their first message creates a sessionId.
  draftModeActive: boolean;
  draftPacing: CogMapPacing;
  selectedMapIdBySession: Record<string, string | null>;

  setDraftMode: (active: boolean, pacing?: CogMapPacing) => void;
  setDraftPacing: (pacing: CogMapPacing) => void;
  consumeDraftMode: () => { active: boolean; pacing: CogMapPacing };
  setSelectedMapId: (sessionId: string, mapId: string | null) => void;

  fetchSessionMaps: (sessionId: string) => Promise<CogMapSessionState | null>;
  mutateMap: (sessionId: string, payload: CogMapMutationPayload, directory?: string | null) => Promise<CognitiveMap | null>;
  setSessionMode: (
    sessionId: string,
    options: { active?: boolean; pacing?: CogMapPacing; activeMapId?: string | null; directory?: string | null },
  ) => Promise<CogMapSessionState | null>;
  deleteMap: (sessionId: string, mapId: string) => Promise<void>;

  applyServerUpdate: (event: CogMapUpdatedPayload) => void;
  applyModeEvent: (event: CogMapModePayload) => void;
  consumeUserDelta: (sessionId: string, mapId: string) => string;
  consumeSessionUserDeltas: (sessionId: string) => string;
}

const syncKey = (sessionId: string, mapId: string) => `${sessionId}\u0000${mapId}`;

const cloneMap = (map: CognitiveMap): CognitiveMap => ({
  ...map,
  nodes: map.nodes.map((node) => ({ ...node })),
  edges: map.edges.map((edge) => ({ ...edge })),
});

export const useCogMapStore = create<CogMapStoreState>((set, get) => ({
  sessions: {},
  loadingBySession: {},
  lastSyncedByKey: {},
  draftModeActive: false,
  draftPacing: 'collab',
  selectedMapIdBySession: {},

  setDraftMode: (active, pacing) =>
    set((state) => ({
      draftModeActive: active,
      draftPacing: pacing ?? state.draftPacing,
    })),

  setDraftPacing: (pacing) => set({ draftPacing: pacing }),

  consumeDraftMode: () => {
    const { draftModeActive, draftPacing } = get();
    if (draftModeActive) {
      set({ draftModeActive: false });
    }
    return { active: draftModeActive, pacing: draftPacing };
  },

  setSelectedMapId: (sessionId, mapId) =>
    set((state) => ({
      selectedMapIdBySession: { ...state.selectedMapIdBySession, [sessionId]: mapId },
    })),

  fetchSessionMaps: async (sessionId) => {
    const cleanId = sessionId.trim();
    if (!cleanId) return null;
    set((state) => ({ loadingBySession: { ...state.loadingBySession, [cleanId]: true } }));
    try {
      const response = await runtimeFetch(`/api/openchamber/cogmap/${encodeURIComponent(cleanId)}`, {
        credentials: 'include',
      });
      if (!response.ok) return null;
      const data = (await response.json()) as CogMapSessionState;
      set((state) => {
        const nextSynced = { ...state.lastSyncedByKey };
        for (const map of Object.values(data.maps ?? {})) {
          const key = syncKey(cleanId, map.id);
          if (!nextSynced[key]) {
            nextSynced[key] = cloneMap(map);
          }
        }
        return {
          sessions: { ...state.sessions, [cleanId]: data },
          lastSyncedByKey: nextSynced,
          loadingBySession: { ...state.loadingBySession, [cleanId]: false },
        };
      });
      return data;
    } catch {
      set((state) => ({ loadingBySession: { ...state.loadingBySession, [cleanId]: false } }));
      return null;
    }
  },

  mutateMap: async (sessionId, payload, directory) => {
    const cleanId = sessionId.trim();
    if (!cleanId) return null;
    try {
      const response = await runtimeFetch(`/api/openchamber/cogmap/${encodeURIComponent(cleanId)}/mutate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ ...payload, ...(directory ? { directory } : {}) }),
      });
      if (!response.ok) return null;
      const result = (await response.json()) as { map: CognitiveMap; state: CogMapSessionState };
      if (result?.state && result?.map) {
        set((state) => ({
          sessions: { ...state.sessions, [cleanId]: result.state },
          selectedMapIdBySession: { ...state.selectedMapIdBySession, [cleanId]: result.map.id },
        }));
        return result.map;
      }
      return null;
    } catch {
      return null;
    }
  },

  setSessionMode: async (sessionId, options) => {
    const cleanId = sessionId.trim();
    if (!cleanId) return null;
    try {
      const response = await runtimeFetch(`/api/openchamber/cogmap/${encodeURIComponent(cleanId)}/mode`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(options),
      });
      if (!response.ok) return null;
      const next = (await response.json()) as CogMapSessionState;
      set((state) => ({
        sessions: { ...state.sessions, [cleanId]: next },
      }));
      return next;
    } catch {
      return null;
    }
  },

  deleteMap: async (sessionId, mapId) => {
    const cleanId = sessionId.trim();
    if (!cleanId || !mapId) return;
    try {
      const response = await runtimeFetch(
        `/api/openchamber/cogmap/${encodeURIComponent(cleanId)}/${encodeURIComponent(mapId)}`,
        { method: 'DELETE', credentials: 'include' },
      );
      if (!response.ok) return;
      const next = (await response.json()) as CogMapSessionState;
      set((state) => {
        const nextSynced = { ...state.lastSyncedByKey };
        delete nextSynced[syncKey(cleanId, mapId)];
        return {
          sessions: { ...state.sessions, [cleanId]: next },
          lastSyncedByKey: nextSynced,
        };
      });
    } catch {
      // Ignore network errors cleanly.
    }
  },

  applyServerUpdate: (event) => {
    set((state) => {
      const existing = state.sessions[event.sessionId] ?? {
        sessionId: event.sessionId,
        modeActive: event.modeActive,
        pacing: event.pacing,
        activeMapId: event.map.id,
        maps: {},
      };
      const nextSession: CogMapSessionState = {
        ...existing,
        modeActive: event.modeActive,
        pacing: event.pacing,
        activeMapId: event.map.id,
        maps: {
          ...existing.maps,
          [event.map.id]: event.map,
        },
      };
      const nextSynced = { ...state.lastSyncedByKey };
      // When the agent writes, this revision becomes the new synced baseline.
      if (event.author === 'agent') {
        nextSynced[syncKey(event.sessionId, event.map.id)] = cloneMap(event.map);
      }
      return {
        sessions: { ...state.sessions, [event.sessionId]: nextSession },
        lastSyncedByKey: nextSynced,
      };
    });
  },

  applyModeEvent: (event) => {
    set((state) => {
      const existing = state.sessions[event.sessionId] ?? {
        sessionId: event.sessionId,
        modeActive: event.active,
        pacing: event.pacing,
        activeMapId: null,
        maps: {},
      };
      return {
        sessions: {
          ...state.sessions,
          [event.sessionId]: {
            ...existing,
            modeActive: event.active,
            pacing: event.pacing,
          },
        },
      };
    });
  },

  consumeUserDelta: (sessionId, mapId) => {
    const state = get();
    const map = state.sessions[sessionId]?.maps[mapId];
    if (!map) return '';
    const key = syncKey(sessionId, mapId);
    const baseline = state.lastSyncedByKey[key] ?? null;
    if (baseline && baseline.rev === map.rev) return '';
    const delta = formatCogMapDeltaDsl(baseline, map);
    set((prev) => ({
      lastSyncedByKey: { ...prev.lastSyncedByKey, [key]: cloneMap(map) },
    }));
    return delta;
  },

  consumeSessionUserDeltas: (sessionId) => {
    const session = get().sessions[sessionId];
    if (!session) return '';
    const deltas: string[] = [];
    for (const mapId of Object.keys(session.maps)) {
      const delta = get().consumeUserDelta(sessionId, mapId);
      if (delta) deltas.push(delta);
    }
    return deltas.join('\n');
  },
}));

const INTENT_INSTRUCTIONS: Record<CogMapLadderingIntent, string> = {
  ladder_up: 'Ladder UP (Why / Wozu?): add 2–3 higher-level goals/consequences that this node leads to or inhibits via cogmap.mutate.',
  ladder_down: 'Ladder DOWN (How / Root Cause?): add 2–3 concrete actions, levers, or root causes driving this node via cogmap.mutate.',
  challenge: 'Challenge / Stress-test: refine contrast poles, surface hidden constraints or counter-assumptions connected to this node via cogmap.mutate.',
  loops: 'Explore Feedback Loops: identify any reinforcing or balancing causal loops involving this node and add missing feedback edges/nodes via cogmap.mutate.',
  explain: 'Drill down: enrich this node\'s `note` (or add 1–2 clarifying factors) so the user can understand the mechanism concisely.',
};

/**
 * Dispatches a minimal-token bidirectional laddering intent (plus any unsynced
 * user canvas edits as a tiny delta) to the active session.
 */
export async function dispatchCogMapLaddering(params: {
  sessionId: string;
  directory: string;
  mapId: string;
  node: CogMapNode;
  intent: CogMapLadderingIntent;
}): Promise<void> {
  const { sessionId, directory, mapId, node, intent } = params;
  const userDelta = useCogMapStore.getState().consumeUserDelta(sessionId, mapId);
  const lines = [
    `<cogmap-intent mapId="${mapId}" intent="${intent}" nodeId="${node.id}">`,
    `Target node ${node.id}: "${node.label}"${node.pole ? ` ... "${node.pole}"` : ''} [${node.role}]`,
    INTENT_INSTRUCTIONS[intent],
    '</cogmap-intent>',
  ];
  if (userDelta) lines.unshift(userDelta);

  await opencodeClient.resumeWithSyntheticInput({
    runtimeKey: getRuntimeKey(),
    id: ascendingId('msg'),
    sessionId,
    directory,
    text: lines.join('\n'),
    metadata: {
      openchamberCogMapIntent: { mapId, intent, nodeId: node.id },
    },
  });
}
