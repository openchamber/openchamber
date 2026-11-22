import { describe, expect, it } from 'vitest';

import { runWorkflowSandbox } from './sandbox.js';

const run = (body, { args, onAgent = async ({ prompt }) => `answer to ${prompt}` } = {}) => {
  const phases = [];
  const logs = [];
  const calls = [];
  const sandbox = runWorkflowSandbox({
    body,
    args,
    filename: 'test.workflow.js',
    onAgent: (call) => {
      calls.push(call);
      return onAgent(call);
    },
    onPhase: (title) => phases.push(title),
    onLog: (message) => logs.push(message),
  });
  return { sandbox, phases, logs, calls };
};

describe('runWorkflowSandbox', () => {
  it('runs agents, phases and fan-out, and returns the script value', async () => {
    const { sandbox, phases, calls } = run(`
      phase('Find')
      const first = await agent('list', { label: 'Lister' })
      phase('Audit')
      const audits = await pipeline(args.items, (item) => agent('audit ' + item))
      return { first, audits }
    `, { args: { items: ['a', 'b'] } });
    await expect(sandbox.result).resolves.toEqual({ first: 'answer to list', audits: ['answer to audit a', 'answer to audit b'] });
    expect(phases).toEqual(['Find', 'Audit']);
    expect(calls.map(({ prompt, phase }) => [prompt, phase])).toEqual([['list', 'Find'], ['audit a', 'Audit'], ['audit b', 'Audit']]);
    expect(calls[0].options).toEqual({ label: 'Lister' });
  });

  it('runs each pipeline item through its stages without waiting for the others', async () => {
    const order = [];
    const { sandbox } = run(`
      return pipeline(['slow', 'fast'],
        (item) => agent('find ' + item),
        (found, item, index) => agent('check ' + found + ' #' + index),
      )
    `, {
      onAgent: async ({ prompt }) => {
        order.push(prompt);
        if (prompt === 'find slow') await new Promise((resolve) => setTimeout(resolve, 50));
        return prompt.replace('find ', '');
      },
    });
    await expect(sandbox.result).resolves.toEqual(['check slow #0', 'check fast #1']);
    // The fast item reached its second stage before the slow one left its first.
    expect(order.indexOf('check fast #1')).toBeLessThan(order.indexOf('check slow #0'));
  });

  it('ends a pipeline item at a stage that gives null, without starting the next stage', async () => {
    const { sandbox, calls } = run(`
      return pipeline(['bad', 'good'], (item) => agent('find ' + item), (found) => agent('check ' + found))
    `, { onAgent: async ({ prompt }) => (prompt === 'find bad' ? null : prompt.replace('find ', '')) });
    await expect(sandbox.result).resolves.toEqual([null, 'check good']);
    expect(calls.map(({ prompt }) => prompt).sort()).toEqual(['check good', 'find bad', 'find good']);
  });

  it("files an agent under its own phase over the script's current one", async () => {
    const { sandbox, calls } = run(`
      phase('Find')
      return parallel([() => agent('a'), () => agent('b', { phase: 'Verify' })])
    `);
    await sandbox.result;
    expect(calls.map(({ prompt, phase }) => [prompt, phase])).toEqual([['a', 'Find'], ['b', 'Verify']]);
  });

  it('gives a run without args an empty object', async () => {
    const { sandbox } = run(`return args.items ?? 'default'`);
    await expect(sandbox.result).resolves.toBe('default');
  });

  it('turns a failed agent and a failed task into null and logs the task', async () => {
    const { sandbox, logs } = run(`
      return parallel([
        () => agent('fails'),
        () => { throw new Error('boom') },
        () => agent('works'),
      ])
    `, { onAgent: async ({ prompt }) => prompt === 'fails' ? null : prompt });
    await expect(sandbox.result).resolves.toEqual([null, null, 'works']);
    expect(logs).toEqual(['A task in parallel() failed: boom']);
  });

  it('ends the run when an agent call is refused, not just the call', async () => {
    // A rejected host operation means the call was invalid, not that the
    // agent failed: answering null would let the script treat a bug as an
    // outcome.
    const { sandbox } = run("return agent('work', { forkFrom: 'gone' })", { onAgent: async () => { throw new TypeError('forkFrom "gone" must name a successfully completed agent in this run'); } });
    await expect(sandbox.result).rejects.toThrow('forkFrom "gone"');
  });

  it.each([
    ['a function forkFrom', "return agent('work', { forkFrom: () => 'a' })", 'forkFrom must be'],
    ['a BigInt id', "return agent('work', { id: 1n })", 'id must be'],
    ['a valid forkFrom beside an unserializable option', "return agent('work', { forkFrom: 'a', schema: { const: 1n } })", 'must be JSON-serializable'],
    ['a bad name inside parallel()', "return parallel([() => agent('work', { id: 1n }), () => 'other'])", 'id must be'],
  ])('fails the run on %s before the call reaches the host', async (_case, body, message) => {
    // A JSON round trip would drop a function and stringify the options of a
    // BigInt, so the host would start a fresh agent with no name at all.
    const { sandbox, calls } = run(body);
    await expect(sandbox.result).rejects.toThrow(message);
    expect(calls).toEqual([]);
  });

  it('gives the script nothing of the host', async () => {
    const { sandbox } = run('return [typeof require, typeof process, typeof fetch, typeof setTimeout]');
    await expect(sandbox.result).resolves.toEqual(['undefined', 'undefined', 'undefined', 'undefined']);
  });

  it.each(['Math.random()', 'Date.now()', 'new Date()'])('refuses %s, which would break a replay', async (expression) => {
    const { sandbox } = run(`return ${expression}`);
    await expect(sandbox.result).rejects.toThrow(/not available in a workflow/);
  });

  it('keeps dates built from a value', async () => {
    const { sandbox } = run("return new Date('2026-01-02T00:00:00Z').getUTCFullYear()");
    await expect(sandbox.result).resolves.toBe(2026);
  });

  it('rejects with the script error', async () => {
    const { sandbox } = run("throw new Error('script broke')");
    await expect(sandbox.result).rejects.toThrow('script broke');
  });

  it('stops a script that never ends', async () => {
    const { sandbox } = run('while (true) {}');
    sandbox.terminate();
    await expect(sandbox.result).rejects.toMatchObject({ stopped: true });
  });
});
