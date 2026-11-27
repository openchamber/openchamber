import { OpenChamberControlError } from '../openchamber-control/error.js';
import { analyzeCogMap } from './analyze.js';
import { serializeCogMapDsl } from './dsl.js';
import { createCogMapStore, type CogMapStoreDependencies } from './store.js';
import type { CogMapMutationInput, CogMapOpenEvent, CogMapPacing } from './types.js';

export type {
  CogMapAnalysis,
  CogMapAuthor,
  CogMapChangeEvent,
  CogMapEdge,
  CogMapEdgeSign,
  CogMapHubMetric,
  CogMapLoop,
  CogMapMutationInput,
  CogMapMutationSummary,
  CogMapNode,
  CogMapNodeRole,
  CogMapNodeStatus,
  CogMapOpenEvent,
  CogMapPacing,
  CogMapSessionState,
  CognitiveMap,
} from './types.js';

export { analyzeCogMap } from './analyze.js';
export { formatCogMapDeltaDsl, parseCogMapDsl, serializeCogMapDsl } from './dsl.js';
export { buildCogMapModeGuidance, COGMAP_POINTER_GUIDANCE } from './guidance.js';

export interface CogMapRuntimeDependencies extends CogMapStoreDependencies {
  emitOpen?: (event: CogMapOpenEvent) => number;
}

export interface CogMapActionContext {
  sessionId?: string | null;
  directory?: string | null;
}

const trimmedString = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : '';

export function createCogMapRuntime(dependencies: CogMapRuntimeDependencies) {
  const store = createCogMapStore(dependencies);
  const { emitOpen } = dependencies;

  const executeAction = async (
    action: string,
    input: Record<string, unknown> = {},
    context: CogMapActionContext = {},
  ) => {
    const sessionId = trimmedString(input.sessionId) || trimmedString(context.sessionId);
    if (!sessionId) {
      throw new OpenChamberControlError('sessionId is required for cogmap actions', 400);
    }

    if (action === 'cogmap.read') {
      const state = await store.getSessionState(sessionId);
      const map = await store.getMap(sessionId, input.mapId);
      if (!map) {
        return {
          exists: false,
          mapId: trimmedString(input.mapId) || 'm1',
          availableMaps: Object.values(state.maps).map((entry) => ({
            id: entry.id,
            title: entry.title,
            rev: entry.rev,
            nodeCount: entry.nodes.length,
          })),
          dsl: '(no map created yet — call cogmap.mutate to create one)',
        };
      }
      const focusNodeId = trimmedString(input.focusNodeId) || null;
      const depth = typeof input.depth === 'number' && Number.isFinite(input.depth) ? input.depth : undefined;
      const includeNotes = input.includeNotes === true;
      return {
        exists: true,
        mapId: map.id,
        title: map.title,
        pacing: map.pacing,
        rev: map.rev,
        focusNodeId: map.focusNodeId,
        nodeCount: map.nodes.length,
        edgeCount: map.edges.length,
        dsl: serializeCogMapDsl(map, { focusNodeId, ...(depth !== undefined ? { depth } : {}), includeNotes }),
      };
    }

    if (action === 'cogmap.mutate') {
      const { summary } = await store.mutate(sessionId, input as CogMapMutationInput, {
        author: 'agent',
        directory: context.directory ?? null,
      });
      return {
        ...summary,
        note: 'Applied delta and updated the live Cognitive Map UI. Embed `{"id":"cm","component":"CognitiveMap","mapId":"'
          + summary.mapId
          + '"}` in A2UI or call cogmap.open to focus the side panel without redrawing the graph.',
      };
    }

    if (action === 'cogmap.analyze') {
      const map = await store.getMap(sessionId, input.mapId);
      if (!map) {
        throw new OpenChamberControlError('No cognitive map exists yet in this session; call cogmap.mutate first', 404);
      }
      return analyzeCogMap(map);
    }

    if (action === 'cogmap.open') {
      const map = await store.getMap(sessionId, input.mapId);
      const mapId = map?.id ?? (trimmedString(input.mapId) || 'm1');
      const focusNodeId = trimmedString(input.focusNodeId) || map?.focusNodeId || null;
      const delivered = emitOpen
        ? emitOpen({ sessionId, directory: context.directory ?? null, mapId, focusNodeId })
        : 0;
      return { opened: true, mapId, focusNodeId, clientsReached: delivered };
    }

    throw new OpenChamberControlError(`Unsupported cogmap action: ${action}`, 400);
  };

  return {
    getSessionState: store.getSessionState,
    getMap: store.getMap,
    setMode: (sessionId: string, options: { active?: boolean; pacing?: CogMapPacing; activeMapId?: string | null }) =>
      store.setMode(sessionId, options),
    mutateByUser: (sessionId: string, input: CogMapMutationInput, directory?: string | null) =>
      store.mutate(sessionId, input, { author: 'user', directory: directory ?? null }),
    deleteMap: store.deleteMap,
    deleteSession: store.deleteSession,
    executeAction,
  };
}
