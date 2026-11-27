export type CogMapNodeRole = 'goal' | 'option' | 'factor' | 'constraint' | 'assumption';

export type CogMapNodeStatus = 'proposed' | 'agreed';

export type CogMapAuthor = 'agent' | 'user';

export type CogMapEdgeSign = '+' | '-' | '?';

export type CogMapPacing = 'auto' | 'collab';

export type CogMapDirection = 'up' | 'down';

export type CogMapLadderingIntent = 'ladder_up' | 'ladder_down' | 'challenge' | 'loops' | 'explain';

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

export interface CogMapMutationPayload {
  mapId?: string;
  title?: string;
  pacing?: CogMapPacing;
  focusNodeId?: string | null;
  addNodes?: Array<{
    id?: string;
    label: string;
    pole?: string;
    role?: CogMapNodeRole;
    note?: string;
    cluster?: string;
    status?: CogMapNodeStatus;
  }>;
  updateNodes?: Array<{
    id: string;
    label?: string;
    pole?: string;
    role?: CogMapNodeRole;
    note?: string;
    cluster?: string;
    status?: CogMapNodeStatus;
  }>;
  removeNodeIds?: string[];
  addEdges?: Array<{
    id?: string;
    from: string;
    to: string;
    sign?: CogMapEdgeSign;
    label?: string;
  }>;
  removeEdgeIds?: string[];
}
