import { describe, expect, test } from 'bun:test';
import {
  analyzeCogMapGraph,
  computeCausalCone,
  formatCogMapDeltaDsl,
  parseCogMapDsl,
  serializeCogMapDsl,
} from './graph';
import { computeCogMapLayout } from './layout';
import type { CogMapEdge, CogMapNode, CognitiveMap } from './types';

describe('CognitiveMap graph helpers & deterministic Sugiyama layout', () => {
  const sampleNodes: CogMapNode[] = [
    { id: 'n1', label: 'Protect customer SLA', pole: 'tolerate stockouts', role: 'goal', author: 'agent', status: 'agreed' },
    { id: 'n2', label: 'Faster disruption recovery', role: 'factor', author: 'agent', status: 'agreed' },
    { id: 'n3', label: 'Multi-region dual sourcing', pole: 'single-factory lock-in', role: 'factor', author: 'agent', status: 'agreed' },
    { id: 'n4', label: 'Pre-qualify backup vendors', role: 'option', author: 'user', status: 'agreed' },
  ];

  const sampleEdges: CogMapEdge[] = [
    { id: 'e1', from: 'n4', to: 'n3', sign: '+' },
    { id: 'e2', from: 'n3', to: 'n2', sign: '+' },
    { id: 'e3', from: 'n2', to: 'n1', sign: '+' },
    // Reinforcing feedback loop back from goal n1 to factor n3.
    { id: 'e4', from: 'n1', to: 'n3', sign: '+', label: 'funds capacity' },
  ];

  test('lays out bottom-to-top means-ends hierarchy with options below goals and marks feedback edges', () => {
    const layoutUp = computeCogMapLayout(sampleNodes, sampleEdges, 'up');
    expect(layoutUp.nodes).toHaveLength(4);
    expect(layoutUp.edges).toHaveLength(4);

    const byId = new Map(layoutUp.nodes.map((item) => [item.node.id, item]));
    // In bottom-to-top mode, options/tails sit at larger Y than intermediate factors, which sit below goals.
    expect(byId.get('n4')!.y).toBeGreaterThan(byId.get('n3')!.y);
    expect(byId.get('n3')!.y).toBeGreaterThan(byId.get('n2')!.y);
    expect(byId.get('n2')!.y).toBeGreaterThan(byId.get('n1')!.y);

    // Cycle back-edge is marked as a feedback arc with a valid SVG curve path.
    const feedbackEdges = layoutUp.edges.filter((item) => item.isFeedback);
    expect(feedbackEdges.length).toBeGreaterThanOrEqual(1);
    expect(feedbackEdges[0]?.path.startsWith('M ')).toBe(true);

    // Deterministic output across repeated runs.
    const secondRun = computeCogMapLayout(sampleNodes, sampleEdges, 'up');
    expect(secondRun.nodes.map((item) => ({ id: item.node.id, x: item.x, y: item.y }))).toEqual(
      layoutUp.nodes.map((item) => ({ id: item.node.id, x: item.x, y: item.y })),
    );
  });

  test('supports top-down layout orientation cleanly', () => {
    const layoutDown = computeCogMapLayout(sampleNodes, sampleEdges, 'down');
    const byId = new Map(layoutDown.nodes.map((item) => [item.node.id, item]));
    expect(byId.get('n4')!.y).toBeLessThan(byId.get('n3')!.y);
    expect(byId.get('n3')!.y).toBeLessThan(byId.get('n1')!.y);
  });

  test('analyzes tails, hubs, and reinforcing feedback loops accurately', () => {
    const analysis = analyzeCogMapGraph(sampleNodes, sampleEdges);
    expect(analysis.tails.map((tail) => tail.id)).toEqual(['n4']);
    expect(analysis.hubs[0]?.id).toBe('n3');
    expect(analysis.loops.length).toBe(1);
    expect(analysis.loops[0]?.polarity).toBe('reinforcing');
  });

  test('computes causal cone (upstream causes + downstream ends) from a selected node', () => {
    const cone = computeCausalCone(sampleNodes, sampleEdges, 'n3');
    expect(cone.upstreamNodes.has('n4')).toBe(true);
    expect(cone.downstreamNodes.has('n2')).toBe(true);
    expect(cone.downstreamNodes.has('n1')).toBe(true);
    expect(cone.upstreamEdges.has('e1')).toBe(true);
    expect(cone.downstreamEdges.has('e2')).toBe(true);
  });

  test('roundtrips Mini-DSL and formats minimal user edit deltas', () => {
    const map: CognitiveMap = {
      id: 'm1',
      sessionId: 'ses_1',
      title: 'Supply Chain',
      rev: 2,
      pacing: 'collab',
      focusNodeId: null,
      nodes: sampleNodes,
      edges: sampleEdges,
      createdAt: 1,
      updatedAt: 2,
    };

    const dsl = serializeCogMapDsl(map);
    expect(dsl).toContain('n1: Protect customer SLA ... tolerate stockouts [goal]');
    expect(dsl).toContain('n1 +> n3 (funds capacity)');

    const parsed = parseCogMapDsl(dsl);
    expect(parsed.title).toBe('Supply Chain');
    expect(parsed.nodes).toHaveLength(4);
    expect(parsed.edges).toHaveLength(4);
    expect(parsed.nodes[0]?.pole).toBe('tolerate stockouts');

    const edited: CognitiveMap = {
      ...map,
      rev: 3,
      nodes: [
        ...sampleNodes,
        { id: 'n5', label: 'Regional audit bottleneck', role: 'constraint', author: 'user', status: 'agreed' },
      ],
      edges: [...sampleEdges, { id: 'e5', from: 'n5', to: 'n4', sign: '-' }],
    };

    const delta = formatCogMapDeltaDsl(map, edited);
    expect(delta).toContain('<cogmap-user-delta mapId="m1" fromRev="2" toRev="3">');
    expect(delta).toContain('+ n5: Regional audit bottleneck [constraint,user]');
    expect(delta).toContain('+ n5 -> n4');
  });
});
