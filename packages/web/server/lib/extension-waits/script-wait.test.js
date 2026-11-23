import { describe, expect, it } from 'vitest';

import { checkScriptAutomation, wrapScript } from './script-wait.js';

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

// Code Mode runs the program as an async body with `state` among its globals.
const run = (code, state = null) => new AsyncFunction('state', wrapScript(code))(state);

describe('wrapScript', () => {
  it('wakes on a non-empty string or { wake }, and keeps the script\'s state between runs', async () => {
    expect(await run('return "deployed"')).toEqual({ done: true, state: { s: null, wake: 'deployed' } });
    expect(await run('return { wake: "  red to green  ", state: 3 }')).toEqual({ done: true, state: { s: 3, wake: 'red to green' } });
    expect(await run('return { state: (state ?? 0) + 1 }', { s: 1 })).toEqual({ state: { s: 2 } });
    expect(await run('if (state === "seen") return; return { state: "seen" }', { s: 'seen' })).toEqual({ state: { s: 'seen' } });
    expect(await run('return "   "', { s: 7 })).toEqual({ state: { s: 7 } });
  });

  it('ends on a throw and keeps its error, so a failure OpenCode retries is not missed', async () => {
    expect(await run('throw new Error("boom")', { s: 4 })).toMatchObject({ done: true, state: { s: 4, error: expect.stringContaining('boom') } });
    expect(await run('throw ""')).toMatchObject({ done: true, state: { error: 'it threw an empty value' } });
  });
});

describe('checkScriptAutomation', () => {
  const answering = (record) => async () => record;

  it('reads a wake, a failed run, an ended automation and one still running', async () => {
    expect(await checkScriptAutomation(answering({ status: 'done', state: { wake: 'deployed' } }), 'aut_1')).toEqual({ kind: 'fired', summary: 'deployed' });
    expect(await checkScriptAutomation(answering({ status: 'active', lastOutcome: 'failed', lastOutput: 'Error: boom' }), 'aut_1'))
      .toEqual({ kind: 'ended', reason: 'the script failed: Error: boom' });
    expect(await checkScriptAutomation(answering({ status: 'done', lastOutcome: 'expired' }), 'aut_1')).toMatchObject({ kind: 'ended', reason: expect.stringContaining('time ran out') });
    expect(await checkScriptAutomation(answering({ status: 'active', lastOutcome: 'fired' }), 'aut_1')).toEqual({ kind: 'waiting' });
    expect(await checkScriptAutomation(answering({ status: 'done', state: { error: '' } }), 'aut_1')).toEqual({ kind: 'ended', reason: 'the script failed: it gave no error text' });
    expect(await checkScriptAutomation(async () => { throw Object.assign(new Error('gone'), { status: 404 }); }, 'aut_1'))
      .toMatchObject({ kind: 'ended', reason: expect.stringContaining('deleted') });
  });
});
