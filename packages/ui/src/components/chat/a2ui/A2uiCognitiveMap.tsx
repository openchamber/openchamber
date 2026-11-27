import React from 'react';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import { dispatchCogMapLaddering, useCogMapStore } from '@/stores/useCogMapStore';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { CognitiveMapCanvas } from './cogmap/CognitiveMapCanvas';
import { parseCogMapDsl } from './cogmap/graph';
import type {
  CogMapEdge,
  CogMapEdgeSign,
  CogMapLadderingIntent,
  CogMapNode,
  CogMapNodeRole,
  CogMapNodeStatus,
  CogMapPacing,
} from './cogmap/types';
import { isPlainObject, type A2uiJson, type A2uiObject } from './protocol';

export interface A2uiCognitiveMapProps {
  title?: string;
  mapId?: string;
  focusNodeId?: string | null;
  height?: number;
  dsl?: string;
  rawNodes?: A2uiJson;
  rawEdges?: A2uiJson;
  pacing?: CogMapPacing;
  disabled?: boolean;
  isDemo?: boolean;
  onDispatchAction?: (actionName: string, context: A2uiObject) => void;
}

const VALID_ROLES = new Set<CogMapNodeRole>(['goal', 'option', 'factor', 'constraint', 'assumption']);
const VALID_SIGNS = new Set<CogMapEdgeSign>(['+', '-', '?']);

function parseNodesProp(raw: A2uiJson | undefined): CogMapNode[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry, index) => {
    if (!isPlainObject(entry)) return [];
    const label = typeof entry.label === 'string' ? entry.label.trim() : '';
    if (!label) return [];
    const id = typeof entry.id === 'string' && entry.id.trim() ? entry.id.trim() : `n${index + 1}`;
    const rawRole = typeof entry.role === 'string' ? entry.role.trim().toLowerCase() : 'factor';
    const role: CogMapNodeRole = VALID_ROLES.has(rawRole as CogMapNodeRole) ? (rawRole as CogMapNodeRole) : 'factor';
    const status: CogMapNodeStatus = entry.status === 'proposed' ? 'proposed' : 'agreed';
    const author = entry.author === 'user' ? 'user' : 'agent';
    return [{
      id,
      label,
      ...(typeof entry.pole === 'string' && entry.pole.trim() ? { pole: entry.pole.trim() } : {}),
      role,
      ...(typeof entry.note === 'string' && entry.note.trim() ? { note: entry.note.trim() } : {}),
      ...(typeof entry.cluster === 'string' && entry.cluster.trim() ? { cluster: entry.cluster.trim() } : {}),
      author,
      status,
    }];
  });
}

function parseEdgesProp(raw: A2uiJson | undefined): CogMapEdge[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry, index) => {
    if (!isPlainObject(entry)) return [];
    const from = typeof entry.from === 'string' ? entry.from.trim() : '';
    const to = typeof entry.to === 'string' ? entry.to.trim() : '';
    if (!from || !to) return [];
    const rawSign = typeof entry.sign === 'string' ? entry.sign.trim() : '+';
    const sign: CogMapEdgeSign = VALID_SIGNS.has(rawSign as CogMapEdgeSign) ? (rawSign as CogMapEdgeSign) : '+';
    const id = typeof entry.id === 'string' && entry.id.trim() ? entry.id.trim() : `e${index + 1}`;
    return [{
      id,
      from,
      to,
      sign,
      ...(typeof entry.label === 'string' && entry.label.trim() ? { label: entry.label.trim() } : {}),
    }];
  });
}

export function A2uiCognitiveMap({
  title,
  mapId,
  focusNodeId = null,
  height = 360,
  dsl,
  rawNodes,
  rawEdges,
  pacing = 'collab',
  disabled = false,
  isDemo = false,
  onDispatchAction,
}: A2uiCognitiveMapProps) {
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const effectiveDirectory = useEffectiveDirectory() ?? '';
  const openContextSurface = useUIStore((state) => state.openContextSurface);

  const liveSession = useCogMapStore((state) => (currentSessionId ? state.sessions[currentSessionId] : undefined));
  const fetchSessionMaps = useCogMapStore((state) => state.fetchSessionMaps);
  const setSelectedMapId = useCogMapStore((state) => state.setSelectedMapId);

  const liveMap = React.useMemo(() => {
    if (!mapId || !liveSession) return null;
    return liveSession.maps[mapId] ?? null;
  }, [liveSession, mapId]);

  React.useEffect(() => {
    if (isDemo || !mapId || !currentSessionId || liveMap) return;
    void fetchSessionMaps(currentSessionId);
  }, [currentSessionId, fetchSessionMaps, isDemo, liveMap, mapId]);

  const parsedDsl = React.useMemo(() => (dsl ? parseCogMapDsl(dsl) : null), [dsl]);
  const propNodes = React.useMemo(() => parseNodesProp(rawNodes), [rawNodes]);
  const propEdges = React.useMemo(() => parseEdgesProp(rawEdges), [rawEdges]);

  const resolvedNodes = liveMap?.nodes ?? (propNodes.length > 0 ? propNodes : (parsedDsl?.nodes ?? []));
  const resolvedEdges = liveMap?.edges ?? (propEdges.length > 0 ? propEdges : (parsedDsl?.edges ?? []));
  const resolvedTitle = title || liveMap?.title || parsedDsl?.title || 'Cognitive Map';
  const resolvedFocus = focusNodeId ?? liveMap?.focusNodeId ?? null;
  const resolvedPacing = liveMap?.pacing ?? pacing;

  const handleLadder = React.useCallback(
    async (intent: CogMapLadderingIntent, node: CogMapNode) => {
      // Live-linked maps dispatch directly through OpenCode synthetic input with unsynced user deltas.
      if (!isDemo && liveMap && currentSessionId && effectiveDirectory) {
        await dispatchCogMapLaddering({
          sessionId: currentSessionId,
          directory: effectiveDirectory,
          mapId: liveMap.id,
          node,
          intent,
        });
        return;
      }
      // Standalone A2UI snapshot or demo dispatches cleanly as a standard A2UI action event.
      onDispatchAction?.(intent, {
        mapId: mapId ?? 'snapshot',
        intent,
        nodeId: node.id,
        label: node.label,
      });
    },
    [currentSessionId, effectiveDirectory, isDemo, liveMap, mapId, onDispatchAction],
  );

  const handleExpand = React.useCallback(() => {
    if (!effectiveDirectory || isDemo) return;
    if (currentSessionId && mapId) {
      setSelectedMapId(currentSessionId, mapId);
    }
    openContextSurface(effectiveDirectory, 'cogmap');
  }, [currentSessionId, effectiveDirectory, isDemo, mapId, openContextSurface, setSelectedMapId]);

  return (
    <CognitiveMapCanvas
      title={resolvedTitle}
      mapId={liveMap?.id ?? mapId ?? 'snapshot'}
      rev={liveMap?.rev ?? 1}
      pacing={resolvedPacing}
      nodes={resolvedNodes}
      edges={resolvedEdges}
      focusNodeId={resolvedFocus}
      compact
      height={height}
      editable={false}
      disabled={disabled && !liveMap}
      onLadder={handleLadder}
      onExpandToPanel={!isDemo && Boolean(effectiveDirectory) ? handleExpand : undefined}
    />
  );
}
