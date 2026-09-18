import { describe, expect, it, vi } from 'vitest';
import { createRoutingRuntime, requestTextOf } from './runtime.js';
import { resolveEffectiveConfig } from './store.js';
import { excerptHead, excerptHeadTail, turnsToHistory } from './history.js';
import { decidePermission, decideRouting } from './jev.js';

const AUTO = { providerID: 'openchamber', modelID: 'auto' };
const FALLBACK = { model: { providerID: 'anthropic', modelID: 'claude-sonnet-5' }, variant: 'medium' };

const readyConfig = () => {
  const config = resolveEffectiveConfig(null);
  config.enabled = true;
  config.fallback = FALLBACK;
  config.safetyNet = { enabled: true, threshold: 0.6 };
  config.categories = config.categories.map((c) => (c.id === 'hard'
    ? { ...c, model: { providerID: 'openai', modelID: 'gpt-6-astra' }, variant: 'high', agent: 'plan' }
    : c));
  return config;
};

const makeRuntime = ({ config = readyConfig(), token = 'key', answers, askError, flag = '1' } = {}) => {
  process.env.OPENCHAMBER_ROUTING_ENABLE = flag;
  const events = [];
  const store = {
    readConfig: vi.fn(async () => config),
    writeConfig: vi.fn(async (next) => next),
    readToken: vi.fn(async () => token),
    writeToken: vi.fn(async () => undefined),
    clearToken: vi.fn(async () => undefined),
  };
  const jev = { ask: vi.fn(async () => { if (askError) throw askError; return { answers, ms: 12 }; }) };
  const runtime = createRoutingRuntime({
    dataDir: '/unused',
    buildOpenCodeUrl: () => 'http://127.0.0.1:1/',
    getOpenCodeAuthHeaders: () => ({}),
    broadcastGlobalUiEvent: (event) => events.push(event),
    store,
    jev,
  });
  return { runtime, store, jev, events };
};

describe('requestTextOf', () => {
  it('joins authored text parts and ignores synthetic ones and files', () => {
    expect(requestTextOf({ parts: [
      { type: 'text', text: 'fix the typo' },
      { type: 'text', text: 'injected', synthetic: true },
      { type: 'file', url: 'data:...' },
      { type: 'text', text: 'in README' },
    ] })).toBe('fix the typo\n\nin README');
  });
  it('renders a slash command with its arguments', () => {
    expect(requestTextOf({ command: 'review', arguments: ' 3650 ' })).toBe('/review 3650');
  });
});

describe('history excerpts', () => {
  it('keeps the head of a user message and head plus tail of an answer', () => {
    const long = 'a'.repeat(1000);
    expect(excerptHead(long, 600)).toBe(`${'a'.repeat(600)} […]`);
    expect(excerptHeadTail(`${'h'.repeat(400)}${'m'.repeat(400)}${'t'.repeat(400)}`, 300, 300)).toBe(`${'h'.repeat(300)} […] ${'t'.repeat(300)}`);
    expect(excerptHead('short', 600)).toBe('short');
  });
  it('flattens the last three turns oldest first', () => {
    const turns = [1, 2, 3, 4].map((n) => ({ user: { text: `u${n}` }, assistant: { text: `a${n}` } }));
    expect(turnsToHistory(turns)).toEqual([
      { role: 'user', text: 'u2' }, { role: 'assistant', text: 'a2' },
      { role: 'user', text: 'u3' }, { role: 'assistant', text: 'a3' },
      { role: 'user', text: 'u4' }, { role: 'assistant', text: 'a4' },
    ]);
  });
});

describe('decisions', () => {
  const categories = readyConfig().categories;
  it('routes a confident known category and falls back otherwise', () => {
    expect(decideRouting({ choice: 'hard', confidence: 0.9 }, { categories, minConfidence: 0.6 }).reason).toBe('routed');
    expect(decideRouting({ choice: 'hard', confidence: 0.4 }, { categories, minConfidence: 0.6 })).toMatchObject({ category: null, reason: 'low-confidence' });
    expect(decideRouting({ choice: 'nope', confidence: 0.99 }, { categories, minConfidence: 0.6 })).toMatchObject({ category: null, reason: 'unknown-category' });
  });
  it('holds a permission at or above the threshold', () => {
    expect(decidePermission({ ask: { noul: 0.61 }, kind: { choice: 'git_history' } }, { threshold: 0.6 })).toEqual({ hold: true, score: 0.61, kind: 'git_history' });
    expect(decidePermission({ ask: { noul: 0.2 }, kind: { choice: 'read_only' } }, { threshold: 0.6 }).hold).toBe(false);
    expect(() => decidePermission({}, { threshold: 0.6 })).toThrow(/ask score/);
  });
});

describe('resolvePromptBody', () => {
  it('leaves a real model untouched and does not consult Jev', async () => {
    const { runtime, jev } = makeRuntime({ answers: {} });
    const body = { model: { providerID: 'anthropic', modelID: 'claude-opus-5' }, parts: [] };
    expect(await runtime.resolvePromptBody(body, { sessionId: 's1' })).toBeNull();
    expect(body.model.modelID).toBe('claude-opus-5');
    expect(jev.ask).not.toHaveBeenCalled();
  });

  it('rewrites the sentinel with the routed category model, variant and agent', async () => {
    const { runtime, events } = makeRuntime({ answers: { category: { choice: 'hard', confidence: 0.97 } } });
    const body = { model: AUTO, variant: 'low', agent: 'build', parts: [{ type: 'text', text: 'find the root cause' }] };
    const decision = await runtime.resolvePromptBody(body, { sessionId: 's1' });
    expect(body).toMatchObject({ model: { providerID: 'openai', modelID: 'gpt-6-astra' }, variant: 'high', agent: 'plan' });
    expect(decision).toMatchObject({ category: 'hard', reason: 'routed', confidence: 0.97 });
    expect(events.at(-1)).toMatchObject({ type: 'openchamber:routing.decision', properties: { sessionId: 's1', category: 'hard' } });
  });

  it('rewrites the string sentinel the command route sends, keeping the string shape', async () => {
    const { runtime } = makeRuntime({ answers: { category: { choice: 'hard', confidence: 0.97 } } });
    const body = { model: 'openchamber/auto', command: 'review', arguments: '3650' };
    await runtime.resolvePromptBody(body, { sessionId: 's1' });
    expect(body.model).toBe('openai/gpt-6-astra');
    expect(body.agent).toBe('plan');
  });

  it('uses the fallback and keeps the composer agent when the category has no model', async () => {
    const { runtime } = makeRuntime({ answers: { category: { choice: 'trivial', confidence: 0.99 } } });
    const body = { model: AUTO, variant: 'high', agent: 'build', parts: [{ type: 'text', text: 'fix typo' }] };
    await runtime.resolvePromptBody(body, { sessionId: 's1' });
    expect(body).toMatchObject({ model: FALLBACK.model, variant: 'medium', agent: 'build' });
  });

  it('falls back on low confidence and on a Jev failure, and records why', async () => {
    const low = makeRuntime({ answers: { category: { choice: 'hard', confidence: 0.3 } } });
    const body = { model: AUTO, parts: [] };
    expect((await low.runtime.resolvePromptBody(body, { sessionId: 's1' })).reason).toBe('low-confidence');
    expect(body.model).toEqual(FALLBACK.model);

    const failing = makeRuntime({ askError: Object.assign(new Error('Jev responded 401'), { status: 401 }) });
    const body2 = { model: AUTO, parts: [] };
    const decision = await failing.runtime.resolvePromptBody(body2, { sessionId: 's1' });
    expect(decision).toMatchObject({ reason: 'error', error: 'Jev responded 401' });
    expect(body2.model).toEqual(FALLBACK.model);
  });

  it('falls back without asking Jev while Auto is not ready, and refuses without a fallback', async () => {
    const config = readyConfig();
    config.enabled = false;
    const notReady = makeRuntime({ config, answers: {} });
    const body = { model: AUTO, parts: [] };
    expect((await notReady.runtime.resolvePromptBody(body, { sessionId: 's1' })).reason).toBe('not-ready');
    expect(body.model).toEqual(FALLBACK.model);
    expect(notReady.jev.ask).not.toHaveBeenCalled();

    const noFallback = makeRuntime({ config: { ...readyConfig(), fallback: null }, answers: {} });
    await expect(noFallback.runtime.resolvePromptBody({ model: AUTO, parts: [] }, { sessionId: 's1' })).rejects.toMatchObject({ status: 400 });
  });
});

describe('evaluatePermission', () => {
  const permission = { id: 'p1', sessionID: 's1', permission: 'bash', patterns: ['git push --force'], metadata: { command: 'git push --force origin main' } };

  it('holds a risky permission and remembers the decision', async () => {
    const { runtime, jev, events } = makeRuntime({ answers: { ask: { noul: 0.9 }, kind: { choice: 'git_history' } } });
    expect(await runtime.evaluatePermission(permission, '/repo')).toEqual({ action: 'hold', score: 0.9, kind: 'git_history' });
    expect(await runtime.evaluatePermission(permission, '/repo')).toEqual({ action: 'hold', score: 0.9, kind: 'git_history' });
    expect(jev.ask).toHaveBeenCalledTimes(1);
    expect(events.filter((e) => e.type === 'openchamber:routing.permission-held')).toHaveLength(1);
    expect(runtime.heldPermissions()).toEqual([{ permissionId: 'p1', score: 0.9, kind: 'git_history' }]);
    runtime.forgetPermission('p1');
    expect(runtime.heldPermissions()).toEqual([]);
  });

  it('accepts when Jev is unreachable and tells the UI it skipped', async () => {
    const { runtime, events } = makeRuntime({ askError: Object.assign(new Error('Jev timed out after 4000ms'), { code: 'timeout' }) });
    expect(await runtime.evaluatePermission(permission, '/repo')).toEqual({ action: 'accept', skipped: 'Jev timed out after 4000ms' });
    expect(events.at(-1)).toMatchObject({ type: 'openchamber:routing.safety-skipped', properties: { permissionId: 'p1', error: 'Jev timed out after 4000ms' } });
  });

  it('accepts without asking when the safety net is off, the key is missing, or the flag is unset', async () => {
    const off = readyConfig();
    off.safetyNet.enabled = false;
    for (const setup of [{ config: off }, { token: null }, { flag: '' }]) {
      const { runtime, jev } = makeRuntime({ ...setup, answers: {} });
      expect(await runtime.evaluatePermission(permission, '/repo')).toEqual({ action: 'accept' });
      expect(jev.ask).not.toHaveBeenCalled();
    }
  });
});

describe('describe', () => {
  it('reports Auto ready only with the flag, enabled config, key, fallback and two categories', async () => {
    expect((await makeRuntime({ answers: {} }).runtime.describe()).autoReady).toBe(true);
    expect((await makeRuntime({ token: null, answers: {} }).runtime.describe())).toMatchObject({ autoReady: false, tokenPresent: false });
    const one = readyConfig();
    one.categories = one.categories.map((c, i) => ({ ...c, enabled: i === 0 }));
    expect((await makeRuntime({ config: one, answers: {} }).runtime.describe()).autoReady).toBe(false);
    expect(await makeRuntime({ flag: '', answers: {} }).runtime.describe()).toEqual({ available: false, autoReady: false, tokenPresent: false, config: null, builtins: [] });
  });
});
