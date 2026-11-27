export type CogMapNodeRole = 'goal' | 'option' | 'factor' | 'constraint' | 'assumption';

export type CogMapNodeStatus = 'proposed' | 'agreed';

export type CogMapAuthor = 'agent' | 'user';

export type CogMapEdgeSign = '+' | '-' | '?';

export type CogMapPacing = 'auto' | 'collab';

export interface CogMapNode {
  id: string;
  label: string;
  pole?: string;
  role: CogMapNodeRole;
  note?: string;
  cluster?: string;
  author: CogMapAuthor;
  status: CogMapNodeStatus;
}

export interface CogMapEdge {
  id: string;
  from: string;
  to: string;
  sign: CogMapEdgeSign;
  label?: string;
}

export interface CognitiveMap {
  id: string;
  sessionId: string;
  title: string;
  pacing: CogMapPacing;
  rev: number;
  createdAt: number;
  updatedAt: number;
  focusNodeId: string | null;
  nodes: CogMapNode[];
  edges: CogMapEdge[];
}

export interface CogMapSessionState {
  sessionId: string;
  modeActive: boolean;
  pacing: CogMapPacing;
  activeMapId: string | null;
  maps: Record<string, CognitiveMap>;
}

export interface CogMapNodeAddInput {
  id?: unknown;
  label?: unknown;
  pole?: unknown;
  role?: unknown;
  note?: unknown;
  cluster?: unknown;
  status?: unknown;
}

export interface CogMapNodeUpdateInput {
  id?: unknown;
  label?: unknown;
  pole?: unknown;
  role?: unknown;
  note?: unknown;
  cluster?: unknown;
  status?: unknown;
}

export interface CogMapEdgeAddInput {
  id?: unknown;
  from?: unknown;
  to?: unknown;
  sign?: unknown;
  label?: unknown;
}

export interface CogMapMutationInput {
  mapId?: unknown;
  title?: unknown;
  pacing?: unknown;
  focusNodeId?: unknown;
  addNodes?: unknown;
  updateNodes?: unknown;
  removeNodeIds?: unknown;
  addEdges?: unknown;
  removeEdgeIds?: unknown;
}

export interface CogMapMutationSummary {
  mapId: string;
  title: string;
  pacing: CogMapPacing;
  rev: number;
  addedNodes: Array<{ id: string; label: string; role: CogMapNodeRole }>;
  updatedNodeIds: string[];
  removedNodeIds: string[];
  addedEdges: Array<{ id: string; from: string; to: string; sign: CogMapEdgeSign }>;
  removedEdgeIds: string[];
  nodeCount: number;
  edgeCount: number;
  focusNodeId: string | null;
}

export interface CogMapHubMetric {
  id: string;
  label: string;
  role: CogMapNodeRole;
  inDegree: number;
  outDegree: number;
  totalDegree: number;
}

export interface CogMapLoop {
  nodes: string[];
  labels: string[];
  edges: string[];
  polarity: 'reinforcing' | 'balancing' | 'uncertain';
}

export interface CogMapAnalysis {
  mapId: string;
  rev: number;
  heads: Array<{ id: string; label: string; role: CogMapNodeRole }>;
  tails: Array<{ id: string; label: string; role: CogMapNodeRole }>;
  hubs: CogMapHubMetric[];
  loops: CogMapLoop[];
  stats: {
    nodeCount: number;
    edgeCount: number;
    headCount: number;
    tailCount: number;
    loopCount: number;
    proposedCount: number;
  };
}

export interface CogMapChangeEvent {
  sessionId: string;
  directory: string | null;
  map: CognitiveMap;
  author: CogMapAuthor;
  modeActive: boolean;
  pacing: CogMapPacing;
}

export interface CogMapOpenEvent {
  sessionId: string;
  directory: string | null;
  mapId: string;
  focusNodeId: string | null;
}
