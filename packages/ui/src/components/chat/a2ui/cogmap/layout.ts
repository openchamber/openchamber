import type { CogMapDirection, CogMapEdge, CogMapNode } from './types';

export interface PositionedNode {
  node: CogMapNode;
  x: number;
  y: number;
  width: number;
  height: number;
  layer: number;
}

export interface PositionedEdge {
  edge: CogMapEdge;
  path: string;
  midX: number;
  midY: number;
  isFeedback: boolean;
}

export interface CogMapLayoutResult {
  nodes: PositionedNode[];
  edges: PositionedEdge[];
  width: number;
  height: number;
}

const NODE_WIDTH = 224;
const BASE_NODE_HEIGHT = 64;
const POLE_EXTRA_HEIGHT = 20;
const H_GAP = 44;
const V_GAP = 64;
const PADDING = 40;

function estimateNodeHeight(node: CogMapNode): number {
  const labelLines = Math.max(1, Math.ceil(node.label.length / 26));
  const poleLines = node.pole ? Math.max(1, Math.ceil(node.pole.length / 28)) : 0;
  return BASE_NODE_HEIGHT + Math.max(0, labelLines - 1) * 16 + (poleLines > 0 ? POLE_EXTRA_HEIGHT + (poleLines - 1) * 14 : 0);
}

/**
 * Deterministic Eden & Ackermann layered DAG layout (zero external dependencies):
 * - Breaks cycles via DFS back-edge detection so feedback loops render as smooth outer arcs
 *   without tangling the means-ends hierarchy.
 * - Ranks nodes bottom-to-top (`direction: 'up'`) so Actions/Tails sit at the bottom and
 *   Goals/Heads sit at the top (or flipped for `direction: 'down'`).
 * - Minimizes edge crossings with 4 barycenter sweeps before assigning balanced coordinates.
 */
export function computeCogMapLayout(
  nodes: readonly CogMapNode[],
  edges: readonly CogMapEdge[],
  direction: CogMapDirection = 'up',
): CogMapLayoutResult {
  if (nodes.length === 0) {
    return { nodes: [], edges: [], width: 480, height: 240 };
  }

  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const validEdges = edges.filter((edge) => edge.from !== edge.to && nodeById.has(edge.from) && nodeById.has(edge.to));

  // 1. Identify cycle back-edges via deterministic DFS so the remaining graph is a strict DAG.
  const outgoingAll = new Map<string, CogMapEdge[]>();
  for (const node of nodes) outgoingAll.set(node.id, []);
  for (const edge of validEdges) outgoingAll.get(edge.from)?.push(edge);

  const backEdges = new Set<string>();
  const color = new Map<string, 0 | 1 | 2>(); // 0=unvisited, 1=visiting, 2=done

  const markBackEdges = (id: string) => {
    color.set(id, 1);
    for (const edge of outgoingAll.get(id) ?? []) {
      const targetColor = color.get(edge.to) ?? 0;
      if (targetColor === 1) {
        backEdges.add(edge.id);
      } else if (targetColor === 0) {
        markBackEdges(edge.to);
      }
    }
    color.set(id, 2);
  };

  // Start DFS from tails (in-degree 0) first so natural causal chains stay forward.
  const inDegAll = new Map<string, number>();
  for (const node of nodes) inDegAll.set(node.id, 0);
  for (const edge of validEdges) inDegAll.set(edge.to, (inDegAll.get(edge.to) ?? 0) + 1);

  const dfsOrder = [...nodes].sort((a, b) => (inDegAll.get(a.id) ?? 0) - (inDegAll.get(b.id) ?? 0) || a.id.localeCompare(b.id));
  for (const node of dfsOrder) {
    if ((color.get(node.id) ?? 0) === 0) markBackEdges(node.id);
  }

  const dagEdges = validEdges.filter((edge) => !backEdges.has(edge.id));
  const dagOut = new Map<string, string[]>();
  const dagIn = new Map<string, string[]>();
  for (const node of nodes) {
    dagOut.set(node.id, []);
    dagIn.set(node.id, []);
  }
  for (const edge of dagEdges) {
    dagOut.get(edge.from)?.push(edge.to);
    dagIn.get(edge.to)?.push(edge.from);
  }

  // 2. Longest-path layering from tails (layer 0 = causes/options, max layer = goals/heads).
  const inRemaining = new Map<string, number>();
  const layerById = new Map<string, number>();
  const queue: string[] = [];

  for (const node of nodes) {
    const deg = dagIn.get(node.id)?.length ?? 0;
    inRemaining.set(node.id, deg);
    if (deg === 0) {
      layerById.set(node.id, 0);
      queue.push(node.id);
    }
  }

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;
    const currentLayer = layerById.get(current) ?? 0;
    for (const next of dagOut.get(current) ?? []) {
      layerById.set(next, Math.max(layerById.get(next) ?? 0, currentLayer + 1));
      const rem = (inRemaining.get(next) ?? 1) - 1;
      inRemaining.set(next, rem);
      if (rem === 0) queue.push(next);
    }
  }

  let maxLayer = 0;
  for (const node of nodes) {
    const layer = layerById.get(node.id) ?? 0;
    if (layer > maxLayer) maxLayer = layer;
  }

  // Gently align isolated goals toward the top layer so unlinked goals still sit at the means-ends head.
  for (const node of nodes) {
    const outLen = dagOut.get(node.id)?.length ?? 0;
    const inLen = dagIn.get(node.id)?.length ?? 0;
    if (outLen === 0 && node.role === 'goal' && maxLayer > 0) {
      layerById.set(node.id, maxLayer);
    } else if (inLen === 0 && outLen === 0 && node.role === 'option') {
      layerById.set(node.id, 0);
    }
  }

  // 3. Group nodes into visual rows (visualRow 0 = top of viewport).
  const rowCount = maxLayer + 1;
  const rows: string[][] = Array.from({ length: rowCount }, () => []);
  for (const node of nodes) {
    const logicalLayer = layerById.get(node.id) ?? 0;
    const visualRow = direction === 'up' ? maxLayer - logicalLayer : logicalLayer;
    rows[visualRow]?.push(node.id);
  }

  // Initial deterministic sort within each row by role then id.
  for (const row of rows) {
    row.sort((a, b) => a.localeCompare(b));
  }

  // 4. Barycenter crossing minimization (4 alternating sweeps).
  const positionInRow = new Map<string, number>();
  const indexRows = () => {
    for (const row of rows) {
      row.forEach((id, idx) => positionInRow.set(id, idx));
    }
  };
  indexRows();

  const sortRowByNeighbors = (rowIndex: number, neighborLookup: Map<string, string[]>) => {
    const row = rows[rowIndex];
    if (!row || row.length <= 1) return;
    const score = new Map<string, number>();
    row.forEach((id, idx) => {
      const neighbors = (neighborLookup.get(id) ?? []).filter((n) => positionInRow.has(n));
      if (neighbors.length === 0) {
        score.set(id, idx);
      } else {
        const avg = neighbors.reduce((sum, n) => sum + (positionInRow.get(n) ?? idx), 0) / neighbors.length;
        score.set(id, avg);
      }
    });
    row.sort((a, b) => (score.get(a) ?? 0) - (score.get(b) ?? 0) || a.localeCompare(b));
    indexRows();
  };

  for (let pass = 0; pass < 2; pass += 1) {
    for (let r = 1; r < rows.length; r += 1) {
      sortRowByNeighbors(r, direction === 'up' ? dagOut : dagIn);
    }
    for (let r = rows.length - 2; r >= 0; r -= 1) {
      sortRowByNeighbors(r, direction === 'up' ? dagIn : dagOut);
    }
  }

  // 5. Assign balanced X/Y coordinates centered across the widest row.
  const heightById = new Map(nodes.map((node) => [node.id, estimateNodeHeight(node)]));
  const rowWidths = rows.map((row) => (row.length === 0 ? 0 : row.length * NODE_WIDTH + (row.length - 1) * H_GAP));
  const maxRowWidth = Math.max(NODE_WIDTH, ...rowWidths);
  const canvasWidth = maxRowWidth + PADDING * 2;

  const positionedById = new Map<string, PositionedNode>();
  const positionedNodes: PositionedNode[] = [];
  let cursorY = PADDING;

  rows.forEach((row, rowIndex) => {
    if (row.length === 0) return;
    const rowWidth = rowWidths[rowIndex] ?? 0;
    const startX = PADDING + (maxRowWidth - rowWidth) / 2;
    const rowMaxHeight = Math.max(...row.map((id) => heightById.get(id) ?? BASE_NODE_HEIGHT));

    row.forEach((id, colIndex) => {
      const node = nodeById.get(id);
      if (!node) return;
      const height = heightById.get(id) ?? BASE_NODE_HEIGHT;
      const item: PositionedNode = {
        node,
        x: Math.round(startX + colIndex * (NODE_WIDTH + H_GAP)),
        y: Math.round(cursorY + (rowMaxHeight - height) / 2),
        width: NODE_WIDTH,
        height,
        layer: layerById.get(id) ?? 0,
      };
      positionedById.set(id, item);
      positionedNodes.push(item);
    });

    cursorY += rowMaxHeight + V_GAP;
  });

  const canvasHeight = Math.max(240, cursorY - V_GAP + PADDING);

  // 6. Route SVG Bezier edges (with smooth side arcs for feedback loops or same-row links).
  const positionedEdges: PositionedEdge[] = [];
  let feedbackLane = 0;

  for (const edge of validEdges) {
    const src = positionedById.get(edge.from);
    const dst = positionedById.get(edge.to);
    if (!src || !dst) continue;

    const isFeedback = backEdges.has(edge.id);
    const srcCx = src.x + src.width / 2;
    const dstCx = dst.x + dst.width / 2;
    const srcCy = src.y + src.height / 2;
    const dstCy = dst.y + dst.height / 2;

    if (isFeedback) {
      // Route feedback loop arcs gracefully outside the side of the pair so loops stand out visually.
      const side = feedbackLane % 2 === 0 ? 1 : -1;
      feedbackLane += 1;
      const offset = 52 + Math.floor(feedbackLane / 2) * 26;
      const startX = side > 0 ? src.x + src.width : src.x;
      const endX = side > 0 ? dst.x + dst.width : dst.x;
      const controlX = (side > 0 ? Math.max(startX, endX) : Math.min(startX, endX)) + side * offset;
      const path = `M ${startX} ${srcCy} C ${controlX} ${srcCy}, ${controlX} ${dstCy}, ${endX} ${dstCy}`;
      const midX = 0.125 * startX + 0.75 * controlX + 0.125 * endX;
      const midY = (srcCy + dstCy) / 2;
      positionedEdges.push({ edge, path, midX, midY, isFeedback: true });
      continue;
    }

    if (Math.abs(srcCy - dstCy) < 12) {
      // Same-row horizontal arc slightly bowed upward.
      const goingRight = dstCx >= srcCx;
      const startX = goingRight ? src.x + src.width : src.x;
      const endX = goingRight ? dst.x : dst.x + dst.width;
      const midX = (startX + endX) / 2;
      const ctrlY = Math.min(src.y, dst.y) - 24;
      const path = `M ${startX} ${srcCy} Q ${midX} ${ctrlY}, ${endX} ${dstCy}`;
      positionedEdges.push({ edge, path, midX, midY: (srcCy + ctrlY) / 2, isFeedback: false });
      continue;
    }

    // Standard layered means-ends vertical Bezier curve.
    const goingUp = dstCy < srcCy;
    const startY = goingUp ? src.y : src.y + src.height;
    const endY = goingUp ? dst.y + dst.height : dst.y;
    const dy = Math.max(32, Math.abs(endY - startY) * 0.48);
    const c1y = goingUp ? startY - dy : startY + dy;
    const c2y = goingUp ? endY + dy : endY - dy;
    const path = `M ${srcCx} ${startY} C ${srcCx} ${c1y}, ${dstCx} ${c2y}, ${dstCx} ${endY}`;
    const midX = (srcCx + dstCx) / 2;
    const midY = (startY + endY) / 2;
    positionedEdges.push({ edge, path, midX, midY, isFeedback: false });
  }

  return {
    nodes: positionedNodes,
    edges: positionedEdges,
    width: canvasWidth + (feedbackLane > 0 ? 64 : 0),
    height: canvasHeight,
  };
}
