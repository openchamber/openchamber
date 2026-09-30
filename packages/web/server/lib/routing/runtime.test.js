import { describe, expect, it, vi } from 'vitest';
import { createRoutingRuntime, readOpenCodeKeys, requestTextOf } from './runtime.js';
import { resolveEffectiveConfig } from './store.js';
import { excerptHead, excerptHeadTail, turnsToHistory } from './history.js';
import { createJevClient, decidePermission, decideRouting } from './jev.js';
import { classifierEndpoint, normalizeCustomEndpointUrl, resolveClassifier } from './classifier.js';
import { translateWireEvent } from '../event-stream/translate-v2.js';
import { createPermissionAutoAcceptRuntime } from '../permission-auto-accept/runtime.js';

const AUTO = { providerID: 'openchamber', id: 'auto' };
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

const makeRuntime = ({ config = readyConfig(), token = 'key', classifierSource = null, customEndpoint = null, providerKeys = {}, zenPromotionActive = true, enterprise = false, pinned = null, answers, askError } = {}) => {
  const events = [];
  const store = {
    readConfig: vi.fn(async () => config),
    writeConfig: vi.fn(async (next) => next),
    readToken: vi.fn(async () => token),
    writeToken: vi.fn(async () => undefined),
    clearToken: vi.fn(async () => undefined),
    readClassifierSource: vi.fn(async () => classifierSource),
    writeClassifierSource: vi.fn(async () => undefined),
    readCustomEndpoint: vi.fn(async () => customEndpoint),
    writeCustomEndpoint: vi.fn(async () => undefined),
    clearCustomEndpoint: vi.fn(async () => undefined),
  };
  const jev = { ask: vi.fn(async () => { if (askError) throw askError; return { answers, ms: 12 }; }) };
  const runtime = createRoutingRuntime({
    dataDir: '/unused',
    buildOpenCodeUrl: () => 'http://127.0.0.1:1/',
    getOpenCodeAuthHeaders: () => ({}),
    broadcastGlobalUiEvent: (event) => events.push(event),
    store,
    jev,
    readProviderKeys: () => ({ zenKey: null, openrouterKey: null, vercelKey: null, ...providerKeys }),
    zenPromotionActive,
    enterpriseMode: () => enterprise,
    readPinnedEndpoint: () => pinned,
  });
  return { runtime, store, jev, events };
};

describe('requestTextOf', () => {
  it('reads the prompt text a v2 send carries', () => {
    expect(requestTextOf({ text: '  fix the typo in README  ', files: [{ uri: 'data:...' }] })).toBe('fix the typo in README');
  });
  it('renders a v2 command body (`name` plus `text`) as the slash command', () => {
    expect(requestTextOf({ name: 'review', text: ' src ' })).toBe('/review src');
  });
  it('keeps the command name when it has no arguments', () => {
    expect(requestTextOf({ name: 'review', text: '' })).toBe('/review');
    expect(requestTextOf({ name: 'review' })).toBe('/review');
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

describe('resolveAutoSelection', () => {
  const send = (extra = {}) => ({ sessionId: 's1', model: AUTO, requestText: 'find the root cause', ...extra });

  it('leaves a real model untouched and does not consult Jev', async () => {
    const { runtime, jev } = makeRuntime({ answers: {} });
    expect(await runtime.resolveAutoSelection(send({ model: { providerID: 'anthropic', id: 'claude-opus-5' } }))).toBeNull();
    expect(jev.ask).not.toHaveBeenCalled();
  });

  it('answers with the routed category model, variant and agent', async () => {
    const { runtime, events } = makeRuntime({ answers: { category: { choice: 'hard', confidence: 0.97 } } });
    const resolved = await runtime.resolveAutoSelection(send({ agent: 'build' }));
    expect(resolved.model).toEqual({ providerID: 'openai', id: 'gpt-6-astra', variant: 'high' });
    expect(resolved.agent).toBe('plan');
    expect(resolved.decision).toMatchObject({ category: 'hard', reason: 'routed', confidence: 0.97 });
    expect(events.at(-1)).toMatchObject({ type: 'openchamber:routing.decision', properties: { sessionId: 's1', category: 'hard' } });
  });

  it('uses the fallback pair and keeps the composer agent when the category has no model', async () => {
    const { runtime } = makeRuntime({ answers: { category: { choice: 'trivial', confidence: 0.99 } } });
    const resolved = await runtime.resolveAutoSelection(send({ agent: 'build', requestText: 'fix typo' }));
    expect(resolved.model).toEqual({ providerID: 'anthropic', id: 'claude-sonnet-5', variant: 'medium' });
    expect(resolved.agent).toBe('build');
  });

  it('falls back on low confidence and on a Jev failure, and records why', async () => {
    const low = makeRuntime({ answers: { category: { choice: 'hard', confidence: 0.3 } } });
    const lowResolved = await low.runtime.resolveAutoSelection(send());
    expect(lowResolved.decision.reason).toBe('low-confidence');
    expect(lowResolved.model).toMatchObject({ providerID: 'anthropic', id: 'claude-sonnet-5' });

    const failing = makeRuntime({ askError: Object.assign(new Error('Jev responded 401'), { status: 401 }) });
    const resolved = await failing.runtime.resolveAutoSelection(send());
    expect(resolved.decision).toMatchObject({ reason: 'error', error: 'Jev responded 401' });
    expect(resolved.model).toMatchObject({ providerID: 'anthropic', id: 'claude-sonnet-5' });
  });

  it('falls back without asking Jev while Auto is not ready, and refuses without a fallback', async () => {
    const config = readyConfig();
    config.enabled = false;
    const notReady = makeRuntime({ config, answers: {} });
    const resolved = await notReady.runtime.resolveAutoSelection(send());
    expect(resolved.decision.reason).toBe('not-ready');
    expect(resolved.model).toMatchObject({ providerID: 'anthropic', id: 'claude-sonnet-5' });
    expect(notReady.jev.ask).not.toHaveBeenCalled();

    const noFallback = makeRuntime({ config: { ...readyConfig(), fallback: null }, answers: {} });
    await expect(noFallback.runtime.resolveAutoSelection(send())).rejects.toMatchObject({ status: 400 });
  });
});

describe('jev endpoint', () => {
  const capture = async (source, keys = {}) => {
    let call = null;
    const fetchImpl = async (url, init) => {
      call = { url, init };
      return { ok: true, status: 200, text: async () => JSON.stringify({ answers: {} }) };
    };
    await createJevClient({ fetchImpl }).ask({ state: 'x', questions: {} }, classifierEndpoint(source, keys));
    return { url: call.url, headers: call.init.headers, body: JSON.parse(call.init.body) };
  };

  it('sends a TypeSafe key to TypeSafe, a Zen key to the paid zen model, and the promotion keyless', async () => {
    const keyed = await capture('typesafe', { typesafeKey: 'secret' });
    expect(keyed.url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(keyed.headers.authorization).toBe('Bearer secret');
    expect(keyed.body.model).toBe('jev-latest');

    const zen = await capture('zen-key', { zenKey: 'zen-secret' });
    expect(zen.url).toBe('https://opencode.ai/zen/v1/systemone');
    expect(zen.headers.authorization).toBe('Bearer zen-secret');
    expect(zen.headers['x-opencode-client']).toBe('openchamber');
    expect(zen.body.model).toBe('jev-1.13');

    const free = await capture('zen-promo');
    expect(free.url).toBe('https://opencode.ai/zen/v1/systemone');
    expect(free.headers.authorization).toBeUndefined();
    // Zen counts our calls by this header, and does not know the `jev-latest` alias.
    expect(free.headers['x-opencode-client']).toBe('openchamber');
    expect(free.body.model).toBe('jev-1.13-free');
  });

  it('sends the OpenCode-saved OpenRouter and Vercel keys to their System One routes, without the zen header', async () => {
    const openrouter = await capture('openrouter', { openrouterKey: 'or-secret' });
    expect(openrouter.url).toBe('https://openrouter.ai/api/v1/systemone');
    expect(openrouter.headers.authorization).toBe('Bearer or-secret');
    expect(openrouter.headers['x-opencode-client']).toBeUndefined();
    expect(openrouter.body.model).toBe('jev-latest');

    const vercel = await capture('vercel', { vercelKey: 'gw-secret' });
    expect(vercel.url).toBe('https://ai-gateway.vercel.sh/typesafe/v1/systemone');
    expect(vercel.headers.authorization).toBe('Bearer gw-secret');
    expect(vercel.headers['x-opencode-client']).toBeUndefined();
    expect(vercel.body.model).toBe('typesafe-ai/jev');
  });

  it('sends a custom endpoint its own URL and model, with the key as a bearer only when one is saved', async () => {
    const url = 'https://jev.example.com/v1/systemone';
    const keyed = await capture('custom', { customEndpoint: { url, model: 'jev-1.13', key: 'own-secret' } });
    expect(keyed.url).toBe(url);
    expect(keyed.body.model).toBe('jev-1.13');
    expect(keyed.headers.authorization).toBe('Bearer own-secret');
    expect(keyed.headers['x-opencode-client']).toBeUndefined();

    const keyless = await capture('custom', { customEndpoint: { url, model: 'jev-latest' } });
    expect(keyless.headers.authorization).toBeUndefined();
  });
});

describe('normalizeCustomEndpointUrl', () => {
  it('takes the full System One URL, an OpenAI-style /v1 base, or an API root', () => {
    expect(normalizeCustomEndpointUrl(' https://openrouter.ai/api/v1/systemone/ ')).toBe('https://openrouter.ai/api/v1/systemone');
    expect(normalizeCustomEndpointUrl('https://openrouter.ai/api/v1')).toBe('https://openrouter.ai/api/v1/systemone');
    expect(normalizeCustomEndpointUrl('https://api.typesafe.ai')).toBe('https://api.typesafe.ai/v1/systemone');
    expect(normalizeCustomEndpointUrl('http://127.0.0.1:8080/jev/')).toBe('http://127.0.0.1:8080/jev/v1/systemone');
  });

  it('refuses other schemes, credentials in the URL and non-URLs', () => {
    expect(() => normalizeCustomEndpointUrl('ftp://example.com')).toThrow(expect.objectContaining({ status: 400 }));
    expect(() => normalizeCustomEndpointUrl('file:///etc/passwd')).toThrow(expect.objectContaining({ status: 400 }));
    expect(() => normalizeCustomEndpointUrl('https://user:secret@example.com/v1')).toThrow(expect.objectContaining({ status: 400 }));
    expect(() => normalizeCustomEndpointUrl('example.com/v1')).toThrow(expect.objectContaining({ status: 400 }));
  });
});

describe('resolveClassifier', () => {
  it('defaults to a saved TypeSafe key, else off', () => {
    expect(resolveClassifier({ selected: null, typesafeKey: 'k', zenKey: null, zenPromotionActive: true })).toMatchObject({ selected: 'typesafe', effective: 'typesafe' });
    expect(resolveClassifier({ selected: null, typesafeKey: null, zenKey: 'z', openrouterKey: 'o', zenPromotionActive: true })).toMatchObject({ selected: 'off', effective: null });
  });

  it('keeps off off, whatever is usable', () => {
    expect(resolveClassifier({ selected: 'off', typesafeKey: 'k', zenKey: 'z', zenPromotionActive: true }).effective).toBeNull();
  });

  it('falls back to the first usable key when the pick cannot be used, never to the promotion', () => {
    expect(resolveClassifier({ selected: 'zen-promo', typesafeKey: null, zenKey: 'z', zenPromotionActive: false }).effective).toBe('zen-key');
    expect(resolveClassifier({ selected: 'typesafe', typesafeKey: null, zenKey: null, zenPromotionActive: true }).effective).toBeNull();
    expect(resolveClassifier({ selected: 'zen-promo', typesafeKey: null, zenKey: null, zenPromotionActive: false }).effective).toBeNull();
    expect(resolveClassifier({ selected: 'zen-promo', typesafeKey: null, zenKey: 'z', vercelKey: 'v', zenPromotionActive: false }).effective).toBe('vercel');
    expect(resolveClassifier({ selected: 'vercel', typesafeKey: null, openrouterKey: 'o', zenPromotionActive: true }).effective).toBe('openrouter');
  });

  it('keeps a usable OpenRouter or Vercel pick', () => {
    expect(resolveClassifier({ selected: 'openrouter', typesafeKey: 'k', openrouterKey: 'o', zenPromotionActive: true }).effective).toBe('openrouter');
    expect(resolveClassifier({ selected: 'vercel', vercelKey: 'v', zenPromotionActive: true }).effective).toBe('vercel');
  });

  it('uses a saved custom endpoint when picked, and falls back to it after TypeSafe and before OpenCode keys', () => {
    const customEndpoint = { url: 'https://jev.example.com/v1/systemone', model: 'jev-latest' };
    expect(resolveClassifier({ selected: 'custom', customEndpoint, openrouterKey: 'o', zenPromotionActive: true }).effective).toBe('custom');
    expect(resolveClassifier({ selected: 'custom', customEndpoint: null, vercelKey: 'v', zenPromotionActive: true }).effective).toBe('vercel');
    expect(resolveClassifier({ selected: 'custom', customEndpoint: null, zenPromotionActive: true }).effective).toBeNull();
    expect(resolveClassifier({ selected: 'openrouter', customEndpoint, vercelKey: 'v', zenPromotionActive: true }).effective).toBe('custom');
    expect(resolveClassifier({ selected: 'zen-key', typesafeKey: 'k', customEndpoint, zenPromotionActive: true }).effective).toBe('typesafe');
    expect(resolveClassifier({ selected: 'off', customEndpoint, zenPromotionActive: true }).effective).toBeNull();
  });
});

describe('readOpenCodeKeys', () => {
  const env = { OPENROUTER_API_KEY: 'or-env', AI_GATEWAY_API_KEY: ' gw-env ' };

  it('prefers a key saved in OpenCode and falls back to the variable OpenCode reads', () => {
    const readAuth = () => ({
      opencode: { type: 'api', key: 'zen' },
      openrouter: { type: 'api', key: 'or-saved' },
      vercel: { type: 'oauth', access: 'a', refresh: 'r', expires: 0 },
    });
    expect(readOpenCodeKeys({ readAuth, env })).toEqual({ zenKey: 'zen', openrouterKey: 'or-saved', vercelKey: 'gw-env' });
  });

  it('keeps the variables when the credential store cannot be read, and ignores blank ones', () => {
    const readAuth = () => { throw new Error('locked'); };
    expect(readOpenCodeKeys({ readAuth, env })).toEqual({ zenKey: null, openrouterKey: 'or-env', vercelKey: 'gw-env' });
    expect(readOpenCodeKeys({ readAuth: () => ({}), env: { OPENROUTER_API_KEY: '  ' } })).toEqual({ zenKey: null, openrouterKey: null, vercelKey: null });
  });
});

describe('auto sessions', () => {
  it('remembers the sentinel selection and forgets it when a real model is chosen', () => {
    const { runtime } = makeRuntime({ answers: {} });
    expect(runtime.isAutoSession('s1')).toBe(false);
    expect(runtime.noteModelSelection('s1', AUTO, '/repo')).toBe(true);
    expect(runtime.isAutoSession('s1')).toBe(true);
    expect(runtime.noteModelSelection('s1', { providerID: 'anthropic', id: 'claude-opus-5' }, '/repo')).toBe(false);
    expect(runtime.isAutoSession('s1')).toBe(false);
  });
});

describe('evaluatePermission', () => {
  const permission = { id: 'p1', sessionID: 's1', action: 'shell', resources: ['git push --force'], metadata: { command: 'git push --force origin main' } };

  it('sends the action and resources from a translated v2 request without relying on metadata', async () => {
    const [event] = translateWireEvent({
      type: 'permission.asked',
      data: { id: 'p1', sessionID: 's1', action: 'shell', resources: ['git push --force origin main'] },
    });
    const { runtime, jev } = makeRuntime({ answers: { ask: { noul: 0.9 } } });
    await runtime.evaluatePermission(event.properties, '/repo');
    const request = JSON.parse(JSON.stringify(jev.ask.mock.calls[0][0]));
    expect(request.state.permission).toEqual({ type: 'shell', patterns: ['git push --force origin main'] });
  });

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

  it('accepts a safe permission', async () => {
    const { runtime } = makeRuntime({ answers: { ask: { noul: 0.1 }, kind: { choice: 'read_only' } } });
    expect(await runtime.evaluatePermission(permission, '/repo')).toEqual({ action: 'accept', score: 0.1, kind: 'read_only' });
  });

  it('holds when Jev is unreachable, tells the UI why, and asks again next time', async () => {
    const { runtime, events, jev } = makeRuntime({ askError: Object.assign(new Error('Jev timed out after 4000ms'), { code: 'timeout' }) });
    expect(await runtime.evaluatePermission(permission, '/repo')).toEqual({ action: 'hold', skipped: 'Jev timed out after 4000ms' });
    expect(events.at(-1)).toMatchObject({ type: 'openchamber:routing.safety-skipped', properties: { permissionId: 'p1', error: 'Jev timed out after 4000ms' } });
    await runtime.evaluatePermission(permission, '/repo');
    expect(jev.ask).toHaveBeenCalledTimes(2);
    expect(runtime.heldPermissions()).toEqual([]);
  });

  it('holds quietly without asking when no classification provider is usable', async () => {
    const { runtime, jev, events } = makeRuntime({ token: null, zenPromotionActive: false, answers: {} });
    expect(await runtime.evaluatePermission(permission, '/repo')).toEqual({ action: 'hold', unavailable: true });
    expect(jev.ask).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it('works whether or not Auto routing is on', async () => {
    const config = readyConfig();
    config.enabled = false;
    config.safetyNet.enabled = false;
    const { runtime, jev } = makeRuntime({ config, answers: { ask: { noul: 0.9 } } });
    expect(await runtime.evaluatePermission(permission, '/repo')).toMatchObject({ action: 'hold', score: 0.9 });
    expect(jev.ask).toHaveBeenCalledTimes(1);
  });

  it('reads the old global safety-net switch for the policy conversion', async () => {
    expect(await makeRuntime({ answers: {} }).runtime.legacySafetyNetEnabled()).toBe(true);
    const off = readyConfig();
    off.safetyNet.enabled = false;
    expect(await makeRuntime({ config: off, answers: {} }).runtime.legacySafetyNetEnabled()).toBe(false);
  });

  it.each(['hold', 'error'])('discards a late classifier %s after an authoritative manual reply', async (completion) => {
    const { runtime, jev, events } = makeRuntime({ answers: { ask: { noul: 0.1 } } });
    let resolveAnswer;
    let rejectAnswer;
    const answer = new Promise((resolve, reject) => { resolveAnswer = resolve; rejectAnswer = reject; });
    jev.ask.mockImplementationOnce(() => answer);
    let emit;
    let evaluation;
    const fetchImpl = vi.fn(async () => Response.json([]));
    const permissions = createPermissionAutoAcceptRuntime({
      globalEventHub: {
        subscribeEvent(handler) { emit = (payload) => handler({ translated: () => [payload] }); return () => {}; },
        subscribeStatus() { return () => {}; },
      },
      buildOpenCodeUrl: (path) => `http://opencode.test${path}`,
      getOpenCodeAuthHeaders: () => ({}),
      readSettingsFromDiskMigrated: async () => ({ permissionAutoAccept: { sessions: { s1: 'safety' } } }),
      persistSettings: async () => {},
      broadcastPermissionReviewEvent: vi.fn(),
      evaluatePermission: (...args) => { evaluation = runtime.evaluatePermission(...args); return evaluation; },
      onPermissionReplied: runtime.forgetPermission,
      fetchImpl,
    });
    const stop = permissions.start();
    try {
      const task = permissions.processPermission(permission, '/repo');
      await vi.waitFor(() => expect(jev.ask).toHaveBeenCalledTimes(1));
      const signal = jev.ask.mock.calls[0][2];
      emit({ type: 'permission.replied', properties: { requestID: 'p1' } });
      await task;
      expect(signal.aborted).toBe(true);
      if (completion === 'hold') resolveAnswer({ answers: { ask: { noul: 0.9 } } });
      else rejectAnswer(new Error('late classifier failure'));
      await evaluation;
      expect(events).toEqual([]);
      expect(runtime.heldPermissions()).toEqual([]);
      expect(fetchImpl.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(0);
      // A fresh call must ask again, proving cancellation did not refill cache.
      expect(await runtime.evaluatePermission(permission, '/repo')).toMatchObject({ action: 'accept' });
      expect(jev.ask).toHaveBeenCalledTimes(2);
    } finally {
      stop();
    }
  });

  it('does not start classification if cancelled while access is resolving', async () => {
    const { runtime, store, jev, events } = makeRuntime({ answers: { ask: { noul: 0.9 } } });
    let resolveConfig;
    store.readConfig.mockImplementationOnce(() => new Promise((resolve) => { resolveConfig = resolve; }));
    const controller = new AbortController();
    const task = runtime.evaluatePermission(permission, '/repo', controller.signal);
    controller.abort();
    resolveConfig(readyConfig());
    await expect(task).resolves.toEqual({ action: 'hold' });
    expect(jev.ask).not.toHaveBeenCalled();
    expect(events).toEqual([]);
    expect(runtime.heldPermissions()).toEqual([]);
  });
});

describe('Jev cancellation', () => {
  const endpoint = { url: 'https://classifier.test/systemone', headers: {}, model: 'jev-test' };

  it('aborts outbound HTTP and clears its timeout on caller cancellation', async () => {
    vi.useFakeTimers();
    try {
      let requestSignal;
      const fetchImpl = vi.fn((_url, { signal }) => {
        requestSignal = signal;
        return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      });
      const controller = new AbortController();
      const task = createJevClient({ fetchImpl }).ask({}, endpoint, controller.signal);
      const rejected = expect(task).rejects.toMatchObject({ name: 'AbortError' });
      controller.abort();
      await rejected;
      expect(requestSignal.aborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps its own timeout distinct from caller cancellation', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn((_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })));
      const controller = new AbortController();
      const task = createJevClient({ fetchImpl, timeoutMs: 100 }).ask({}, endpoint, controller.signal);
      const rejected = expect(task).rejects.toMatchObject({ code: 'timeout', message: 'Jev timed out after 100ms' });
      await vi.advanceTimersByTimeAsync(100);
      await rejected;
      expect(controller.signal.aborted).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('still publishes the safety-skipped warning for a real classifier timeout', async () => {
    vi.useFakeTimers();
    try {
      let markStarted;
      const started = new Promise((resolve) => { markStarted = resolve; });
      const fetchImpl = (_url, { signal }) => {
        markStarted();
        return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      };
      const { runtime, jev, events } = makeRuntime();
      jev.ask = createJevClient({ fetchImpl, timeoutMs: 100 }).ask;
      const task = runtime.evaluatePermission({ id: 'timeout', sessionID: 's1' }, '/repo', new AbortController().signal);
      await started;
      await vi.advanceTimersByTimeAsync(100);
      await expect(task).resolves.toEqual({ action: 'hold', skipped: 'Jev timed out after 100ms' });
      expect(events).toEqual([{
        type: 'openchamber:routing.safety-skipped',
        properties: { permissionId: 'timeout', sessionId: 's1', directory: '/repo', error: 'Jev timed out after 100ms' },
      }]);
      expect(runtime.heldPermissions()).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('classifier pick', () => {
  it('stores a known source and refuses an unknown one', async () => {
    const { runtime, store } = makeRuntime({ answers: {} });
    await runtime.setClassifierSource('zen-key');
    expect(store.writeClassifierSource).toHaveBeenCalledWith('zen-key');
    await runtime.setClassifierSource('openrouter');
    expect(store.writeClassifierSource).toHaveBeenCalledWith('openrouter');
    await runtime.setClassifierSource('off');
    expect(store.writeClassifierSource).toHaveBeenCalledWith('off');
    await expect(runtime.setClassifierSource('cloudflare')).rejects.toMatchObject({ status: 400 });
  });

  it('keeps Jev off in enterprise mode, whatever is picked or saved', async () => {
    const { runtime, store, jev } = makeRuntime({ enterprise: true, classifierSource: 'typesafe', answers: { ask: { noul: 0.1 } } });
    expect(await runtime.describe()).toMatchObject({ enterpriseMode: true, jevAvailable: false, autoReady: false, classification: { selected: 'off', effective: null } });
    expect(await runtime.classifierEndpoint()).toBeNull();
    await expect(runtime.setClassifierSource('zen-promo')).rejects.toMatchObject({ status: 403 });
    await expect(runtime.setToken('secret')).rejects.toMatchObject({ status: 403 });
    await runtime.setClassifierSource('off');
    expect(store.writeClassifierSource).toHaveBeenCalledTimes(1);
    expect(store.writeToken).not.toHaveBeenCalled();
    expect(jev.ask).not.toHaveBeenCalled();
  });

  describe('an endpoint pinned in the server environment', () => {
    const pinned = { url: 'https://jev.company.test/v1/systemone', model: 'jev-latest', key: 'org-secret' };
    const saved = { url: 'https://mine.example.com/v1/systemone', model: 'jev-latest' };

    it('replaces the saved one, cannot be edited, and never shows its key', async () => {
      const { runtime, store } = makeRuntime({ pinned, customEndpoint: saved, classifierSource: 'custom', answers: {} });
      const state = await runtime.describe();
      expect(state.customEndpoint).toEqual({ url: pinned.url, model: 'jev-latest', keyPresent: true, pinned: true });
      expect(JSON.stringify(state)).not.toContain('org-secret');
      expect(await runtime.classifierEndpoint()).toMatchObject({ url: pinned.url, headers: { authorization: 'Bearer org-secret' } });
      await expect(runtime.setCustomEndpoint({ url: saved.url, model: 'x' })).rejects.toMatchObject({ status: 409 });
      await expect(runtime.clearCustomEndpoint()).rejects.toMatchObject({ status: 409 });
      expect(store.writeCustomEndpoint).not.toHaveBeenCalled();
    });

    it('is the enterprise default, with Off as the only other choice', async () => {
      const { runtime, store } = makeRuntime({ enterprise: true, pinned, classifierSource: 'typesafe', answers: {} });
      expect(await runtime.describe()).toMatchObject({ jevAvailable: true, classification: { selected: 'custom', effective: 'custom' } });
      await runtime.setClassifierSource('custom');
      await runtime.setClassifierSource('off');
      await expect(runtime.setClassifierSource('typesafe')).rejects.toMatchObject({ status: 403 });
      expect(store.writeClassifierSource.mock.calls.map(([source]) => source)).toEqual(['custom', 'off']);

      const off = makeRuntime({ enterprise: true, pinned, classifierSource: 'off', answers: {} });
      expect(await off.runtime.describe()).toMatchObject({ jevAvailable: false, classification: { selected: 'off' } });
    });
  });

  it('picks TypeSafe when a key is saved', async () => {
    const { runtime, store } = makeRuntime({ answers: {} });
    await runtime.setToken('secret');
    expect(store.writeClassifierSource).toHaveBeenCalledWith('typesafe');
  });

  it('saves a custom endpoint with its URL normalized and picks it', async () => {
    const { runtime, store } = makeRuntime({ answers: {} });
    await runtime.setCustomEndpoint({ url: 'https://jev.example.com/v1/', model: ' jev-latest ', key: ' own-secret ' });
    expect(store.writeCustomEndpoint).toHaveBeenCalledWith({ url: 'https://jev.example.com/v1/systemone', model: 'jev-latest', key: 'own-secret' });
    expect(store.writeClassifierSource).toHaveBeenCalledWith('custom');
  });

  it('keeps the saved custom key when none is sent, and removes it on null', async () => {
    const saved = { url: 'https://jev.example.com/v1/systemone', model: 'jev-latest', key: 'own-secret' };
    const { runtime, store } = makeRuntime({ customEndpoint: saved, answers: {} });
    await runtime.setCustomEndpoint({ url: saved.url, model: 'jev-1.13', key: '' });
    expect(store.writeCustomEndpoint).toHaveBeenLastCalledWith({ ...saved, model: 'jev-1.13' });
    await runtime.setCustomEndpoint({ url: saved.url, model: 'jev-1.13' });
    expect(store.writeCustomEndpoint).toHaveBeenLastCalledWith({ ...saved, model: 'jev-1.13' });
    const picksBefore = store.writeClassifierSource.mock.calls.length;
    await runtime.setCustomEndpoint({ url: saved.url, model: 'jev-1.13', key: null });
    expect(store.writeCustomEndpoint).toHaveBeenLastCalledWith({ url: saved.url, model: 'jev-1.13' });
    // Removing the key alone leaves whatever provider the user picked.
    expect(store.writeClassifierSource).toHaveBeenCalledTimes(picksBefore);
  });

  it('refuses a custom endpoint without a URL or model, or with an unsafe URL, and saves nothing', async () => {
    const { runtime, store } = makeRuntime({ answers: {} });
    await expect(runtime.setCustomEndpoint({ url: 'https://jev.example.com', model: '' })).rejects.toMatchObject({ status: 400 });
    await expect(runtime.setCustomEndpoint({ model: 'jev-latest' })).rejects.toMatchObject({ status: 400 });
    await expect(runtime.setCustomEndpoint({ url: 'file:///etc/hosts', model: 'jev-latest' })).rejects.toMatchObject({ status: 400 });
    await expect(runtime.setCustomEndpoint({ url: 'https://me:pw@jev.example.com', model: 'jev-latest' })).rejects.toMatchObject({ status: 400 });
    expect(store.writeCustomEndpoint).not.toHaveBeenCalled();
    expect(store.writeClassifierSource).not.toHaveBeenCalled();
  });

  it('refuses a custom endpoint in enterprise mode', async () => {
    const { runtime, store } = makeRuntime({ enterprise: true, answers: {} });
    await expect(runtime.setCustomEndpoint({ url: 'https://jev.example.com', model: 'jev-latest', key: 'k' })).rejects.toMatchObject({ status: 403 });
    await expect(runtime.setClassifierSource('custom')).rejects.toMatchObject({ status: 403 });
    expect(store.writeCustomEndpoint).not.toHaveBeenCalled();
    await runtime.clearCustomEndpoint();
    expect(store.clearCustomEndpoint).toHaveBeenCalledTimes(1);
  });

  it('keeps Jev off in enterprise mode even with a custom endpoint picked', async () => {
    const customEndpoint = { url: 'https://jev.example.com/v1/systemone', model: 'jev-latest' };
    const { runtime } = makeRuntime({ enterprise: true, token: null, classifierSource: 'custom', customEndpoint, answers: {} });
    expect(await runtime.classifierEndpoint()).toBeNull();
  });
});

describe('describe', () => {
  it('reports Auto ready with an enabled config, a fallback and two categories, key or no key', async () => {
    expect((await makeRuntime({ answers: {} }).runtime.describe())).toMatchObject({ autoReady: true, tokenPresent: true, jevSource: 'typesafe' });
    // Without a key, a picked promotion answers, so Auto stays available.
    expect((await makeRuntime({ token: null, classifierSource: 'zen-promo', answers: {} }).runtime.describe())).toMatchObject({ autoReady: true, jevAvailable: true, tokenPresent: false, jevSource: 'zen-free' });
    // Nothing picked and no key: off, so no Jev and no Auto.
    expect((await makeRuntime({ token: null, answers: {} }).runtime.describe())).toMatchObject({
      autoReady: false,
      jevAvailable: false,
      classification: { selected: 'off', effective: null },
    });
    // No usable classification provider: no Jev, so no Auto.
    expect((await makeRuntime({ token: null, classifierSource: 'zen-promo', zenPromotionActive: false, answers: {} }).runtime.describe())).toMatchObject({
      autoReady: false,
      jevAvailable: false,
      classifier: { selected: 'zen-promo', effective: null },
    });
    const one = readyConfig();
    one.categories = one.categories.map((c, i) => ({ ...c, enabled: i === 0 }));
    expect((await makeRuntime({ config: one, answers: {} }).runtime.describe()).autoReady).toBe(false);
  });

  it('keeps `classifier` parseable for v2.0.2 clients and puts the full picture in `classification`', async () => {
    const zen = await makeRuntime({ token: null, classifierSource: 'zen-promo', answers: {} }).runtime.describe();
    expect(zen.classifier.sources.map((s) => s.id)).toEqual(['zen-promo', 'zen-key', 'typesafe']);
    expect(zen.classification.sources.map((s) => s.id)).toEqual(['off', 'zen-promo', 'zen-key', 'openrouter', 'vercel', 'typesafe', 'custom']);

    const off = await makeRuntime({ token: null, answers: {} }).runtime.describe();
    expect(off.classifier).toBeNull();

    const routed = await makeRuntime({ classifierSource: 'openrouter', providerKeys: { openrouterKey: 'o' }, answers: {} }).runtime.describe();
    expect(routed.classifier).toBeNull();
    expect(routed.classification).toMatchObject({ selected: 'openrouter', effective: 'openrouter' });
    expect(routed.jevAvailable).toBe(true);
  });

  it('describes a custom endpoint without its key and hides it from v2.0.2 clients', async () => {
    const customEndpoint = { url: 'https://jev.example.com/v1/systemone', model: 'jev-latest', key: 'own-secret' };
    const state = await makeRuntime({ token: null, classifierSource: 'custom', customEndpoint, answers: {} }).runtime.describe();
    expect(state.customEndpoint).toEqual({ url: customEndpoint.url, model: 'jev-latest', keyPresent: true, pinned: false });
    expect(JSON.stringify(state)).not.toContain('own-secret');
    expect(state.classifier).toBeNull();
    expect(state.classification).toMatchObject({ selected: 'custom', effective: 'custom' });
    expect(state.jevAvailable).toBe(true);

    // Falling back onto the custom endpoint hides the legacy view too.
    const fallback = await makeRuntime({ token: null, classifierSource: 'zen-key', customEndpoint, answers: {} }).runtime.describe();
    expect(fallback.classification.effective).toBe('custom');
    expect(fallback.classifier).toBeNull();

    const none = await makeRuntime({ token: null, answers: {} }).runtime.describe();
    expect(none.customEndpoint).toBeNull();
    expect(none.classification.sources.find((s) => s.id === 'custom')).toEqual({ id: 'custom', usable: false });
  });
});
