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

describe('direct child activity', () => {
  const running = { type: 'running' };

  it('needs no history reads when every session is idle', async () => {
    const { probe, reads } = createProbe({});
    expect(await probe.hasWorkingChildren('root', {})).toBe(false);
    expect(reads).toEqual([]);
  });

  it('checks only active records and keeps direct-child semantics', async () => {
    const { probe, reads } = createProbe({
      child: { id: 'child', parentID: 'root' },
      nested: { id: 'nested', parentID: 'child' },
      other: { id: 'other' },
    });
    expect(await probe.hasWorkingChildren('root', { root: running, nested: running, other: running })).toBe(false);
    expect(reads).toEqual(['nested', 'other']);
    expect(await probe.hasWorkingChildren('root', { child: running })).toBe(true);
  });

  it('keeps unreadable activity unknown unless a child is proven to be working', async () => {
    const { probe } = createProbe({ child: { id: 'child', parentID: 'root' } });
    expect(await probe.hasWorkingChildren('root', { missing: running })).toBeNull();
    expect(await probe.hasWorkingChildren('root', { missing: running, child: running })).toBe(true);
  });
});

describe('queue descendant activity', () => {
  const running = { type: 'running' };

  it.each(['statuses', 'descendants', 'shells'])('cancels a hanging %s read with its caller', async (operation) => {
    const controller = new AbortController();
    const entered = Promise.withResolvers();
    const probe = createSessionActivityProbe({
      buildOpenCodeUrl: (route) => `http://opencode.test${route}`,
      getOpenCodeAuthHeaders: () => ({}), signal: controller.signal,
      fetchImpl: async (_url, init) => {
        entered.resolve(init.signal);
        return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
      },
    });
    const result = operation === 'statuses' ? probe.fetchActiveSessionStatuses()
      : operation === 'shells' ? probe.fetchRunningShells('/repo/run')
        : probe.hasWorkingDescendants('root', { child: running });
    const signal = await entered.promise;
    controller.abort(new DOMException('Cleanup timed out', 'TimeoutError'));
    expect(await result).toBeNull();
    expect(signal.aborted).toBe(true);
  });

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

describe('running background jobs', () => {
  const probeAnswering = (response) => createSessionActivityProbe({
    buildOpenCodeUrl: (route) => `http://opencode.test${route}`,
    getOpenCodeAuthHeaders: () => ({}),
    fetchImpl: async () => response(),
  });

  it('keeps the running jobs of the tree with their owners', async () => {
    const probe = probeAnswering(() => Response.json({ data: [
      { kind: 'shell', sessionID: 'child', status: 'running', command: 'bun test', time: { started: 7 } },
      { kind: 'subagent', sessionID: 'root', status: 'completed', time: { started: 1, completed: 2 } },
    ] }));
    expect(await probe.fetchRunningBackgroundJobs('root')).toEqual([
      { kind: 'shell', sessionID: 'child', command: 'bun test', startedAt: 7 },
    ]);
  });

  it('drops an image job past OpenCode\'s 30-minute image timeout, which nothing generates any more', async () => {
    const now = Date.now();
    const probe = probeAnswering(() => Response.json({ data: [
      { kind: 'image', sessionID: 'root', status: 'running', time: { started: now - 40 * 60 * 1000 } },
      { kind: 'image', sessionID: 'root', status: 'running', time: { started: now - 60 * 1000 } },
    ] }));
    expect((await probe.fetchRunningBackgroundJobs('root')).map((job) => job.startedAt)).toEqual([now - 60 * 1000]);
  });

  it('tells an OpenCode without the route from one that could not answer', async () => {
    expect(await probeAnswering(() => new Response(null, { status: 404 })).fetchRunningBackgroundJobs('root')).toBeUndefined();
    const gone = () => Response.json({ _tag: 'SessionNotFoundError', message: 'Session not found' }, { status: 404 });
    expect(await probeAnswering(gone).fetchRunningBackgroundJobs('root')).toBeNull();
    expect(await probeAnswering(() => new Response('down', { status: 503 })).fetchRunningBackgroundJobs('root')).toBeNull();
    expect(await probeAnswering(() => Response.json({ data: {} })).fetchRunningBackgroundJobs('root')).toBeNull();
  });
});
