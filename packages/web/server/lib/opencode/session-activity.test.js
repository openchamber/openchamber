import { describe, expect, it } from 'vitest';
import { createSessionActivityProbe } from './session-activity.js';

const createProbe = (sessions, { failureId, timeoutMs = 10_000, delayMs = 0 } = {}) => {
  const reads = [];
  const signals = new Set();
  const probe = createSessionActivityProbe({
    buildOpenCodeUrl: (route) => `http://opencode.test${route}`,
    getOpenCodeAuthHeaders: () => ({}),
    timeoutMs,
    fetchImpl: async (url, init) => {
      const id = decodeURIComponent(new URL(url).pathname.split('/').at(-1));
      reads.push(id);
      signals.add(init.signal);
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      if (id === failureId) return new Response(null, { status: 503 });
      return Response.json({ data: sessions[id] ?? null });
    },
  });
  return { probe, reads, signals };
};

describe('queue descendant activity', () => {
  const running = { type: 'running' };

  it('detects a live grandchild through an idle intermediate session', async () => {
    const { probe, reads } = createProbe({ child: { id: 'child', parentID: 'root' }, grandchild: { id: 'grandchild', parentID: 'child' } });
    expect(await probe.hasWorkingDescendants('root', { grandchild: running })).toBe(true);
    expect(reads).toEqual(['grandchild', 'child']);
    expect(await probe.hasWorkingDescendants('root', {})).toBe(false);
    expect(reads).toHaveLength(2);
  });

  it('does not block on an unrelated active tree or count the parent itself', async () => {
    const { probe, reads } = createProbe({ other: { id: 'other' }, child: { id: 'child', parentID: 'other' } });
    expect(await probe.hasWorkingDescendants('root', { root: running, child: running })).toBe(false);
    expect(reads).toEqual(['child', 'other']);
  });

  it('reads shared ancestry once within a probe and refreshes it on the next probe', async () => {
    const sessions = { other: { id: 'other' } };
    const statuses = {};
    for (let index = 0; index < 100; index += 1) {
      const id = `child_${index}`;
      sessions[id] = { id, parentID: 'other' };
      statuses[id] = running;
    }
    const { probe, reads, signals } = createProbe(sessions);
    expect(await probe.hasWorkingDescendants('root', statuses)).toBe(false);
    expect(reads).toHaveLength(101);
    expect(signals.size).toBe(1);
    sessions.other.parentID = 'root';
    expect(await probe.hasWorkingDescendants('root', { child_0: running })).toBe(true);
    expect(reads).toHaveLength(103);
  });

  it('keeps unreadable lineage unknown and allows a later successful read', async () => {
    const sessions = { grandchild: { id: 'grandchild', parentID: 'child' }, child: { id: 'child', parentID: 'root' } };
    const { probe } = createProbe(sessions, { failureId: 'child' });
    expect(await probe.hasWorkingDescendants('root', { grandchild: running })).toBeNull();
    expect(await createProbe(sessions).probe.hasWorkingDescendants('root', { grandchild: running })).toBe(true);
  });

  it('rejects missing, malformed and mismatched session records', async () => {
    for (const record of [null, {}, { id: 'other' }, { id: 'child', parentID: 123 }, { id: 'child', parentID: '' }]) {
      const { probe } = createProbe({ child: record });
      expect(await probe.hasWorkingDescendants('root', { child: running })).toBeNull();
    }
  });

  it('still reports a proven descendant when another active lineage fails', async () => {
    const { probe } = createProbe({ child: { id: 'child', parentID: 'root' } });
    expect(await probe.hasWorkingDescendants('root', { missing: running, child: running })).toBe(true);
  });

  it('bounds cyclic lineage and preserves the unknown result', async () => {
    const { probe, reads } = createProbe({ a: { id: 'a', parentID: 'b' }, b: { id: 'b', parentID: 'a' } });
    expect(await probe.hasWorkingDescendants('root', { a: running })).toBeNull();
    expect(reads).toEqual(['a', 'b']);
  });

  it('accepts an eighth-level descendant and treats a deeper chain as unrelated', async () => {
    const sessions = {};
    for (let depth = 1; depth <= 9; depth += 1) sessions[`child_${depth}`] = { id: `child_${depth}`, parentID: depth === 1 ? 'root' : `child_${depth - 1}` };
    const { probe, reads } = createProbe(sessions);
    expect(await probe.hasWorkingDescendants('root', { child_8: running })).toBe(true);
    expect(reads).toHaveLength(8);
    expect(await probe.hasWorkingDescendants('root', { child_9: running })).toBe(false);
    expect(reads).toHaveLength(16);
  });

  it('uses one deadline for the entire lineage walk', async () => {
    const { probe, reads } = createProbe({ child: { id: 'child', parentID: 'parent' } }, { timeoutMs: 1, delayMs: 10 });
    expect(await probe.hasWorkingDescendants('root', { child: running })).toBeNull();
    expect(reads).toEqual(['child']);
  });
});
