import { describe, expect, it, vi } from 'vitest';
import { createRoutingRuntime, readOpenCodeKeys, requestTextOf } from './runtime.js';
import { resolveEffectiveConfig } from './store.js';
import { excerptHead, excerptHeadTail, turnsToHistory } from './history.js';
import { createJevClient, decidePermission, decideRouting } from './jev.js';
import { classifierEndpoint, parseCustomEndpointUrl, resolveClassifier } from './classifier.js';

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

const makeRuntime = ({ config = readyConfig(), token = 'key', classifierSource = null, customEndpoint = null, providerKeys = {}, zenPromotionActive = true, enterprise = false, pinned = null, catalog = [], answers, askError } = {}) => {
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
    listCatalogModels: async () => {
      if (catalog instanceof Error) throw catalog;
      return catalog;
    },
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

  it('drops a saved variant the model does not list, such as a list position saved before #4133', async () => {
    const config = readyConfig();
    config.fallback = { model: FALLBACK.model, variant: '2' };
    const catalog = [{ providerID: 'anthropic', modelID: 'claude-sonnet-5', variants: [{ id: 'low' }, { id: 'high' }] }];
    const { runtime, events } = makeRuntime({ config, catalog, answers: { category: { choice: 'trivial', confidence: 0.99 } } });
    const resolved = await runtime.resolveAutoSelection(send());
    expect(resolved.model).toEqual({ providerID: 'anthropic', id: 'claude-sonnet-5' });
    expect(resolved.decision.variant).toBeNull();
    expect(events.at(-1).properties.variant).toBeNull();
  });

  it('keeps a known variant, and any variant when the catalog cannot vouch for the model', async () => {
    const known = makeRuntime({
      catalog: [{ providerID: 'anthropic', modelID: 'claude-sonnet-5', variants: [{ id: 'medium' }] }],
      answers: { category: { choice: 'trivial', confidence: 0.99 } },
    });
    expect((await known.runtime.resolveAutoSelection(send())).model.variant).toBe('medium');

    const unknownModel = makeRuntime({ catalog: [], answers: { category: { choice: 'trivial', confidence: 0.99 } } });
    expect((await unknownModel.runtime.resolveAutoSelection(send())).model.variant).toBe('medium');

    const unreachable = makeRuntime({ catalog: new Error('OpenCode down'), answers: { category: { choice: 'trivial', confidence: 0.99 } } });
    expect((await unreachable.runtime.resolveAutoSelection(send())).model.variant).toBe('medium');
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

describe('parseCustomEndpointUrl', () => {
  it('keeps the pasted URL exactly, appending nothing to its path', () => {
    expect(parseCustomEndpointUrl(' https://openrouter.ai/api/v1/systemone ')).toBe('https://openrouter.ai/api/v1/systemone');
    expect(parseCustomEndpointUrl('https://proxy.company.internal/v1/decision')).toBe('https://proxy.company.internal/v1/decision');
    expect(parseCustomEndpointUrl('https://jev.example.com/v1')).toBe('https://jev.example.com/v1');
    expect(parseCustomEndpointUrl('http://127.0.0.1:8080/jev/?team=a#frag')).toBe('http://127.0.0.1:8080/jev/?team=a');
  });

  it('refuses other schemes, credentials in the URL and non-URLs', () => {
    expect(() => parseCustomEndpointUrl('ftp://example.com')).toThrow(expect.objectContaining({ status: 400 }));
    expect(() => parseCustomEndpointUrl('file:///etc/passwd')).toThrow(expect.objectContaining({ status: 400 }));
    expect(() => parseCustomEndpointUrl('https://user:secret@example.com/v1')).toThrow(expect.objectContaining({ status: 400 }));
    expect(() => parseCustomEndpointUrl('example.com/v1')).toThrow(expect.objectContaining({ status: 400 }));
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

  it('prefers a key saved in OpenCode and falls back to the variable OpenCode reads', async () => {
    const readAuth = () => ({
      opencode: { type: 'api', key: 'zen' },
      openrouter: { type: 'api', key: 'or-saved' },
      vercel: { type: 'oauth', access: 'a', refresh: 'r', expires: 0 },
    });
    expect(await readOpenCodeKeys({ readAuth, env })).toEqual({ zenKey: 'zen', openrouterKey: 'or-saved', vercelKey: 'gw-env' });
  });

  it('keeps the variables when the credential store cannot be read, and ignores blank ones', async () => {
    const readAuth = () => { throw new Error('locked'); };
    expect(await readOpenCodeKeys({ readAuth, env })).toEqual({ zenKey: null, openrouterKey: 'or-env', vercelKey: 'gw-env' });
    expect(await readOpenCodeKeys({ readAuth: () => ({}), env: { OPENROUTER_API_KEY: '  ' } })).toEqual({ zenKey: null, openrouterKey: null, vercelKey: null });
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
  // The v2 shape permission auto-accept hands over: `action` and `resources`.
  const permission = { id: 'p1', sessionID: 's1', action: 'bash', resources: ['git push --force'], metadata: { command: 'git push --force origin main' } };

  it('tells Jev what the request does and to what', async () => {
    const { runtime, jev } = makeRuntime({ answers: { ask: { noul: 0.1 }, kind: { choice: 'read_only' } } });
    await runtime.evaluatePermission(permission, '/repo');
    expect(jev.ask.mock.calls[0][0].state.permission).toEqual({
      type: 'bash',
      patterns: ['git push --force'],
      metadata: { command: 'git push --force origin main' },
    });
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

  it('saves a custom endpoint with its URL as pasted and picks it', async () => {
    const { runtime, store } = makeRuntime({ answers: {} });
    await runtime.setCustomEndpoint({ url: ' https://jev.example.com/v1/decision ', model: ' jev-latest ', key: ' own-secret ' });
    expect(store.writeCustomEndpoint).toHaveBeenCalledWith({ url: 'https://jev.example.com/v1/decision', model: 'jev-latest', key: 'own-secret' });
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

describe('testClassifier', () => {
  const probe = { choice: 'blue', confidence: 0.98 };

  it('reports the source, model and round trip of the provider answering now', async () => {
    const { runtime, jev, store } = makeRuntime({ classifierSource: 'typesafe', answers: { probe } });
    expect(await runtime.testClassifier()).toEqual({ ok: true, source: 'typesafe', model: expect.any(String), ms: 12 });
    expect(jev.ask.mock.calls[0][1].headers.authorization).toBe('Bearer key');
    expect(store.writeClassifierSource).not.toHaveBeenCalled();
  });

  it('names the failure: HTTP status, timeout, unparsable answer, nothing usable', async () => {
    const http = makeRuntime({ classifierSource: 'typesafe', askError: Object.assign(new Error('Jev responded 401'), { status: 401 }) });
    expect(await http.runtime.testClassifier()).toMatchObject({ ok: false, reason: 'http', status: 401, source: 'typesafe' });
    const timeout = makeRuntime({ classifierSource: 'typesafe', askError: Object.assign(new Error('timed out'), { code: 'timeout' }) });
    expect(await timeout.runtime.testClassifier()).toMatchObject({ ok: false, reason: 'timeout' });
    const garbled = makeRuntime({ classifierSource: 'typesafe', answers: { probe: { nope: true } } });
    expect(await garbled.runtime.testClassifier()).toMatchObject({ ok: false, reason: 'unparsable' });
    const off = makeRuntime({ classifierSource: 'off' });
    expect(await off.runtime.testClassifier()).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('tests typed custom endpoint fields without saving them, reusing the saved key when the field is empty', async () => {
    const { runtime, jev, store } = makeRuntime({
      customEndpoint: { url: 'https://old.example/v1/decision', model: 'm', key: 'saved' },
      answers: { probe },
    });
    const result = await runtime.testClassifier({ url: 'https://new.example/v1/decision', model: 'jev-x', key: '' });
    expect(result).toMatchObject({ ok: true, source: 'custom', model: 'jev-x' });
    expect(jev.ask.mock.calls[0][1]).toMatchObject({ url: 'https://new.example/v1/decision', headers: { authorization: 'Bearer saved' } });
    expect(store.writeCustomEndpoint).not.toHaveBeenCalled();
  });

  it('refuses typed endpoints in enterprise mode', async () => {
    const { runtime } = makeRuntime({ enterprise: true });
    await expect(runtime.testClassifier({ url: 'https://x.example', model: 'm' })).rejects.toMatchObject({ status: 403 });
  });
});
