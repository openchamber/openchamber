import nodeFsPromises from 'node:fs/promises';
import nodePath from 'node:path';
import { OpenChamberControlError } from '../openchamber-control/error.js';
import type {
  CogMapAuthor,
  CogMapChangeEvent,
  CogMapEdge,
  CogMapEdgeAddInput,
  CogMapEdgeSign,
  CogMapMutationInput,
  CogMapMutationSummary,
  CogMapNode,
  CogMapNodeAddInput,
  CogMapNodeRole,
  CogMapNodeStatus,
  CogMapNodeUpdateInput,
  CogMapPacing,
  CogMapSessionState,
  CognitiveMap,
} from './types.js';

const MAX_NODES = 150;
const MAX_EDGES = 400;
const MAX_TITLE_LENGTH = 120;
const MAX_LABEL_LENGTH = 140;
const MAX_NOTE_LENGTH = 2000;
const MAX_EDGE_LABEL_LENGTH = 60;
const MAX_CLUSTER_LENGTH = 48;
const SAFE_ID_RE = /^[a-zA-Z0-9_-]{1,48}$/;

const VALID_ROLES = new Set<CogMapNodeRole>(['goal', 'option', 'factor', 'constraint', 'assumption']);
const VALID_STATUSES = new Set<CogMapNodeStatus>(['proposed', 'agreed']);
const VALID_SIGNS = new Set<CogMapEdgeSign>(['+', '-', '?']);
const VALID_PACING = new Set<CogMapPacing>(['auto', 'collab']);

const DEFAULT_MAP_ID = 'm1';

export interface CogMapStoreDependencies {
  dataDir: string;
  fsPromises?: typeof nodeFsPromises;
  path?: typeof nodePath;
  now?: () => number;
  onChanged?: (event: CogMapChangeEvent) => void;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const trimmedString = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : '';

function sanitizeSessionFileId(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 128);
}

function normalizeMapId(raw: unknown): string {
  const value = trimmedString(raw);
  if (!value) return DEFAULT_MAP_ID;
  if (!SAFE_ID_RE.test(value)) {
    throw new OpenChamberControlError(`Invalid mapId "${value}": use 1-48 alphanumeric, dash, or underscore characters`, 400);
  }
  return value;
}

function normalizeRole(raw: unknown, fallback: CogMapNodeRole = 'factor'): CogMapNodeRole {
  const value = trimmedString(raw).toLowerCase();
  if (!value) return fallback;
  if (VALID_ROLES.has(value as CogMapNodeRole)) return value as CogMapNodeRole;
  // Recover common synonyms from models so minor terminology slips never reject a valid map step.
  if (value === 'head' || value === 'end' || value === 'objective' || value === 'outcome') return 'goal';
  if (value === 'action' || value === 'lever' || value === 'tail' || value === 'intervention' || value === 'means') return 'option';
  if (value === 'risk' || value === 'limit' || value === 'blocker' || value === 'cost') return 'constraint';
  if (value === 'question' || value === 'belief' || value === 'hypothesis') return 'assumption';
  return fallback;
}

function normalizeStatus(raw: unknown, fallback: CogMapNodeStatus): CogMapNodeStatus {
  const value = trimmedString(raw).toLowerCase();
  if (VALID_STATUSES.has(value as CogMapNodeStatus)) return value as CogMapNodeStatus;
  return fallback;
}

function normalizeSign(raw: unknown): CogMapEdgeSign {
  const value = trimmedString(raw);
  if (VALID_SIGNS.has(value as CogMapEdgeSign)) return value as CogMapEdgeSign;
  if (value === 'positive' || value === 'promotes' || value === '+>') return '+';
  if (value === 'negative' || value === 'inhibits' || value === '->') return '-';
  if (value === 'uncertain' || value === '?>') return '?';
  return '+';
}

function normalizePacing(raw: unknown, fallback: CogMapPacing): CogMapPacing {
  const value = trimmedString(raw).toLowerCase();
  if (VALID_PACING.has(value as CogMapPacing)) return value as CogMapPacing;
  return fallback;
}

function nextSequentialId(prefix: string, existing: ReadonlySet<string>): string {
  let num = existing.size + 1;
  while (existing.has(`${prefix}${num}`)) num += 1;
  return `${prefix}${num}`;
}

export function createCogMapStore({
  dataDir,
  fsPromises = nodeFsPromises,
  path = nodePath,
  now = Date.now,
  onChanged,
}: CogMapStoreDependencies) {
  const rootDir = path.join(dataDir, 'cogmaps');
  const cache = new Map<string, CogMapSessionState>();
  // Serialize writes per session so parallel tool/UI edits never clobber each other.
  const writeChains = new Map<string, Promise<unknown>>();

  const sessionFilePath = (sessionId: string) => path.join(rootDir, `${sanitizeSessionFileId(sessionId)}.json`);

  const emptySessionState = (sessionId: string): CogMapSessionState => ({
    sessionId,
    modeActive: false,
    pacing: 'collab',
    activeMapId: null,
    maps: {},
  });

  const loadSession = async (sessionId: string): Promise<CogMapSessionState> => {
    const cached = cache.get(sessionId);
    if (cached) return cached;
    try {
      const raw = await fsPromises.readFile(sessionFilePath(sessionId), 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (isRecord(parsed) && isRecord(parsed.maps)) {
        const state: CogMapSessionState = {
          sessionId,
          modeActive: parsed.modeActive === true,
          pacing: normalizePacing(parsed.pacing, 'collab'),
          activeMapId: typeof parsed.activeMapId === 'string' ? parsed.activeMapId : null,
          maps: parsed.maps as Record<string, CognitiveMap>,
        };
        cache.set(sessionId, state);
        return state;
      }
    } catch (error) {
      const code = (error as { code?: string })?.code;
      if (code !== 'ENOENT') {
        console.warn('[cogmap] could not read stored session maps:', error instanceof Error ? error.message : String(error));
      }
    }
    const fresh = emptySessionState(sessionId);
    cache.set(sessionId, fresh);
    return fresh;
  };

  const persistSession = async (state: CogMapSessionState): Promise<void> => {
    await fsPromises.mkdir(rootDir, { recursive: true });
    const filePath = sessionFilePath(state.sessionId);
    const tmp = `${filePath}.tmp-${process.pid}-${now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      await fsPromises.writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await fsPromises.rename(tmp, filePath);
    } catch (error) {
      await fsPromises.rm(tmp, { force: true }).catch(() => {});
      throw error;
    }
  };

  const withSessionLock = <Result>(sessionId: string, fn: () => Promise<Result>): Promise<Result> => {
    const previous = writeChains.get(sessionId) ?? Promise.resolve();
    const run = previous.catch(() => {}).then(fn);
    const tail = run.then(() => undefined, () => undefined);
    writeChains.set(sessionId, tail);
    void tail.finally(() => {
      if (writeChains.get(sessionId) === tail) writeChains.delete(sessionId);
    });
    return run;
  };

  const getSessionState = async (sessionId: string): Promise<CogMapSessionState> => {
    const cleanId = trimmedString(sessionId);
    if (!cleanId) throw new OpenChamberControlError('sessionId is required', 400);
    return loadSession(cleanId);
  };

  const getMap = async (sessionId: string, mapId?: unknown): Promise<CognitiveMap | null> => {
    const state = await getSessionState(sessionId);
    const requested = trimmedString(mapId);
    const targetId = requested || state.activeMapId || DEFAULT_MAP_ID;
    return state.maps[targetId] ?? null;
  };

  const setMode = async (
    sessionId: string,
    options: { active?: boolean; pacing?: CogMapPacing; activeMapId?: string | null },
  ): Promise<CogMapSessionState> => {
    const cleanId = trimmedString(sessionId);
    if (!cleanId) throw new OpenChamberControlError('sessionId is required', 400);
    return withSessionLock(cleanId, async () => {
      const state = await loadSession(cleanId);
      const next: CogMapSessionState = {
        ...state,
        modeActive: options.active !== undefined ? options.active : state.modeActive,
        pacing: options.pacing !== undefined ? normalizePacing(options.pacing, state.pacing) : state.pacing,
        activeMapId: options.activeMapId !== undefined ? options.activeMapId : state.activeMapId,
      };
      cache.set(cleanId, next);
      await persistSession(next);
      return next;
    });
  };

  const mutate = async (
    sessionId: string,
    input: CogMapMutationInput,
    options: { author: CogMapAuthor; directory?: string | null },
  ): Promise<{ map: CognitiveMap; summary: CogMapMutationSummary; state: CogMapSessionState }> => {
    const cleanSessionId = trimmedString(sessionId);
    if (!cleanSessionId) throw new OpenChamberControlError('sessionId is required', 400);

    return withSessionLock(cleanSessionId, async () => {
      const state = await loadSession(cleanSessionId);
      const requestedMapId = trimmedString(input.mapId);
      const mapId = requestedMapId ? normalizeMapId(requestedMapId) : (state.activeMapId || DEFAULT_MAP_ID);
      const timestamp = now();

      const existing = state.maps[mapId];
      const nextPacing = normalizePacing(input.pacing, existing?.pacing ?? state.pacing);
      const rawTitle = trimmedString(input.title);
      const title = (rawTitle || existing?.title || 'Cognitive Map').slice(0, MAX_TITLE_LENGTH);

      const nodes = existing ? existing.nodes.map((node) => ({ ...node })) : [];
      let edges = existing ? existing.edges.map((edge) => ({ ...edge })) : [];

      const nodeIndexById = new Map<string, number>(nodes.map((node, index) => [node.id, index]));
      const existingNodeIds = new Set<string>(nodes.map((node) => node.id));
      const existingEdgeIds = new Set<string>(edges.map((edge) => edge.id));

      const addedNodes: CogMapMutationSummary['addedNodes'] = [];
      const updatedNodeIds: string[] = [];
      const removedNodeIds: string[] = [];
      const addedEdges: CogMapMutationSummary['addedEdges'] = [];
      const removedEdgeIds: string[] = [];

      // 1. Add new nodes (defaulting status to 'proposed' when agent writes in collab mode).
      const defaultStatus: CogMapNodeStatus = options.author === 'user' || nextPacing === 'auto' ? 'agreed' : 'proposed';
      if (input.addNodes !== undefined) {
        if (!Array.isArray(input.addNodes)) {
          throw new OpenChamberControlError('addNodes must be an array', 400);
        }
        for (const rawEntry of input.addNodes) {
          if (!isRecord(rawEntry)) continue;
          const entry = rawEntry as CogMapNodeAddInput;
          const label = trimmedString(entry.label).slice(0, MAX_LABEL_LENGTH);
          if (!label) {
            throw new OpenChamberControlError('Every node in addNodes requires a non-empty label', 400);
          }
          const rawId = trimmedString(entry.id);
          const id = rawId ? (SAFE_ID_RE.test(rawId) ? rawId : nextSequentialId('n', existingNodeIds)) : nextSequentialId('n', existingNodeIds);
          if (existingNodeIds.has(id)) {
            throw new OpenChamberControlError(`Node "${id}" already exists; use updateNodes to modify it`, 400);
          }
          if (nodes.length >= MAX_NODES) {
            throw new OpenChamberControlError(`Map cannot exceed ${MAX_NODES} nodes`, 400);
          }
          const pole = trimmedString(entry.pole).slice(0, MAX_LABEL_LENGTH) || undefined;
          const note = trimmedString(entry.note).slice(0, MAX_NOTE_LENGTH) || undefined;
          const cluster = trimmedString(entry.cluster).slice(0, MAX_CLUSTER_LENGTH) || undefined;
          const role = normalizeRole(entry.role, 'factor');
          const status = normalizeStatus(entry.status, defaultStatus);

          const node: CogMapNode = {
            id,
            label,
            ...(pole ? { pole } : {}),
            role,
            ...(note ? { note } : {}),
            ...(cluster ? { cluster } : {}),
            author: options.author,
            status,
          };
          nodeIndexById.set(id, nodes.length);
          existingNodeIds.add(id);
          nodes.push(node);
          addedNodes.push({ id, label, role });
        }
      }

      // 2. Update existing nodes in place.
      if (input.updateNodes !== undefined) {
        if (!Array.isArray(input.updateNodes)) {
          throw new OpenChamberControlError('updateNodes must be an array', 400);
        }
        for (const rawEntry of input.updateNodes) {
          if (!isRecord(rawEntry)) continue;
          const entry = rawEntry as CogMapNodeUpdateInput;
          const id = trimmedString(entry.id);
          const idx = nodeIndexById.get(id);
          if (!id || idx === undefined) {
            throw new OpenChamberControlError(`Cannot update unknown node "${id || 'missing'}"`, 404);
          }
          const target = nodes[idx];
          if (!target) continue;
          if (entry.label !== undefined) {
            const label = trimmedString(entry.label).slice(0, MAX_LABEL_LENGTH);
            if (!label) throw new OpenChamberControlError(`Node "${id}" label cannot be empty`, 400);
            target.label = label;
          }
          if (entry.pole !== undefined) {
            const pole = trimmedString(entry.pole).slice(0, MAX_LABEL_LENGTH);
            if (pole) target.pole = pole;
            else delete target.pole;
          }
          if (entry.role !== undefined) {
            target.role = normalizeRole(entry.role, target.role);
          }
          if (entry.note !== undefined) {
            const note = trimmedString(entry.note).slice(0, MAX_NOTE_LENGTH);
            if (note) target.note = note;
            else delete target.note;
          }
          if (entry.cluster !== undefined) {
            const cluster = trimmedString(entry.cluster).slice(0, MAX_CLUSTER_LENGTH);
            if (cluster) target.cluster = cluster;
            else delete target.cluster;
          }
          if (entry.status !== undefined) {
            target.status = normalizeStatus(entry.status, target.status);
          }
          updatedNodeIds.push(id);
        }
      }

      // 3. Remove nodes (cascades incident edges).
      if (input.removeNodeIds !== undefined) {
        if (!Array.isArray(input.removeNodeIds)) {
          throw new OpenChamberControlError('removeNodeIds must be an array', 400);
        }
        const toRemove = new Set(input.removeNodeIds.map(trimmedString).filter(Boolean));
        if (toRemove.size > 0) {
          for (let i = nodes.length - 1; i >= 0; i -= 1) {
            const candidate = nodes[i];
            if (candidate && toRemove.has(candidate.id)) {
              nodes.splice(i, 1);
              existingNodeIds.delete(candidate.id);
              removedNodeIds.push(candidate.id);
            }
          }
          edges = edges.filter((edge) => {
            if (toRemove.has(edge.from) || toRemove.has(edge.to)) {
              existingEdgeIds.delete(edge.id);
              removedEdgeIds.push(edge.id);
              return false;
            }
            return true;
          });
        }
      }

      // 4. Remove specific edges.
      if (input.removeEdgeIds !== undefined) {
        if (!Array.isArray(input.removeEdgeIds)) {
          throw new OpenChamberControlError('removeEdgeIds must be an array', 400);
        }
        const toRemove = new Set(input.removeEdgeIds.map(trimmedString).filter(Boolean));
        if (toRemove.size > 0) {
          edges = edges.filter((edge) => {
            if (toRemove.has(edge.id)) {
              existingEdgeIds.delete(edge.id);
              removedEdgeIds.push(edge.id);
              return false;
            }
            return true;
          });
        }
      }

      // 5. Add edges (validated against the post-addNodes/removeNodeIds node set).
      if (input.addEdges !== undefined) {
        if (!Array.isArray(input.addEdges)) {
          throw new OpenChamberControlError('addEdges must be an array', 400);
        }
        for (const rawEntry of input.addEdges) {
          if (!isRecord(rawEntry)) continue;
          const entry = rawEntry as CogMapEdgeAddInput;
          const from = trimmedString(entry.from);
          const to = trimmedString(entry.to);
          if (!from || !to) {
            throw new OpenChamberControlError('Every edge in addEdges requires from and to node IDs', 400);
          }
          if (from === to) {
            throw new OpenChamberControlError(`Self-loop edge on "${from}" is not allowed`, 400);
          }
          if (!existingNodeIds.has(from) || !existingNodeIds.has(to)) {
            throw new OpenChamberControlError(`Edge "${from} -> ${to}" references an unknown node ID`, 400);
          }
          const sign = normalizeSign(entry.sign);
          const label = trimmedString(entry.label).slice(0, MAX_EDGE_LABEL_LENGTH) || undefined;
          const duplicate = edges.find((edge) => edge.from === from && edge.to === to && edge.sign === sign);
          if (duplicate) {
            if (label) duplicate.label = label;
            continue;
          }
          if (edges.length >= MAX_EDGES) {
            throw new OpenChamberControlError(`Map cannot exceed ${MAX_EDGES} edges`, 400);
          }
          const rawId = trimmedString(entry.id);
          const id = rawId && SAFE_ID_RE.test(rawId) && !existingEdgeIds.has(rawId)
            ? rawId
            : nextSequentialId('e', existingEdgeIds);
          const edge: CogMapEdge = {
            id,
            from,
            to,
            sign,
            ...(label ? { label } : {}),
          };
          existingEdgeIds.add(id);
          edges.push(edge);
          addedEdges.push({ id, from, to, sign });
        }
      }

      const rawFocus = input.focusNodeId === null
        ? null
        : trimmedString(input.focusNodeId) || (existing?.focusNodeId ?? null);
      const focusNodeId = rawFocus && existingNodeIds.has(rawFocus)
        ? rawFocus
        : (addedNodes[addedNodes.length - 1]?.id ?? null);

      const nextMap: CognitiveMap = {
        id: mapId,
        sessionId: cleanSessionId,
        title,
        pacing: nextPacing,
        rev: (existing?.rev ?? 0) + 1,
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
        focusNodeId,
        nodes,
        edges,
      };

      const nextState: CogMapSessionState = {
        ...state,
        activeMapId: mapId,
        pacing: nextPacing,
        maps: {
          ...state.maps,
          [mapId]: nextMap,
        },
      };

      cache.set(cleanSessionId, nextState);
      await persistSession(nextState);

      onChanged?.({
        sessionId: cleanSessionId,
        directory: options.directory ?? null,
        map: nextMap,
        author: options.author,
        modeActive: nextState.modeActive,
        pacing: nextState.pacing,
      });

      const summary: CogMapMutationSummary = {
        mapId,
        title,
        pacing: nextPacing,
        rev: nextMap.rev,
        addedNodes,
        updatedNodeIds,
        removedNodeIds,
        addedEdges,
        removedEdgeIds,
        nodeCount: nextMap.nodes.length,
        edgeCount: nextMap.edges.length,
        focusNodeId,
      };

      return { map: nextMap, summary, state: nextState };
    });
  };

  const deleteMap = async (sessionId: string, mapId: string): Promise<CogMapSessionState> => {
    const cleanId = trimmedString(sessionId);
    const cleanMapId = normalizeMapId(mapId);
    return withSessionLock(cleanId, async () => {
      const state = await loadSession(cleanId);
      const nextMaps = { ...state.maps };
      delete nextMaps[cleanMapId];
      const remaining = Object.keys(nextMaps);
      const nextState: CogMapSessionState = {
        ...state,
        activeMapId: state.activeMapId === cleanMapId ? (remaining[0] ?? null) : state.activeMapId,
        maps: nextMaps,
      };
      cache.set(cleanId, nextState);
      await persistSession(nextState);
      return nextState;
    });
  };

  const deleteSession = async (sessionId: string): Promise<void> => {
    const cleanId = trimmedString(sessionId);
    if (!cleanId) return;
    await withSessionLock(cleanId, async () => {
      cache.delete(cleanId);
      await fsPromises.rm(sessionFilePath(cleanId), { force: true }).catch(() => {});
    });
  };

  return {
    getSessionState,
    getMap,
    setMode,
    mutate,
    deleteMap,
    deleteSession,
  };
}
