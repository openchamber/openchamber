import fs from 'fs';
import { registerSmallModelRoutes } from './routes.js';
import http from 'node:http';
import os from 'os';
import path from 'path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

// The settings override is read straight from disk, so without this the suite
// would resolve whatever small model the developer running it has configured.
const TEMP_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'small-model-settings-'));
process.env.OPENCHAMBER_DATA_DIR = TEMP_DATA_DIR;

const { generateSmallModelText, describeSmallModel, listAuthenticatedProviders, setUnavailableRetryDelaysForTest } = await import('./index.js');
const { configureOpenCodeRuntimeProviders, resetOpenCodeRuntimeProviders } = await import('./client.js');

// A real OpenCode stub over HTTP. The module talks to OpenCode through
// `@opencode/client`, so driving it with a socket exercises the same request
// shapes the running server sees — no module substitution involved.
const state = {
  models: [],
  providers: [],
  defaultModel: null,
  // The model OpenCode's `title` agent carries from config, or null for none.
  titleModel: null,
  // OpenCode answers 404 for `title` while a cold location loads its agents.
  titleMissing: false,
  generate: () => ({ text: 'generated' }),
  requests: [],
  generateErrors: [],
};

const MODEL = (overrides = {}) => ({
  id: 'claude-haiku-4-5',
  modelID: 'claude-haiku-4-5',
  providerID: 'anthropic',
  name: 'Claude Haiku',
  enabled: true,
  limit: { context: 8_000, output: 4_000 },
  ...overrides,
});

const LOCATION = { directory: '/proj', project: { id: 'p', directory: '/proj', canonical: '/proj' } };

let server;
let baseUrl;

const readBody = (req) => new Promise((resolve) => {
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    try {
      resolve(raw ? JSON.parse(raw) : {});
    } catch {
      resolve({});
    }
  });
});

beforeAll(async () => {
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const body = req.method === 'POST' ? await readBody(req) : {};
    state.requests.push({ method: req.method, path: url.pathname, body, headers: req.headers });
    const send = (payload) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    if (url.pathname === '/api/model') return send({ location: LOCATION, data: state.models });
    if (url.pathname === '/api/model/default') return send({ location: LOCATION, data: state.defaultModel });
    if (url.pathname === '/api/provider') return send({ location: LOCATION, data: state.providers });
    if (url.pathname === '/api/agent/title') {
      if (state.titleMissing) {
        res.writeHead(404, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ _tag: 'AgentNotFoundError', agentID: 'title', message: 'Agent not found: title' }));
      }
      const agent = {
        id: 'title',
        name: 'Title',
        request: { settings: {}, headers: {}, body: {} },
        mode: 'primary',
        hidden: true,
        permissions: [],
      };
      if (state.titleModel) agent.model = state.titleModel;
      return send({ location: LOCATION, data: agent });
    }
    if (url.pathname === '/api/experimental/generate') {
      const error = state.generateErrors.shift();
      if (error) {
        res.writeHead(400, { 'content-type': 'application/json' });
        return res.end(JSON.stringify(error));
      }
      return send({ location: LOCATION, data: state.generate(body) });
    }
    res.writeHead(404).end('{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => {
  server?.close();
  fs.rmSync(TEMP_DATA_DIR, { recursive: true, force: true });
});

beforeEach(() => {
  state.models = [MODEL()];
  state.providers = [{ id: 'anthropic', name: 'Anthropic', activation: 'auto', package: 'x' }];
  state.defaultModel = MODEL();
  state.titleModel = null;
  state.titleMissing = false;
  state.generate = () => ({ text: 'generated' });
  state.requests = [];
  state.generateErrors = [];
  configureOpenCodeRuntimeProviders({
    buildOpenCodeUrl: (requestPath) => `${baseUrl}${requestPath.startsWith('/') ? requestPath : `/${requestPath}`}`,
    getOpenCodeAuthHeaders: () => ({ Authorization: 'Basic test' }),
  });
  resetOpenCodeRuntimeProviders();
});

const lastGenerate = () => state.requests.filter((entry) => entry.path === '/api/experimental/generate').at(-1);

describe('generateSmallModelText', () => {
  const unavailable = { _tag: 'InvalidRequestError', message: 'Model unavailable: zai-coding-plan/glm-5.3-flash' };
  const options = { prompt: 'write a commit', model: 'zai-coding-plan/glm-5.3-flash' };

  beforeEach(() => setUnavailableRetryDelaysForTest([1, 1, 1]));
  afterEach(() => setUnavailableRetryDelaysForTest());

  it('retries a cold catalog with the same model and prompt', async () => {
    state.generateErrors = [unavailable];
    const result = await generateSmallModelText(options);
    expect(result.text).toBe('generated');
    const calls = state.requests.filter((entry) => entry.path === '/api/experimental/generate');
    expect(calls).toHaveLength(2);
    expect(calls[0].body).toEqual(calls[1].body);
  });

  it('keeps backing off while the plugin model loads', async () => {
    state.generateErrors = [unavailable, unavailable, unavailable];
    const result = await generateSmallModelText(options);
    expect(result.text).toBe('generated');
    expect(state.requests.filter((entry) => entry.path === '/api/experimental/generate')).toHaveLength(4);
  });

  it('reports persistent model unavailability once the backoff runs out', async () => {
    state.generateErrors = [unavailable, unavailable, unavailable, unavailable];
    await expect(generateSmallModelText(options)).rejects.toMatchObject({
      message: unavailable.message, statusCode: 503, code: 'small-model-unavailable',
    });
    expect(state.requests.filter((entry) => entry.path === '/api/experimental/generate')).toHaveLength(4);
  });

  it('does not retry other invalid requests', async () => {
    state.generateErrors = [{ _tag: 'InvalidRequestError', message: 'Invalid prompt' }];
    await expect(generateSmallModelText(options)).rejects.toMatchObject({ message: 'Invalid prompt' });
    expect(state.requests.filter((entry) => entry.path === '/api/experimental/generate')).toHaveLength(1);
  });

  it('does not retry provider failures with the same message', async () => {
    state.generateErrors = [{ _tag: 'ServiceUnavailableError', message: unavailable.message }];
    await expect(generateSmallModelText(options)).rejects.toMatchObject({ _tag: 'ServiceUnavailableError' });
    expect(state.requests.filter((entry) => entry.path === '/api/experimental/generate')).toHaveLength(1);
  });

  it('cancels without sending the retry', async () => {
    setUnavailableRetryDelaysForTest();
    const controller = new AbortController();
    state.generateErrors = [unavailable];
    const pending = generateSmallModelText({ ...options, signal: controller.signal });
    const timer = setTimeout(() => controller.abort(), 100);
    try {
      await expect(pending).rejects.toThrow();
      expect(state.requests.filter((entry) => entry.path === '/api/experimental/generate')).toHaveLength(1);
    } finally {
      clearTimeout(timer);
    }
  });

  it('honors the timeout during the retry delay', async () => {
    setUnavailableRetryDelaysForTest();
    state.generateErrors = [unavailable];
    await expect(generateSmallModelText({ ...options, timeoutMs: 100 })).rejects.toThrow();
    expect(state.requests.filter((entry) => entry.path === '/api/experimental/generate')).toHaveLength(1);
  });

  it('sends the prompt to /api/generate on the resolved model', async () => {
    const result = await generateSmallModelText({ prompt: 'summarize this', directory: '/proj' });

    // No provider to stay on and no Settings pick: OpenCode's default.
    expect(result).toMatchObject({ text: 'generated', providerID: 'anthropic', modelID: 'claude-haiku-4-5', source: 'default' });
    expect(lastGenerate().body).toEqual({
      prompt: 'summarize this',
      model: { id: 'claude-haiku-4-5', providerID: 'anthropic' },
    });
  });

  it('scopes the request to the directory', async () => {
    await generateSmallModelText({ prompt: 'hi', directory: '/proj/sub dir' });

    expect(lastGenerate().headers['x-opencode-directory']).toBe(encodeURIComponent('/proj/sub dir'));
  });

  // The model lists are read through a location; without a directory OpenCode
  // would start its own working directory, MCP servers included.
  it('scopes a request without a directory to the server default', async () => {
    configureOpenCodeRuntimeProviders({
      buildOpenCodeUrl: (requestPath) => `${baseUrl}${requestPath.startsWith('/') ? requestPath : `/${requestPath}`}`,
      getOpenCodeAuthHeaders: () => ({ Authorization: 'Basic test' }),
      getDefaultDirectory: () => '/last/project',
    });

    await generateSmallModelText({ prompt: 'hi' });

    const unscoped = state.requests.filter((entry) => entry.headers['x-opencode-directory'] !== encodeURIComponent('/last/project'));
    expect(unscoped).toEqual([]);
  });

  it('leads the prompt with the system instructions', async () => {
    await generateSmallModelText({ prompt: 'the task', system: 'you are terse', directory: '/proj' });

    expect(lastGenerate().body.prompt).toBe('you are terse\n\nthe task');
  });

  it('honours an explicit request model', async () => {
    const result = await generateSmallModelText({ prompt: 'hi', model: 'openai/gpt-5.6-luna', directory: '/proj' });

    expect(result.source).toBe('request');
    expect(lastGenerate().body.model).toEqual({ id: 'gpt-5.6-luna', providerID: 'openai' });
  });

  it('sends an explicit Claude Code model like any other', async () => {
    const result = await generateSmallModelText({ prompt: 'hi', model: 'claude-code/haiku', directory: '/proj' });

    expect(result).toMatchObject({ providerID: 'claude-code', modelID: 'haiku', source: 'request' });
    expect(lastGenerate().body.model).toEqual({ id: 'haiku', providerID: 'claude-code' });
  });

  it('falls back to the session model when its provider has no small one', async () => {
    const result = await generateSmallModelText({
      prompt: 'hi',
      directory: '/proj',
      preferredProviderID: 'openai',
      preferredModelID: 'gpt-5.6-luna',
    });

    expect(result).toMatchObject({ providerID: 'openai', modelID: 'gpt-5.6-luna', source: 'session-model' });
  });

  it('prefers the small model of the session provider over the session model itself', async () => {
    state.models = [
      MODEL({ id: 'claude-sonnet-5', modelID: 'claude-sonnet-5', family: 'claude-sonnet' }),
      MODEL({ id: 'claude-haiku-4-5', modelID: 'claude-haiku-4-5', family: 'claude-haiku', time: { released: 1 } }),
      MODEL({ id: 'claude-haiku-5', modelID: 'claude-haiku-5', family: 'claude-haiku', time: { released: 2 } }),
      MODEL({ id: 'claude-haiku-6', modelID: 'claude-haiku-6', family: 'claude-haiku', time: { released: 3 }, status: 'beta' }),
      MODEL({ id: 'gpt-5.6-luna', modelID: 'gpt-5.6-luna', providerID: 'openai', family: 'gpt-luna' }),
    ];

    const result = await generateSmallModelText({
      prompt: 'hi',
      directory: '/proj',
      preferredProviderID: 'anthropic',
      preferredModelID: 'claude-sonnet-5',
    });

    // Newest active haiku of the session provider; the other provider's
    // gpt-luna ranks higher in the family list but is another subscription.
    expect(result).toMatchObject({ providerID: 'anthropic', modelID: 'claude-haiku-5', source: 'session-provider-small' });
    expect(lastGenerate().body.model).toEqual({ id: 'claude-haiku-5', providerID: 'anthropic' });
  });

  it('never takes a small model from another connected provider', async () => {
    state.models = [
      MODEL({ id: 'claude-sonnet-5', modelID: 'claude-sonnet-5', family: 'claude-sonnet' }),
      MODEL({ id: 'gemini-3.6-flash', modelID: 'gemini-3.6-flash', providerID: 'google', family: 'gemini-flash' }),
    ];
    state.defaultModel = state.models[0];

    // Anthropic has no small family here, yet the connected Google flash is
    // not someone's pick for this content.
    const withProvider = await generateSmallModelText({
      prompt: 'hi',
      directory: '/proj',
      preferredProviderID: 'anthropic',
      preferredModelID: 'claude-sonnet-5',
    });
    expect(withProvider).toMatchObject({ providerID: 'anthropic', modelID: 'claude-sonnet-5', source: 'session-model' });

    const withoutProvider = await generateSmallModelText({ prompt: 'hi', directory: '/proj' });
    expect(withoutProvider).toMatchObject({ providerID: 'anthropic', modelID: 'claude-sonnet-5', source: 'default' });
    expect(state.requests.some((entry) => entry.body?.model?.providerID === 'google')).toBe(false);
  });

  it('reads the family from the model id when the catalog has none (custom provider)', async () => {
    state.models = [
      MODEL({ id: 'my-big-model', modelID: 'my-big-model', providerID: 'my-proxy' }),
      MODEL({ id: 'gemini-3.6-flash', modelID: 'gemini-3.6-flash', providerID: 'my-proxy' }),
      MODEL({ id: 'gpt-5.4-nano', modelID: 'gpt-5.4-nano', providerID: 'my-proxy' }),
    ];

    const result = await generateSmallModelText({
      prompt: 'hi',
      directory: '/proj',
      preferredProviderID: 'my-proxy',
      preferredModelID: 'my-big-model',
    });

    expect(result).toMatchObject({ providerID: 'my-proxy', modelID: 'gemini-3.6-flash', source: 'session-provider-small' });
  });

  it('picks Claude Code haiku as the small model like any other provider', async () => {
    state.models = [MODEL({ id: 'haiku', modelID: 'haiku', providerID: 'claude-code', family: 'claude-haiku' })];

    const result = await generateSmallModelText({ prompt: 'hi', directory: '/proj', preferredProviderID: 'claude-code' });

    expect(result).toMatchObject({ providerID: 'claude-code', modelID: 'haiku', source: 'session-provider-small' });
  });

  it('ignores a disabled small model and falls back to the session model', async () => {
    state.models = [
      MODEL({ id: 'claude-sonnet-5', modelID: 'claude-sonnet-5', family: 'claude-sonnet' }),
      MODEL({ id: 'claude-haiku-5', modelID: 'claude-haiku-5', family: 'claude-haiku', enabled: false }),
    ];

    const result = await generateSmallModelText({
      prompt: 'hi',
      directory: '/proj',
      preferredProviderID: 'anthropic',
      preferredModelID: 'claude-sonnet-5',
    });

    expect(result).toMatchObject({ providerID: 'anthropic', modelID: 'claude-sonnet-5', source: 'session-model' });
  });

  it('sends a session title to the small model configured for OpenCode', async () => {
    state.titleModel = { id: 'gpt-5-mini', providerID: 'openai' };

    const result = await generateSmallModelText({
      prompt: 'hi',
      directory: '/proj',
      preferredProviderID: 'anthropic',
      preferredModelID: 'claude-haiku-4-5',
    });

    // Configured on purpose, so it may leave the session provider the way
    // OpenCode's own titles do.
    expect(result).toMatchObject({ providerID: 'openai', modelID: 'gpt-5-mini', source: 'config' });
    expect(lastGenerate().body.model).toEqual({ id: 'gpt-5-mini', providerID: 'openai' });
  });

  // A commit message or a spoken summary names the composer's provider and
  // model; OpenCode's default (its first available model when none is set)
  // can be another provider's.
  it('takes the composer model, not OpenCode\'s default from another provider', async () => {
    state.models = [
      MODEL({ id: 'claude-opus-5', modelID: 'claude-opus-5', family: 'claude-opus' }),
      MODEL({ id: 'gpt-5.6', modelID: 'gpt-5.6', providerID: 'openai', family: 'gpt' }),
    ];
    state.defaultModel = state.models[1];

    const result = await generateSmallModelText({
      prompt: 'hi',
      directory: '/proj',
      preferredProviderID: 'anthropic',
      preferredModelID: 'claude-opus-5',
    });

    expect(result).toMatchObject({ providerID: 'anthropic', modelID: 'claude-opus-5', source: 'session-model' });
    expect(state.requests.some((entry) => entry.body?.model?.providerID === 'openai')).toBe(false);
  });

  it('keeps OpenCode\'s default when it is on the named provider', async () => {
    state.models = [MODEL({ id: 'claude-opus-5', modelID: 'claude-opus-5', family: 'claude-opus' })];
    state.defaultModel = state.models[0];

    const result = await generateSmallModelText({ prompt: 'hi', directory: '/proj', preferredProviderID: 'anthropic' });

    expect(result).toMatchObject({ providerID: 'anthropic', modelID: 'claude-opus-5', source: 'default' });
  });

  it('refuses rather than switch provider when the session has no model of its own', async () => {
    await expect(generateSmallModelText({
      prompt: 'hi',
      directory: '/proj',
      preferredProviderID: 'openai',
    })).rejects.toMatchObject({ statusCode: 404 });
  });

  it('reports a missing OpenCode as no small model', async () => {
    configureOpenCodeRuntimeProviders(null);

    await expect(generateSmallModelText({ prompt: 'hi', directory: '/proj' }))
      .rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('oversized input', () => {
  // 8k context leaves 4k input tokens after the default output reserve → 16k chars.
  const huge = (overrides = {}) => ({ prompt: 'x'.repeat(20_000), directory: '/proj', ...overrides });

  it('truncates and flags the response by default', async () => {
    const result = await generateSmallModelText(huge());

    expect(result.inputTruncated).toBe(true);
    const sent = lastGenerate().body.prompt;
    expect(sent.length).toBeLessThan(20_000);
    expect(sent.endsWith('…')).toBe(true);
  });

  it('refuses without calling the model when the caller cannot survive truncation', async () => {
    await expect(generateSmallModelText(huge({ onOverflow: 'error' }))).rejects.toMatchObject({
      statusCode: 413,
      code: 'context-too-small',
      requiredChars: 20_000,
      availableChars: 16_000,
    });

    expect(lastGenerate()).toBeUndefined();
  });

  it('reserves exactly the requested output budget from the input allowance', async () => {
    state.models = [MODEL({ limit: { context: 100_000, output: 32_000 } })];
    state.defaultModel = state.models[0];

    await expect(generateSmallModelText({
      prompt: 'x'.repeat(304_001),
      directory: '/proj',
      maxOutputTokens: 24_000,
      onOverflow: 'error',
    })).rejects.toMatchObject({ code: 'context-too-small', availableChars: 304_000 });
  });

  it('falls back to a conservative context when OpenCode does not list the model', async () => {
    state.models = [];

    await expect(generateSmallModelText({ prompt: 'x'.repeat(300_000), directory: '/proj', onOverflow: 'error' }))
      .rejects.toMatchObject({ availableChars: 60_000 * 4 });
  });
});

describe('structured output', () => {
  const schema = { type: 'object', properties: { title: { type: 'string' } } };

  it('puts the schema in the prompt and returns the parsed JSON text', async () => {
    state.generate = () => ({ text: '{"title":"ok"}' });

    const result = await generateSmallModelText({ prompt: 'describe', directory: '/proj', responseSchema: schema });

    expect(result.text).toBe('{"title":"ok"}');
    expect(lastGenerate().body.prompt).toContain('Reply with JSON matching this schema and nothing else:');
    expect(lastGenerate().body.prompt).toContain('"title"');
  });

  it('tolerates a json fence', async () => {
    state.generate = () => ({ text: '```json\n{"title":"ok"}\n```' });

    const result = await generateSmallModelText({ prompt: 'describe', directory: '/proj', responseSchema: schema });

    expect(JSON.parse(result.text)).toEqual({ title: 'ok' });
  });

  it('retries once when the reply is not JSON', async () => {
    let calls = 0;
    state.generate = () => {
      calls += 1;
      return { text: calls === 1 ? 'Sure! Here you go.' : '{"title":"ok"}' };
    };

    const result = await generateSmallModelText({ prompt: 'describe', directory: '/proj', responseSchema: schema });

    expect(calls).toBe(2);
    expect(result.text).toBe('{"title":"ok"}');
  });

  it('gives up with structured-output-unsupported after the retry', async () => {
    state.generate = () => ({ text: 'I cannot do that.' });

    await expect(generateSmallModelText({ prompt: 'describe', directory: '/proj', responseSchema: schema }))
      .rejects.toMatchObject({ statusCode: 422, code: 'structured-output-unsupported' });

    expect(state.requests.filter((entry) => entry.path === '/api/experimental/generate')).toHaveLength(2);
  });
});

describe('describeSmallModel', () => {
  it('reports the default model and its budget', async () => {
    const described = await describeSmallModel({ directory: '/proj' });

    expect(described).toMatchObject({
      providerID: 'anthropic',
      modelID: 'claude-haiku-4-5',
      source: 'default',
      inputCharBudget: 16_000,
      contextTokens: 8_000,
      contextKnown: true,
      hasLogin: true,
      outputTokenLimit: 4_000,
      // /api/generate has no structured-output mode, so the capability is
      // never a settled `false` — callers must try it.
      structuredOutput: null,
    });
  });

  it('reports the override model instead of the default', async () => {
    fs.writeFileSync(
      path.join(TEMP_DATA_DIR, 'settings.json'),
      JSON.stringify({ smallModelUseDefault: false, smallModelOverride: 'openai/gpt-5.6-luna' }),
    );

    try {
      const described = await describeSmallModel({ directory: '/proj' });
      expect(described).toMatchObject({ providerID: 'openai', modelID: 'gpt-5.6-luna', source: 'settings' });
    } finally {
      fs.rmSync(path.join(TEMP_DATA_DIR, 'settings.json'), { force: true });
    }
  });

  it('reports the small model configured for OpenCode before its own pick', async () => {
    state.titleModel = { id: 'gpt-5-mini', providerID: 'openai' };

    const described = await describeSmallModel({ directory: '/proj', preferredProviderID: 'anthropic' });

    expect(described).toMatchObject({ providerID: 'openai', modelID: 'gpt-5-mini', source: 'config' });
    const agentRead = state.requests.find((entry) => entry.path === '/api/agent/title');
    expect(agentRead.headers['x-opencode-directory']).toBe(encodeURIComponent('/proj'));
  });

  it('skips a configured small model whose provider has lost its login', async () => {
    state.titleModel = { id: 'gpt-5-mini', providerID: 'openai' };
    state.models = [
      MODEL({ id: 'gpt-5-mini', modelID: 'gpt-5-mini', providerID: 'openai', enabled: false }),
      MODEL({ family: 'claude-haiku' }),
    ];

    const described = await describeSmallModel({ directory: '/proj', preferredProviderID: 'anthropic' });

    expect(described).toMatchObject({ providerID: 'anthropic', modelID: 'claude-haiku-4-5', source: 'session-provider-small' });
  });

  it('falls through to its own pick when OpenCode has no title agent yet', async () => {
    state.titleMissing = true;

    expect(await describeSmallModel({ directory: '/proj' })).toMatchObject({ source: 'default' });
  });

  it('lets the settings override outrank the OpenCode config', async () => {
    state.titleModel = { id: 'gpt-5-mini', providerID: 'openai' };
    fs.writeFileSync(
      path.join(TEMP_DATA_DIR, 'settings.json'),
      JSON.stringify({ smallModelUseDefault: false, smallModelOverride: 'anthropic/claude-haiku-4-5' }),
    );

    try {
      const described = await describeSmallModel({ directory: '/proj' });
      expect(described).toMatchObject({ providerID: 'anthropic', modelID: 'claude-haiku-4-5', source: 'settings' });
    } finally {
      fs.rmSync(path.join(TEMP_DATA_DIR, 'settings.json'), { force: true });
    }
  });

  it('reports hasLogin false for a model OpenCode has disabled', async () => {
    state.models = [MODEL({ enabled: false })];

    expect(await describeSmallModel({ directory: '/proj' })).toMatchObject({ hasLogin: false });
  });

  it('lets the reserve be decided from the resolved model limits', async () => {
    state.models = [MODEL({ limit: { context: 100_000, output: 8_000 } })];
    state.defaultModel = state.models[0];

    const described = await describeSmallModel({
      directory: '/proj',
      outputReserveTokens: ({ contextTokens, outputTokenLimit }) => Math.min(contextTokens / 10, outputTokenLimit),
    });

    // 100k context, 8k output limit → 8k reserved, leaving 92k tokens.
    expect(described.outputTokens).toBe(8_000);
    expect(described.inputCharBudget).toBe(92_000 * 4);
  });

  it('answers null when OpenCode is not reachable', async () => {
    configureOpenCodeRuntimeProviders(null);

    expect(await describeSmallModel({ directory: '/proj' })).toBeNull();
  });

  it.each([
    ['http://127.0.0.1:8080/v1', true],
    ['http://localhost:1234/v1', true],
    ['http://[::1]:11434/v1', true],
    ['http://192.168.1.20:8080/v1', true],
    ['http://100.101.102.103:8080/v1', true],
    ['http://gpu-box:8080/v1', true],
    ['http://llm.home.arpa/v1', true],
    ['https://api.example.com/v1', false],
    ['http://8.8.8.8/v1', false],
    [undefined, false],
  ])('reports whether %s is a local endpoint', async (baseURL, local) => {
    state.models = [MODEL({ id: 'qwen3', modelID: 'qwen3', providerID: 'llama', settings: baseURL ? { baseURL } : {} })];

    const described = await describeSmallModel({ directory: '/proj', preferredProviderID: 'llama', preferredModelID: 'qwen3' });

    expect(described).toMatchObject({ source: 'session-model', localEndpoint: local });
  });
});

describe('listAuthenticatedProviders', () => {
  it('offers a provider that has at least one enabled model', async () => {
    expect(await listAuthenticatedProviders()).toEqual(['anthropic']);
  });

  it('hides a provider whose models are all disabled', async () => {
    state.models = [MODEL({ enabled: false })];

    expect(await listAuthenticatedProviders()).toEqual([]);
  });

  // The provider list comes back empty on setups where models are perfectly
  // usable, so it can only add names, never remove them.
  it('derives providers from the model list when the provider list is empty', async () => {
    state.providers = [];

    expect(await listAuthenticatedProviders()).toEqual(['anthropic']);
  });

  it('offers Claude Code', async () => {
    state.models = [MODEL(), MODEL({ id: 'sonnet', modelID: 'sonnet', providerID: 'claude-code' })];

    expect(await listAuthenticatedProviders()).toContain('claude-code');
  });

  it('answers an empty list when OpenCode is not reachable', async () => {
    configureOpenCodeRuntimeProviders(null);

    expect(await listAuthenticatedProviders()).toEqual([]);
  });
});


describe('small model failure response', () => {
  it('preserves the model-specific reason without advice to change settings', async () => {
    let generate;
    registerSmallModelRoutes({
      get() {},
      post(_path, handler) { generate = handler; },
    }, {
      getSmallModelService: async () => ({ generateSmallModelText }),
    });
    setUnavailableRetryDelaysForTest([1]);
    state.generateErrors = [
      { _tag: 'InvalidRequestError', message: 'Model unavailable: zai-coding-plan/glm-5.3-flash' },
      { _tag: 'InvalidRequestError', message: 'Model unavailable: zai-coding-plan/glm-5.3-flash' },
    ];
    let status;
    let payload;
    const response = {
      status(value) { status = value; return response; },
      json(value) { payload = value; },
    };
    await generate({ body: { prompt: 'commit', model: 'zai-coding-plan/glm-5.3-flash' } }, response);
    expect(status).toBe(503);
    expect(payload).toEqual({
      error: 'Model unavailable: zai-coding-plan/glm-5.3-flash',
      code: 'small-model-unavailable',
    });
    setUnavailableRetryDelaysForTest();
  });
});
