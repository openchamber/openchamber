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
