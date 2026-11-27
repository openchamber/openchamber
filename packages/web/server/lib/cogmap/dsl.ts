import type {
  CogMapEdge,
  CogMapEdgeSign,
  CogMapNode,
  CogMapNodeRole,
  CogMapNodeStatus,
  CognitiveMap,
} from './types.js';

export interface SerializeDslOptions {
  focusNodeId?: string | null;
  depth?: number;
  includeNotes?: boolean;
}

const VALID_ROLES = new Set<CogMapNodeRole>(['goal', 'option', 'factor', 'constraint', 'assumption']);

function formatEdgeArrow(edge: CogMapEdge): string {
  const arrow = edge.sign === '-' ? '->' : edge.sign === '?' ? '?>' : '+>';
  return edge.label ? `${edge.from} ${arrow} ${edge.to} (${edge.label})` : `${edge.from} ${arrow} ${edge.to}`;
}

function formatNodeLine(node: CogMapNode, includeNotes: boolean): string {
  const tags: string[] = [node.role];
  if (node.status === 'proposed') tags.push('proposed');
  if (node.author === 'user') tags.push('user');
  if (node.cluster) tags.push(`@${node.cluster}`);
  const phrase = node.pole ? `${node.label} ... ${node.pole}` : node.label;
  const base = `${node.id}: ${phrase} [${tags.join(',')}]`;
  if (includeNotes && node.note) {
    const compactNote = node.note.replace(/\s+/g, ' ').trim().slice(0, 240);
    return `${base} // ${compactNote}`;
  }
  return base;
}

/**
 * Selects a bounded causal neighborhood around `focusNodeId` (both upstream causes
 * and downstream ends) so reading a large cognitive map stays within a small token budget.
 */
function collectNeighborhood(
  nodes: readonly CogMapNode[],
  edges: readonly CogMapEdge[],
  focusNodeId: string,
  depth: number,
): { keptNodeIds: Set<string>; omittedCount: number } {
  const nodeMap = new Map(nodes.map((node) => [node.id, node]));
  if (!nodeMap.has(focusNodeId)) {
    return { keptNodeIds: new Set(nodes.map((node) => node.id)), omittedCount: 0 };
  }

  const maxHops = Math.max(1, Math.min(6, Math.floor(depth)));
  const visited = new Set<string>([focusNodeId]);
  let frontier = [focusNodeId];

  for (let hop = 0; hop < maxHops && frontier.length > 0; hop += 1) {
    const nextFrontier: string[] = [];
    for (const current of frontier) {
      for (const edge of edges) {
        if (edge.from === current && !visited.has(edge.to)) {
          visited.add(edge.to);
          nextFrontier.push(edge.to);
        } else if (edge.to === current && !visited.has(edge.from)) {
          visited.add(edge.from);
          nextFrontier.push(edge.from);
        }
      }
    }
    frontier = nextFrontier;
  }

  return {
    keptNodeIds: visited,
    omittedCount: Math.max(0, nodes.length - visited.size),
  };
}

/**
 * Serializes a cognitive map into an ultra-compact plain-text DSL (~65% fewer
 * tokens than JSON) optimized for LLM comprehension and cache efficiency.
 */
export function serializeCogMapDsl(map: CognitiveMap, options: SerializeDslOptions = {}): string {
  const includeNotes = options.includeNotes === true;
  const focus = options.focusNodeId?.trim() || null;

  let nodesToShow = map.nodes;
  let edgesToShow = map.edges;
  let omittedCount = 0;

  if (focus && options.depth !== undefined) {
    const { keptNodeIds, omittedCount: omitted } = collectNeighborhood(map.nodes, map.edges, focus, options.depth);
    nodesToShow = map.nodes.filter((node) => keptNodeIds.has(node.id));
    edgesToShow = map.edges.filter((edge) => keptNodeIds.has(edge.from) && keptNodeIds.has(edge.to));
    omittedCount = omitted;
  }

  const lines: string[] = [
    `# map:${map.id} rev:${map.rev} pacing:${map.pacing} "${map.title.replaceAll('"', "'")}"`,
  ];

  if (nodesToShow.length === 0) {
    lines.push('(empty map)');
    return lines.join('\n');
  }

  for (const node of nodesToShow) {
    lines.push(formatNodeLine(node, includeNotes));
  }

  if (edgesToShow.length > 0) {
    // Pack edges on compact pipe-delimited lines (4 per line) to save newline/prefix tokens.
    const chunkSize = 4;
    for (let i = 0; i < edgesToShow.length; i += chunkSize) {
      lines.push(edgesToShow.slice(i, i + chunkSize).map(formatEdgeArrow).join(' | '));
    }
  }

  if (omittedCount > 0 && focus) {
    lines.push(`# +${omittedCount} nodes outside depth ${options.depth} of ${focus}`);
  }

  return lines.join('\n');
}

/**
 * Parses compact Cognitive Map Mini-DSL back into structured nodes and edges.
 * Used both for tests and standalone A2UI DSL snapshots.
 */
export function parseCogMapDsl(dsl: string): {
  title?: string;
  nodes: CogMapNode[];
  edges: CogMapEdge[];
} {
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

    // Edge line: "n1 +> n2 | n3 -> n1 (label)"
    if (/(?:\+>|->|\?>)/.test(line) && !/^[a-zA-Z0-9_-]+:\s/.test(line)) {
      const segments = line.split('|').map((segment) => segment.trim()).filter(Boolean);
      for (const segment of segments) {
        const match = /^([a-zA-Z0-9_-]+)\s*(\+>|->|\?>)\s*([a-zA-Z0-9_-]+)(?:\s*\(([^)]+)\))?$/.exec(segment);
        if (!match) continue;
        const from = match[1];
        const op = match[2];
        const to = match[3];
        const label = match[4]?.trim();
        if (!from || !to) continue;
        const sign: CogMapEdgeSign = op === '->' ? '-' : op === '?>' ? '?' : '+';
        edges.push({
          id: `e${edgeSeq}`,
          from,
          to,
          sign,
          ...(label ? { label } : {}),
        });
        edgeSeq += 1;
      }
      continue;
    }

    // Node line: "n1: Short lead times ... long wait times [goal,proposed] // optional note"
    const nodeMatch = /^([a-zA-Z0-9_-]+):\s*(.+)$/.exec(line);
    if (!nodeMatch) continue;
    const id = nodeMatch[1];
    let rest = nodeMatch[2] ?? '';
    if (!id || seenNodes.has(id)) continue;

    let note: string | undefined;
    const noteIdx = rest.indexOf(' // ');
    if (noteIdx !== -1) {
      note = rest.slice(noteIdx + 4).trim() || undefined;
      rest = rest.slice(0, noteIdx).trim();
    }

    let role: CogMapNodeRole = 'factor';
    let status: CogMapNodeStatus = 'agreed';
    let author: 'agent' | 'user' = 'agent';
    let cluster: string | undefined;

    const tagMatch = /\s*\[([^\]]+)\]\s*$/.exec(rest);
    if (tagMatch?.[1]) {
      rest = rest.slice(0, tagMatch.index).trim();
      for (const rawTag of tagMatch[1].split(',').map((entry) => entry.trim()).filter(Boolean)) {
        if (VALID_ROLES.has(rawTag as CogMapNodeRole)) {
          role = rawTag as CogMapNodeRole;
        } else if (rawTag === 'proposed' || rawTag === 'agreed') {
          status = rawTag;
        } else if (rawTag === 'user' || rawTag === 'agent') {
          author = rawTag;
        } else if (rawTag.startsWith('@') && rawTag.length > 1) {
          cluster = rawTag.slice(1);
        }
      }
    }

    let label = rest.trim();
    let pole: string | undefined;
    const poleMatch = /^(.+?)\s*(?:\.\.\.|…)\s*(.+)$/.exec(rest);
    if (poleMatch?.[1] && poleMatch[2]) {
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

  return { ...(title !== undefined ? { title } : {}), nodes, edges };
}

/**
 * Formats only the difference between two map revisions so user canvas edits
 * reach the agent as a minimal delta instead of re-sending the entire graph.
 */
export function formatCogMapDeltaDsl(before: CognitiveMap | null, after: CognitiveMap): string {
  const beforeNodes = new Map((before?.nodes ?? []).map((node) => [node.id, node]));
  const afterNodes = new Map(after.nodes.map((node) => [node.id, node]));
  const beforeEdges = new Map((before?.edges ?? []).map((edge) => [edge.id, edge]));
  const afterEdges = new Map(after.edges.map((edge) => [edge.id, edge]));

  const lines: string[] = [];

  for (const node of after.nodes) {
    const prev = beforeNodes.get(node.id);
    if (!prev) {
      lines.push(`+ ${formatNodeLine(node, false)}`);
    } else if (
      prev.label !== node.label
      || prev.pole !== node.pole
      || prev.role !== node.role
      || prev.status !== node.status
      || prev.note !== node.note
      || prev.cluster !== node.cluster
    ) {
      lines.push(`~ ${formatNodeLine(node, false)}`);
    }
  }

  for (const prev of before?.nodes ?? []) {
    if (!afterNodes.has(prev.id)) {
      lines.push(`- ${prev.id}`);
    }
  }

  for (const edge of after.edges) {
    if (!beforeEdges.has(edge.id)) {
      lines.push(`+ ${formatEdgeArrow(edge)}`);
    }
  }

  for (const prev of before?.edges ?? []) {
    if (!afterEdges.has(prev.id)) {
      lines.push(`- ${formatEdgeArrow(prev)}`);
    }
  }

  if (lines.length === 0) return '';
  return `<cogmap-user-delta mapId="${after.id}" fromRev="${before?.rev ?? 0}" toRev="${after.rev}">\n${lines.join('\n')}\n</cogmap-user-delta>`;
}
