import { describe, expect, it } from 'vitest';
import { createSerialRefresh } from './serial-refresh.js';

const createGate = () => {
  let release;
  const opened = new Promise((resolve) => {
    release = resolve;
  });
  return { opened, release };
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('createSerialRefresh', () => {
  it('runs one refresh per key and answers later callers with one follow-up run', async () => {
    const refresh = createSerialRefresh();
    const gates = [createGate(), createGate()];
    const executions = [];
    const execute = async (requests) => {
      const index = executions.length;
      executions.push(requests);
      await gates[index].opened;
      return `run-${index}`;
    };

    const first = refresh.run('repo', 'a', execute);
    await flush();
    const second = refresh.run('repo', 'b', execute);
    const third = refresh.run('repo', 'c', execute);
    await flush();

    expect(executions).toEqual([['a']]);

    gates[0].release();
    await expect(first).resolves.toBe('run-0');
    await flush();
    expect(executions).toEqual([['a'], ['b', 'c']]);

    gates[1].release();
    await expect(second).resolves.toBe('run-1');
    await expect(third).resolves.toBe('run-1');
    await flush();
    expect(refresh.activeKeys).toEqual([]);
  });

  it('never serves a caller from a run that started before it asked', async () => {
    const refresh = createSerialRefresh();
    const gate = createGate();
    let reads = 0;
    const execute = async () => {
      reads += 1;
      const value = reads;
      if (value === 1) await gate.opened;
      return value;
    };

    const early = refresh.run('repo', null, execute);
    await flush();
    const late = refresh.run('repo', null, execute);
    gate.release();

    await expect(early).resolves.toBe(1);
    await expect(late).resolves.toBe(2);
  });

  it('cancels one coalesced follower without aborting the shared source for its peers', async () => {
    const refresh = createSerialRefresh();
    const firstGate = createGate();
    const followerGate = createGate();
    const cancelled = new AbortController();
    const retained = new AbortController();
    const sourceSignals = [];
    let executions = 0;
    const execute = async (requests, sourceSignal) => {
      sourceSignals.push(sourceSignal);
      executions += 1;
      if (executions === 1) {
        await firstGate.opened;
        return 'first';
      }
      await followerGate.opened;
      if (sourceSignal.aborted) {
        throw sourceSignal.reason;
      }
      return `follower-${requests.length}`;
    };

    const first = refresh.run('repo', { signal: undefined }, execute);
    await flush();
    const second = refresh.run('repo', { signal: cancelled.signal }, execute);
    const third = refresh.run('repo', { signal: retained.signal }, execute);

    firstGate.release();
    await expect(first).resolves.toBe('first');
    await flush();
    expect(sourceSignals[1]).toBeInstanceOf(AbortSignal);
    expect(sourceSignals[1].aborted).toBe(false);

    cancelled.abort('one follower disconnected');
    await expect(second).rejects.toBe('one follower disconnected');
    expect(sourceSignals[1].aborted).toBe(false);

    followerGate.release();
    await expect(third).resolves.toBe('follower-2');
    expect(sourceSignals[1].aborted).toBe(false);
    expect(refresh.activeKeys).toEqual([]);
  });

  it('does not reuse a cancelled follower and keeps the current source for its waiter', async () => {
    const refresh = createSerialRefresh();
    const firstGate = createGate();
    const followerGate = createGate();
    const cancelled = new AbortController();
    const sourceSignals = [];
    let executions = 0;
    const execute = async (_requests, sourceSignal) => {
      sourceSignals.push(sourceSignal);
      executions += 1;
      if (executions === 1) {
        await firstGate.opened;
        return 'first';
      }
      await followerGate.opened;
      if (sourceSignal.aborted) throw sourceSignal.reason;
      return 'fresh-follower';
    };

    const first = refresh.run('repo', null, execute);
    await flush();
    const staleFollower = refresh.run('repo', { signal: cancelled.signal }, execute);
    await flush();

    cancelled.abort('stale follower disconnected');
    await expect(staleFollower).rejects.toBe('stale follower disconnected');
    expect(sourceSignals[0].aborted).toBe(false);

    const late = refresh.run('repo', null, execute);
    firstGate.release();
    await expect(first).resolves.toBe('first');
    await flush();
    expect(executions).toBe(2);
    expect(sourceSignals[1].aborted).toBe(false);

    followerGate.release();
    await expect(late).resolves.toBe('fresh-follower');
    await flush();
    expect(refresh.activeKeys).toEqual([]);
  });

  it('aborts the current source after the primary and every follower leave', async () => {
    const refresh = createSerialRefresh();
    const primary = new AbortController();
    const followerOne = new AbortController();
    const followerTwo = new AbortController();
    let sourceSignal;
    let sourceAbortCount = 0;
    let finishSource;
    const sourceFinished = new Promise((resolve) => { finishSource = resolve; });
    const execute = async (_requests, signal) => {
      sourceSignal = signal;
      signal.addEventListener('abort', () => {
        sourceAbortCount += 1;
        finishSource();
      }, { once: true });
      await sourceFinished;
      return 'unreachable';
    };

    const first = refresh.run('repo', { signal: primary.signal }, execute);
    await flush();
    const second = refresh.run('repo', { signal: followerOne.signal }, execute);
    const third = refresh.run('repo', { signal: followerTwo.signal }, execute);
    await flush();

    followerOne.abort('follower one disconnected');
    followerTwo.abort('follower two disconnected');
    await expect(second).rejects.toBe('follower one disconnected');
    await expect(third).rejects.toBe('follower two disconnected');
    expect(sourceSignal.aborted).toBe(false);

    primary.abort('primary disconnected');
    await expect(first).rejects.toBe('primary disconnected');
    await sourceFinished;
    await flush();
    expect(sourceSignal.aborted).toBe(true);
    expect(sourceAbortCount).toBe(1);
    expect(refresh.activeKeys).toEqual([]);
  });

  it('keeps keys independent and bounds how many run at once', async () => {
    const refresh = createSerialRefresh({ maxConcurrent: 2 });
    const gates = new Map();
    const started = [];
    const execute = (key) => async () => {
      started.push(key);
      const gate = createGate();
      gates.set(key, gate);
      await gate.opened;
      return key;
    };

    const runs = ['a', 'b', 'c'].map((key) => refresh.run(key, null, execute(key)));
    await flush();
    expect(started).toEqual(['a', 'b']);

    gates.get('a').release();
    await flush();
    expect(started).toEqual(['a', 'b', 'c']);

    gates.get('b').release();
    gates.get('c').release();
    await expect(Promise.all(runs)).resolves.toEqual(['a', 'b', 'c']);
  });

  it('propagates a failed run to its callers and still runs the follow-up', async () => {
    const refresh = createSerialRefresh();
    const gate = createGate();
    let calls = 0;
    const execute = async () => {
      calls += 1;
      if (calls === 1) {
        await gate.opened;
        throw new Error('first failed');
      }
      return 'ok';
    };

    const first = refresh.run('repo', null, execute);
    await flush();
    const second = refresh.run('repo', null, execute);
    gate.release();

    await expect(first).rejects.toThrow('first failed');
    await expect(second).resolves.toBe('ok');
  });
});
