import type {
  CogMapAnalysis,
  CogMapAuthor,
  CogMapEdge,
  CogMapEdgeSign,
  CogMapHubMetric,
  CogMapLoop,
  CogMapNode,
  CogMapNodeRole,
  CogMapNodeStatus,
  CognitiveMap,
} from './types';

const VALID_ROLES = new Set<CogMapNodeRole>(['goal', 'option', 'factor', 'constraint', 'assumption']);
const MAX_CYCLE_LENGTH = 8;
const MAX_CYCLES = 16;

function formatEdgeArrow(edge: CogMapEdge): string {
  const arrow = edge.sign === '-' ? '->' : edge.sign === '?' ? '?>' : '+>';
  return edge.label ? `${edge.from} ${arrow} ${edge.to} (${edge.label})` : `${edge.from} ${arrow} ${edge.to}`;
}

function formatNodeLine(node: CogMapNode): string {
  const tags: string[] = [node.role];
  if (node.status === 'proposed') tags.push('proposed');
  if (node.author === 'user') tags.push('user');
  if (node.cluster) tags.push(`@${node.cluster}`);
  const phrase = node.pole ? `${node.label} ... ${node.pole}` : node.label;
  return `${node.id}: ${phrase} [${tags.join(',')}]`;
}

export function serializeCogMapDsl(map: Pick<CognitiveMap, 'id' | 'rev' | 'pacing' | 'title' | 'nodes' | 'edges'>): string {
  const lines: string[] = [
    `# map:${map.id} rev:${map.rev} pacing:${map.pacing} "${map.title.replaceAll('"', "'")}"`,
  ];
  for (const node of map.nodes) lines.push(formatNodeLine(node));
  for (let i = 0; i < map.edges.length; i += 4) {
    lines.push(map.edges.slice(i, i + 4).map(formatEdgeArrow).join(' | '));
  }
  return lines.join('\n');
}

export function parseCogMapDsl(dsl: string): { title?: string; nodes: CogMapNode[]; edges: CogMapEdge[] } {
  const nodes: CogMapNode[] = [];
  const edges: CogMapEdge[] = [];
  const seenNodes = new Set<string>();
  let title: string | undefined;
  let edgeSeq = 1;

  for (const rawLine of dsl.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('#')) {
      const titleMatch = /"([^"]+)"/.exec(line);
      if (titleMatch?.[1] && !title) title = titleMatch[1];
      continue;
    }

    if (/(?:\+>|->|\?>)/.test(line) && !/^[a-zA-Z0-9_-]+:\s/.test(line)) {
      for (const segment of line.split('|').map((entry) => entry.trim()).filter(Boolean)) {
        const match = /^([a-zA-Z0-9_-]+)\s*(\+>|->|\?>)\s*([a-zA-Z0-9_-]+)(?:\s*\(([^)]+)\))?$/.exec(segment);
        if (!match) continue;
        const [, from, op, to, rawLabel] = match;
        const sign: CogMapEdgeSign = op === '->' ? '-' : op === '?>' ? '?' : '+';
        edges.push({
          id: `e${edgeSeq}`,
          from,
          to,
          sign,
          ...(rawLabel?.trim() ? { label: rawLabel.trim() } : {}),
        });
        edgeSeq += 1;
      }
      continue;
    }

    const nodeMatch = /^([a-zA-Z0-9_-]+):\s*(.+)$/.exec(line);
    if (!nodeMatch) continue;
    const id = nodeMatch[1];
    let rest = nodeMatch[2];
    if (seenNodes.has(id)) continue;

    let note: string | undefined;
    const noteIdx = rest.indexOf(' // ');
    if (noteIdx !== -1) {
      note = rest.slice(noteIdx + 4).trim() || undefined;
      rest = rest.slice(0, noteIdx).trim();
    }

    let role: CogMapNodeRole = 'factor';
    let status: CogMapNodeStatus = 'agreed';
    let author: CogMapAuthor = 'agent';
    let cluster: string | undefined;

    const tagMatch = /\s*\[([^\]]+)\]\s*$/.exec(rest);
    if (tagMatch) {
      rest = rest.slice(0, tagMatch.index).trim();
      for (const tag of tagMatch[1].split(',').map((entry) => entry.trim()).filter(Boolean)) {
        if (VALID_ROLES.has(tag as CogMapNodeRole)) role = tag as CogMapNodeRole;
        else if (tag === 'proposed' || tag === 'agreed') status = tag;
        else if (tag === 'user' || tag === 'agent') author = tag;
        else if (tag.startsWith('@') && tag.length > 1) cluster = tag.slice(1);
      }
    }

    let label = rest.trim();
    let pole: string | undefined;
    const poleMatch = /^(.+?)\s*(?:\.\.\.|…)\s*(.+)$/.exec(rest);
    if (poleMatch) {
      label = poleMatch[1].trim();
      pole = poleMatch[2].trim();
    }
    if (!label) continue;

    seenNodes.add(id);
    nodes.push({
      id,
      label,
      ...(pole ? { pole } : {}),
      role,
      ...(note ? { note } : {}),
      ...(cluster ? { cluster } : {}),
      author,
      status,
    });
  }

  return { title, nodes, edges };
}

export function formatCogMapDeltaDsl(before: CognitiveMap | null, after: CognitiveMap): string {
  const beforeNodes = new Map((before?.nodes ?? []).map((node) => [node.id, node]));
  const afterNodes = new Map(after.nodes.map((node) => [node.id, node]));
  const beforeEdges = new Map((before?.edges ?? []).map((edge) => [edge.id, edge]));
  const afterEdges = new Map(after.edges.map((edge) => [edge.id, edge]));

  const lines: string[] = [];
  for (const node of after.nodes) {
    const prev = beforeNodes.get(node.id);
    if (!prev) {
      lines.push(`+ ${formatNodeLine(node)}`);
    } else if (
      prev.label !== node.label
      || prev.pole !== node.pole
      || prev.role !== node.role
      || prev.status !== node.status
      || prev.note !== node.note
      || prev.cluster !== node.cluster
    ) {
      lines.push(`~ ${formatNodeLine(node)}`);
    }
  }
  for (const prev of before?.nodes ?? []) {
    if (!afterNodes.has(prev.id)) lines.push(`- ${prev.id}`);
  }
  for (const edge of after.edges) {
    if (!beforeEdges.has(edge.id)) lines.push(`+ ${formatEdgeArrow(edge)}`);
  }
  for (const prev of before?.edges ?? []) {
    if (!afterEdges.has(prev.id)) lines.push(`- ${formatEdgeArrow(prev)}`);
  }

  if (lines.length === 0) return '';
  return `<cogmap-user-delta mapId="${after.id}" fromRev="${before?.rev ?? 0}" toRev="${after.rev}">\n${lines.join('\n')}\n</cogmap-user-delta>`;
}

export function analyzeCogMapGraph(nodes: readonly CogMapNode[], edges: readonly CogMapEdge[]): CogMapAnalysis {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const inCount = new Map<string, number>();
  const outCount = new Map<string, number>();
  const outgoing = new Map<string, CogMapEdge[]>();

  for (const node of nodes) {
    inCount.set(node.id, 0);
    outCount.set(node.id, 0);
    outgoing.set(node.id, []);
  }

  for (const edge of edges) {
    if (!nodeById.has(edge.from) || !nodeById.has(edge.to)) continue;
    outCount.set(edge.from, (outCount.get(edge.from) ?? 0) + 1);
    inCount.set(edge.to, (inCount.get(edge.to) ?? 0) + 1);
    outgoing.get(edge.from)?.push(edge);
  }

  const heads: CogMapAnalysis['heads'] = [];
  const tails: CogMapAnalysis['tails'] = [];
  const hubs: CogMapHubMetric[] = [];

  for (const node of nodes) {
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
      hubs.push({ id: node.id, label: node.label, role: node.role, inDegree, outDegree, totalDegree });
    }
  }

  hubs.sort((a, b) => b.totalDegree - a.totalDegree || b.outDegree - a.outDegree || a.id.localeCompare(b.id));

  const loops: CogMapLoop[] = [];
  const seenKeys = new Set<string>();
  const orderedIds = nodes.map((node) => node.id).sort();

  for (const startId of orderedIds) {
    if (loops.length >= MAX_CYCLES) break;
    const stackNodes: string[] = [startId];
    const stackEdges: CogMapEdge[] = [];
    const onStack = new Set<string>([startId]);

    const dfs = (currentId: string) => {
      if (loops.length >= MAX_CYCLES) return;
      for (const edge of outgoing.get(currentId) ?? []) {
        const nextId = edge.to;
        if (nextId < startId) continue;
        if (nextId === startId && stackNodes.length >= 2) {
          const cycleEdges = [...stackEdges, edge];
          const key = stackNodes.join('->');
          if (!seenKeys.has(key)) {
            seenKeys.add(key);
            const hasUncertain = cycleEdges.some((item) => item.sign === '?');
            const negCount = cycleEdges.filter((item) => item.sign === '-').length;
            loops.push({
              nodes: [...stackNodes],
              labels: stackNodes.map((id) => nodeById.get(id)?.label ?? id),
              edges: cycleEdges.map((item) => item.id),
              polarity: hasUncertain ? 'uncertain' : negCount % 2 === 0 ? 'reinforcing' : 'balancing',
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
    heads,
    tails,
    hubs: hubs.slice(0, 8),
    loops,
    stats: {
      nodeCount: nodes.length,
      edgeCount: edges.length,
      headCount: heads.length,
      tailCount: tails.length,
      loopCount: loops.length,
      proposedCount: nodes.filter((node) => node.status === 'proposed').length,
    },
  };
}

/**
 * Traces all upstream causes (ancestors) and downstream ends (descendants) of a
 * focused node for zero-token interactive causal path exploration.
 */
export function computeCausalCone(
  nodes: readonly CogMapNode[],
  edges: readonly CogMapEdge[],
  focusNodeId: string | null,
): {
  upstreamNodes: ReadonlySet<string>;
  downstreamNodes: ReadonlySet<string>;
  upstreamEdges: ReadonlySet<string>;
  downstreamEdges: ReadonlySet<string>;
} {
  const upstreamNodes = new Set<string>();
  const downstreamNodes = new Set<string>();
  const upstreamEdges = new Set<string>();
  const downstreamEdges = new Set<string>();

  if (!focusNodeId || !nodes.some((node) => node.id === focusNodeId)) {
    return { upstreamNodes, downstreamNodes, upstreamEdges, downstreamEdges };
  }

  const incoming = new Map<string, CogMapEdge[]>();
  const outgoing = new Map<string, CogMapEdge[]>();
  for (const edge of edges) {
    const inList = incoming.get(edge.to) ?? [];
    inList.push(edge);
    incoming.set(edge.to, inList);
    const outList = outgoing.get(edge.from) ?? [];
    outList.push(edge);
    outgoing.set(edge.from, outList);
  }

  const upQueue = [focusNodeId];
  const upVisited = new Set<string>([focusNodeId]);
  while (upQueue.length > 0) {
    const cur = upQueue.shift();
    if (!cur) continue;
    for (const edge of incoming.get(cur) ?? []) {
      upstreamEdges.add(edge.id);
      if (!upVisited.has(edge.from)) {
        upVisited.add(edge.from);
        upstreamNodes.add(edge.from);
        upQueue.push(edge.from);
      }
    }
  }

  const downQueue = [focusNodeId];
  const downVisited = new Set<string>([focusNodeId]);
  while (downQueue.length > 0) {
    const cur = downQueue.shift();
    if (!cur) continue;
    for (const edge of outgoing.get(cur) ?? []) {
      downstreamEdges.add(edge.id);
      if (!downVisited.has(edge.to)) {
        downVisited.add(edge.to);
        downstreamNodes.add(edge.to);
        downQueue.push(edge.to);
      }
    }
  }

  return { upstreamNodes, downstreamNodes, upstreamEdges, downstreamEdges };
}
