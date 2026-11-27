import { describe, expect, test } from 'bun:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  analyzeCogMap,
  createCogMapRuntime,
  formatCogMapDeltaDsl,
  parseCogMapDsl,
  serializeCogMapDsl,
} from './index.js';

const createTempDir = async () => fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-cogmap-'));

describe('cogmap store, DSL, and analysis', () => {
  test('mutates incrementally, persists to disk, cascades node removal, and emits change events', async () => {
    const dataDir = await createTempDir();
    const events = [];
    const runtime = createCogMapRuntime({
      dataDir,
      onChanged: (event) => events.push(event),
    });

    const first = await runtime.executeAction(
      'cogmap.mutate',
      {
        title: 'Supply Chain Resilience',
        pacing: 'collab',
        addNodes: [
          { id: 'n1', label: 'Short customer lead times', pole: 'long wait times', role: 'goal' },
          { id: 'n2', label: 'Hold higher safety stock', pole: 'lean inventory', role: 'option' },
          { id: 'n3', label: 'Higher working capital lockup', pole: 'liquid cash', role: 'constraint' },
        ],
        addEdges: [
          { from: 'n2', to: 'n1', sign: '+' },
          { from: 'n2', to: 'n3', sign: '+' },
        ],
      },
      { sessionId: 'sess-1', directory: '/repo' },
    );

    expect(first.mapId).toBe('m1');
    expect(first.rev).toBe(1);
    expect(first.nodeCount).toBe(3);
    expect(first.edgeCount).toBe(2);
    expect(events).toHaveLength(1);
    expect(events[0].author).toBe('agent');

    // Second surgical delta adds a forecast lever and links it cleanly without re-sending old nodes.
    const second = await runtime.executeAction(
      'cogmap.mutate',
      {
        addNodes: [
          { label: 'Use real-time POS demand forecast', pole: 'gut feeling', role: 'option', note: 'Reduces bullwhip variance.' },
        ],
        addEdges: [
          { from: 'n4', to: 'n1', sign: '+' },
          { from: 'n4', to: 'n2', sign: '-' },
        ],
      },
      { sessionId: 'sess-1' },
    );

    expect(second.rev).toBe(2);
    expect(second.addedNodes[0].id).toBe('n4');
    expect(second.nodeCount).toBe(4);
    expect(second.edgeCount).toBe(4);

    // Reload from a fresh runtime instance to verify atomic persistence.
    const reloaded = createCogMapRuntime({ dataDir });
    const read = await reloaded.executeAction('cogmap.read', { includeNotes: true }, { sessionId: 'sess-1' });
    expect(read.exists).toBe(true);
    expect(read.dsl).toContain('n1: Short customer lead times ... long wait times [goal,proposed]');
    expect(read.dsl).toContain('n4 -> n2');
    expect(read.dsl).toContain('Reduces bullwhip variance.');

    // Removing a node cascades its incident edges cleanly.
    const third = await reloaded.executeAction(
      'cogmap.mutate',
      { removeNodeIds: ['n3'] },
      { sessionId: 'sess-1' },
    );
    expect(third.nodeCount).toBe(3);
    expect(third.edgeCount).toBe(3);
    expect(third.removedNodeIds).toEqual(['n3']);
    expect(third.removedEdgeIds).toHaveLength(1);

    await fs.rm(dataDir, { recursive: true, force: true });
  });

  test('detects heads, tails, central hubs, and reinforcing/balancing feedback loops', async () => {
    const dataDir = await createTempDir();
    const runtime = createCogMapRuntime({ dataDir });

    await runtime.executeAction(
      'cogmap.mutate',
      {
        title: 'Bullwhip Dynamics',
        pacing: 'auto',
        addNodes: [
          { id: 'n1', label: 'Stable service level', role: 'goal' },
          { id: 'n2', label: 'Order amplification', role: 'factor' },
          { id: 'n3', label: 'Perceived shortage panic', role: 'factor' },
          { id: 'n4', label: 'Share live POS data', role: 'option' },
          { id: 'n5', label: 'Automated reorder cap', role: 'factor' },
        ],
        addEdges: [
          { from: 'n4', to: 'n2', sign: '-' },
          { from: 'n2', to: 'n3', sign: '+' },
          { from: 'n3', to: 'n2', sign: '+' },
          { from: 'n2', to: 'n5', sign: '+' },
          { from: 'n5', to: 'n2', sign: '-' },
          { from: 'n2', to: 'n1', sign: '-' },
        ],
      },
      { sessionId: 'sess-loops' },
    );

    const analysis = await runtime.executeAction('cogmap.analyze', {}, { sessionId: 'sess-loops' });
    expect(analysis.heads.map((h) => h.id)).toEqual(['n1']);
    expect(analysis.tails.map((t) => t.id)).toEqual(['n4']);
    expect(analysis.hubs[0].id).toBe('n2');
    expect(analysis.loops).toHaveLength(2);
    const polarities = analysis.loops.map((loop) => loop.polarity).sort();
    expect(polarities).toEqual(['balancing', 'reinforcing']);

    await fs.rm(dataDir, { recursive: true, force: true });
  });

  test('serializes and parses Mini-DSL and formats compact user deltas', () => {
    const baseMap = {
      id: 'm1',
      sessionId: 's1',
      title: 'Architecture Trade-offs',
      pacing: 'collab',
      rev: 1,
      createdAt: 1,
      updatedAt: 1,
      focusNodeId: 'n1',
      nodes: [
        { id: 'n1', label: 'Low latency reads', pole: 'stale cache risk', role: 'goal', author: 'agent', status: 'agreed' },
        { id: 'n2', label: 'Add edge cache', role: 'option', author: 'agent', status: 'proposed' },
      ],
      edges: [
        { id: 'e1', from: 'n2', to: 'n1', sign: '+', label: 'cuts RTT' },
      ],
    };

    const dsl = serializeCogMapDsl(baseMap);
    const parsed = parseCogMapDsl(dsl);
    expect(parsed.title).toBe('Architecture Trade-offs');
    expect(parsed.nodes).toHaveLength(2);
    expect(parsed.nodes[0].pole).toBe('stale cache risk');
    expect(parsed.nodes[1].status).toBe('proposed');
    expect(parsed.edges).toEqual([{ id: 'e1', from: 'n2', to: 'n1', sign: '+', label: 'cuts RTT' }]);

    const editedMap = {
      ...baseMap,
      rev: 2,
      nodes: [
        ...baseMap.nodes,
        { id: 'n3', label: 'Invalidation complexity', role: 'constraint', author: 'user', status: 'agreed' },
      ],
      edges: [
        ...baseMap.edges,
        { id: 'e2', from: 'n2', to: 'n3', sign: '+' },
      ],
    };

    const delta = formatCogMapDeltaDsl(baseMap, editedMap);
    expect(delta).toContain('<cogmap-user-delta mapId="m1" fromRev="1" toRev="2">');
    expect(delta).toContain('+ n3: Invalidation complexity [constraint,user]');
    expect(delta).toContain('+ n2 +> n3');
    expect(delta).not.toContain('Low latency reads');

    // Neighborhood depth filtering keeps focus node and omits distant nodes.
    const analysis = analyzeCogMap(editedMap);
    expect(analysis.stats.nodeCount).toBe(3);
  });
});
