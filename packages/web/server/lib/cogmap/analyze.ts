import type {
  CogMapAnalysis,
  CogMapEdge,
  CogMapHubMetric,
  CogMapLoop,
  CogMapNode,
  CognitiveMap,
} from './types.js';

const MAX_CYCLE_LENGTH = 8;
const MAX_CYCLES_REPORTED = 16;

/**
 * Deterministic Eden & Ackermann structural analysis (Heads, Tails, Central Hubs,
 * and Reinforcing/Balancing feedback loops) computed server-side so the LLM never
 * spends tokens tracing graph topology manually.
 */
export function analyzeCogMap(map: CognitiveMap): CogMapAnalysis {
  const nodeById = new Map<string, CogMapNode>(map.nodes.map((node) => [node.id, node]));
  const inCount = new Map<string, number>();
  const outCount = new Map<string, number>();
  const outgoing = new Map<string, CogMapEdge[]>();

  for (const node of map.nodes) {
    inCount.set(node.id, 0);
    outCount.set(node.id, 0);
    outgoing.set(node.id, []);
  }

  for (const edge of map.edges) {
    if (!nodeById.has(edge.from) || !nodeById.has(edge.to)) continue;
    outCount.set(edge.from, (outCount.get(edge.from) ?? 0) + 1);
    inCount.set(edge.to, (inCount.get(edge.to) ?? 0) + 1);
    outgoing.get(edge.from)?.push(edge);
  }

  const heads: CogMapAnalysis['heads'] = [];
  const tails: CogMapAnalysis['tails'] = [];
  const hubs: CogMapHubMetric[] = [];

  for (const node of map.nodes) {
    const inDegree = inCount.get(node.id) ?? 0;
    const outDegree = outCount.get(node.id) ?? 0;
    const totalDegree = inDegree + outDegree;

    if ((outDegree === 0 && inDegree > 0) || (node.role === 'goal' && outDegree === 0)) {
      heads.push({ id: node.id, label: node.label, role: node.role });
    }
    if ((inDegree === 0 && outDegree > 0) || (node.role === 'option' && inDegree === 0)) {
      tails.push({ id: node.id, label: node.label, role: node.role });
    }
    if (totalDegree > 0) {
      hubs.push({
        id: node.id,
        label: node.label,
        role: node.role,
        inDegree,
        outDegree,
        totalDegree,
      });
    }
  }

  hubs.sort((a, b) => b.totalDegree - a.totalDegree || b.outDegree - a.outDegree || a.id.localeCompare(b.id));

  // Canonical bounded elementary cycle discovery so each loop is reported once.
  const loops: CogMapLoop[] = [];
  const seenLoopKeys = new Set<string>();
  const orderedIds = map.nodes.map((node) => node.id).sort();

  for (const startId of orderedIds) {
    if (loops.length >= MAX_CYCLES_REPORTED) break;
    const stackNodes: string[] = [startId];
    const stackEdges: CogMapEdge[] = [];
    const onStack = new Set<string>([startId]);

    const dfs = (currentId: string) => {
      if (loops.length >= MAX_CYCLES_REPORTED) return;
      const edges = outgoing.get(currentId) ?? [];
      for (const edge of edges) {
        const nextId = edge.to;
        if (nextId < startId) continue;

        if (nextId === startId && stackNodes.length >= 2) {
          const cycleEdges = [...stackEdges, edge];
          const key = stackNodes.join('->');
          if (!seenLoopKeys.has(key)) {
            seenLoopKeys.add(key);
            const hasUncertain = cycleEdges.some((item) => item.sign === '?');
            const negativeCount = cycleEdges.filter((item) => item.sign === '-').length;
            const polarity: CogMapLoop['polarity'] = hasUncertain
              ? 'uncertain'
              : negativeCount % 2 === 0
                ? 'reinforcing'
                : 'balancing';
            loops.push({
              nodes: [...stackNodes],
              labels: stackNodes.map((id) => nodeById.get(id)?.label ?? id),
              edges: cycleEdges.map((item) => item.id),
              polarity,
            });
          }
          continue;
        }

        if (!onStack.has(nextId) && stackNodes.length < MAX_CYCLE_LENGTH) {
          onStack.add(nextId);
          stackNodes.push(nextId);
          stackEdges.push(edge);
          dfs(nextId);
          stackEdges.pop();
          stackNodes.pop();
          onStack.delete(nextId);
        }
      }
    };

    dfs(startId);
  }

  return {
    mapId: map.id,
    rev: map.rev,
    heads,
    tails,
    hubs: hubs.slice(0, 8),
    loops,
    stats: {
      nodeCount: map.nodes.length,
      edgeCount: map.edges.length,
      headCount: heads.length,
      tailCount: tails.length,
      loopCount: loops.length,
      proposedCount: map.nodes.filter((node) => node.status === 'proposed').length,
    },
  };
}
