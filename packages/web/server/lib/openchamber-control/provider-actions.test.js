import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { OpenChamberControlError } from './error.js';

// shared.js fixes the user config directory when it loads, so the module is
// imported only after OPENCODE_CONFIG_DIR points at a temporary directory; the
// real user config is never touched.
const previousConfigDir = process.env.OPENCODE_CONFIG_DIR;
const previousCustomConfig = process.env.OPENCODE_CONFIG;
const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-provider-actions-'));
process.env.OPENCODE_CONFIG_DIR = configDir;
delete process.env.OPENCODE_CONFIG;
const { createProviderActions, PROVIDER_ACTION_DEFINITIONS, PROVIDER_PARAMETERS } = await import('./provider-actions.js');

const userJson = path.join(configDir, 'opencode.json');
const userJsonc = path.join(configDir, 'opencode.jsonc');

const readJson = (filePath) => JSON.parse(fs.readFileSync(filePath, 'utf8'));
const writeJson = (filePath, value) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
};

const MODELS = [
  {
    id: 'claude-sonnet',
    modelID: 'claude-sonnet-20250101',
    providerID: 'anthropic',
    name: 'Claude Sonnet',
    variants: [{ id: 'low' }, { id: 'high' }],
    cost: [{ input: 3, output: 15, cache: { read: 0.3, write: 3.75 } }],
    status: 'active',
    enabled: true,
    limit: { context: 200000, output: 64000 },
  },
  {
    id: 'claude-old',
    modelID: 'claude-old',
    providerID: 'anthropic',
    name: 'Claude Old',
    variants: [],
    cost: [],
    status: 'deprecated',
    enabled: false,
    limit: { context: 100000, output: 4096 },
  },
  {
    id: 'gpt-5',
    modelID: 'gpt-5',
    providerID: 'openai',
    name: 'GPT-5',
    variants: [{ id: 'minimal' }],
    cost: [{ input: 1.25, output: 10, cache: { read: 0.125, write: 0 } }, { tier: { type: 'context', size: 272000 }, input: 2.5, output: 20, cache: { read: 0.25, write: 0 } }],
    status: 'active',
    enabled: true,
    limit: { context: 400000, output: 128000 },
  },
];

const PROVIDERS = [
  { id: 'anthropic', name: 'Anthropic', activation: 'auto', package: 'aisdk:@ai-sdk/anthropic' },
  { id: 'openai', name: 'OpenAI', activation: 'enabled', package: 'aisdk:@ai-sdk/openai' },
];

const setup = ({ settings = {}, client: clientOverrides = {} } = {}) => {
  let stored = {
    projects: [{ id: 'project-1', path: projectDir, label: 'Repo' }],
    ...settings,
  };
  const client = {
    provider: { list: vi.fn(async () => ({ data: PROVIDERS })) },
    model: { list: vi.fn(async () => ({ data: MODELS })) },
    agent: { list: vi.fn(async () => ({ data: [{ id: 'build', name: 'build' }, { id: 'plan', name: 'plan' }] })) },
    ...clientOverrides,
  };
  const persistSettings = vi.fn(async (changes) => {
    stored = { ...stored, ...changes };
    return stored;
  });
  const actions = createProviderActions({
    readSettingsFromDiskMigrated: vi.fn(async () => stored),
    persistSettings,
  });
  const getClient = vi.fn(async () => client);
  const run = (action, input = {}) => actions.execute(action, input, { contextDirectory: projectDir, contextSessionId: 'ses_1', getClient });
  return { actions, run, client, persistSettings, getClient, settings: () => stored };
};

const expectError = async (promise, statusCode, message) => {
  const error = await promise.then(() => null, (caught) => caught);
  expect(error).toBeInstanceOf(OpenChamberControlError);
  expect(error.statusCode).toBe(statusCode);
  if (message) expect(error.message).toMatch(message);
};

let projectDir;

beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-provider-actions-project-'));
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(projectDir, { recursive: true, force: true });
  for (const entry of fs.readdirSync(configDir)) fs.rmSync(path.join(configDir, entry), { recursive: true, force: true });
});

afterAll(() => {
  fs.rmSync(configDir, { recursive: true, force: true });
  if (previousConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
  else process.env.OPENCODE_CONFIG_DIR = previousConfigDir;
  if (previousCustomConfig !== undefined) process.env.OPENCODE_CONFIG = previousCustomConfig;
});

describe('provider action contract', () => {
  it('defines every action it executes, and only new parameter names', () => {
    const { actions } = setup();
    expect(PROVIDER_ACTION_DEFINITIONS.map(({ action }) => action)).toEqual(actions.actions);
    for (const definition of PROVIDER_ACTION_DEFINITIONS) {
      expect(definition.title).toBeTruthy();
      expect(definition.description).toBeTruthy();
    }
    const runtimeSource = fs.readFileSync(fileURLToPath(new URL('../agent-tool/runtime.js', import.meta.url)), 'utf8');
    const shared = runtimeSource.slice(runtimeSource.indexOf('const ALL_PARAMETER_PROPERTIES'), runtimeSource.indexOf('const pickParameters'));
    for (const [name, schema] of Object.entries(PROVIDER_PARAMETERS)) {
      expect(shared).not.toMatch(new RegExp(`^  ${name}:`, 'm'));
      expect(schema.description).toBeTruthy();
    }
  });

  it('rejects an unknown action', async () => {
    const { run } = setup();
    await expectError(run('providers.nope'), 400, /Unsupported provider action/);
  });

  it('rejects prototype-named actions instead of dispatching inherited members', async () => {
    const { run } = setup();
    for (const action of ['constructor', 'toString', 'hasOwnProperty', 'valueOf', '__proto__']) {
      await expectError(run(action), 400, /Unsupported provider action/);
    }
  });
});

describe('providers.list', () => {
  it('merges live providers with turned-off ones, config presence, and model counts', async () => {
    writeJson(userJson, { disabled_providers: ['groq'], providers: { openai: { settings: { timeout: 10 } } } });
    writeJson(path.join(projectDir, 'opencode.json'), { provider: { anthropic: { options: {} } } });
    const { run } = setup({ settings: { hiddenModels: [{ providerID: 'anthropic', modelID: 'claude-sonnet' }] } });

    const result = await run('providers.list');

    expect(result.providers).toEqual([
      { id: 'anthropic', name: 'Anthropic', activation: 'auto', disabled: false, configuredIn: ['project'], models: { total: 2, enabled: 1, visible: 0 } },
      { id: 'openai', name: 'OpenAI', activation: 'enabled', disabled: false, configuredIn: ['user'], models: { total: 1, enabled: 1, visible: 1 } },
      { id: 'groq', name: 'groq', activation: 'disabled', disabled: true, configuredIn: [], models: null },
    ]);
  });

  it('reports a failed OpenCode lookup instead of an empty list', async () => {
    const { run } = setup({ client: { provider: { list: vi.fn(async () => { throw new Error('connect ECONNREFUSED'); }) } } });
    await expectError(run('providers.list'), 502, /ECONNREFUSED/);
  });

  it('refuses projectId with directory, and an unknown projectId', async () => {
    const { run } = setup();
    await expectError(run('providers.list', { projectId: 'project-1', directory: '/x' }), 400, /only one/);
    await expectError(run('providers.list', { projectId: 'missing' }), 404, /Project not found/);
  });
});

describe('providers.toggle', () => {
  it('turns a provider off and on in the user config, keeping comments and other keys', async () => {
    fs.writeFileSync(userJsonc, '{\n  // my default\n  "model": "a/b"\n}\n');
    const { run } = setup();

    const off = await run('providers.toggle', { providerId: 'openrouter', disabled: true });
    expect(off).toMatchObject({ providerId: 'openrouter', disabled: true, disabledProviders: ['openrouter'], success: true });
    expect(fs.readFileSync(userJsonc, 'utf8')).toContain('// my default');

    const on = await run('providers.toggle', { providerId: 'openrouter', disabled: false });
    expect(on.disabledProviders).toEqual([]);
    const text = fs.readFileSync(userJsonc, 'utf8');
    expect(text).toContain('// my default');
    expect(text).not.toContain('disabled_providers');
  });

  it('validates its input', async () => {
    const { run } = setup();
    await expectError(run('providers.toggle', { disabled: true }), 400, /providerId is required/);
    await expectError(run('providers.toggle', { providerId: 'openai' }), 400, /disabled must be/);
    await expectError(run('providers.toggle', { providerId: 'Bad Id', disabled: true }), 400, /Invalid provider ID/);
  });
});

describe('models.available', () => {
  it('lists models with variants, base price, limits, and OpenChamber state', async () => {
    const { run, getClient } = setup({
      settings: {
        hiddenModels: [{ providerID: 'openai', modelID: 'gpt-5' }],
        favoriteModels: [{ providerID: 'anthropic', modelID: 'claude-sonnet' }],
        defaultModel: 'anthropic/claude-sonnet',
      },
    });

    const result = await run('models.available');

    expect(getClient).toHaveBeenCalledWith(projectDir);
    expect(result.count).toBe(3);
    expect(result.models[0]).toEqual({
      model: 'anthropic/claude-sonnet',
      providerID: 'anthropic',
      modelId: 'claude-sonnet',
      name: 'Claude Sonnet',
      status: 'active',
      enabled: true,
      hidden: false,
      favorite: true,
      default: true,
      variants: ['low', 'high'],
      cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
      limit: { context: 200000, output: 64000 },
    });
    expect(result.models[2]).toMatchObject({ hidden: true, cost: { input: 1.25, output: 10, tiers: 2 } });
    expect(result.models[1].cost).toBeNull();
  });

  it('filters by provider and to enabled, visible models', async () => {
    const { run } = setup({ settings: { hiddenModels: [{ providerID: 'openai', modelID: 'gpt-5' }] } });
    expect((await run('models.available', { providerId: 'anthropic' })).models.map((m) => m.model))
      .toEqual(['anthropic/claude-sonnet', 'anthropic/claude-old']);
    expect((await run('models.available', { enabledOnly: true })).models.map((m) => m.model))
      .toEqual(['anthropic/claude-sonnet']);
    await expectError(run('models.available', { enabledOnly: 'yes' }), 400, /enabledOnly must be/);
  });
});

describe('models.toggle', () => {
  it('hides and shows a model in OpenChamber, newest hidden first', async () => {
    const { run, persistSettings } = setup({ settings: { hiddenModels: [{ providerID: 'openai', modelID: 'gpt-5' }] } });

    const hidden = await run('models.toggle', { model: 'anthropic/claude-sonnet', disabled: true });
    expect(hidden).toMatchObject({ model: 'anthropic/claude-sonnet', level: 'openchamber', hidden: true });
    expect(persistSettings).toHaveBeenLastCalledWith({
      hiddenModels: [{ providerID: 'anthropic', modelID: 'claude-sonnet' }, { providerID: 'openai', modelID: 'gpt-5' }],
    });

    await run('models.toggle', { providerId: 'anthropic', modelId: 'claude-sonnet', disabled: false });
    expect(persistSettings).toHaveBeenLastCalledWith({ hiddenModels: [{ providerID: 'openai', modelID: 'gpt-5' }] });
    expect(fs.existsSync(userJson)).toBe(false);
  });

  it('disables a model in OpenCode config and removes only what it added when enabling', async () => {
    writeJson(userJson, { providers: { anthropic: { settings: { timeout: 5 }, models: { 'claude-sonnet': { name: 'Mine' } } } } });
    const { run, persistSettings } = setup();

    const off = await run('models.toggle', { model: 'anthropic/claude-sonnet', disabled: true, modelToggleLevel: 'opencode' });
    expect(off).toMatchObject({ level: 'opencode', disabled: true, success: true, path: userJson, scope: 'user' });
    expect(readJson(userJson).providers.anthropic.models['claude-sonnet']).toEqual({ name: 'Mine', disabled: true });

    await run('models.toggle', { model: 'anthropic/claude-sonnet', disabled: false, modelToggleLevel: 'opencode' });
    expect(readJson(userJson).providers.anthropic).toEqual({ settings: { timeout: 5 }, models: { 'claude-sonnet': { name: 'Mine' } } });

    await run('models.toggle', { model: 'openai/gpt-5', disabled: true, modelToggleLevel: 'opencode' });
    await run('models.toggle', { model: 'openai/gpt-5', disabled: false, modelToggleLevel: 'opencode' });
    expect(readJson(userJson).providers.openai).toBeUndefined();
    expect(persistSettings).not.toHaveBeenCalled();
  });

  it('writes project scope and warns when a higher file still decides', async () => {
    writeJson(path.join(projectDir, 'opencode.json'), { providers: { openai: { models: { 'gpt-5': { disabled: true } } } } });
    const { run } = setup();

    const result = await run('models.toggle', { model: 'openai/gpt-5', disabled: false, modelToggleLevel: 'opencode' });
    expect(result.warning).toContain(path.join(projectDir, 'opencode.json'));

    const project = await run('models.toggle', { model: 'openai/gpt-5', disabled: false, modelToggleLevel: 'opencode', configScope: 'project' });
    expect(project).toMatchObject({ scope: 'project', path: path.join(projectDir, 'opencode.json') });
    expect(project.warning).toBeUndefined();
    expect(readJson(path.join(projectDir, 'opencode.json')).providers).toBeUndefined();
  });

  it('validates its input', async () => {
    const { run } = setup();
    await expectError(run('models.toggle', { disabled: true }), 400, /model, or providerId with modelId/);
    await expectError(run('models.toggle', { model: 'noslash', disabled: true }), 400, /provider\/model/);
    await expectError(run('models.toggle', { model: 'a/b', providerId: 'a', disabled: true }), 400, /not both/);
    await expectError(run('models.toggle', { model: 'a/b' }), 400, /disabled must be/);
    await expectError(run('models.toggle', { model: 'a/b', disabled: true, modelToggleLevel: 'x' }), 400, /modelToggleLevel/);
    await expectError(run('models.toggle', { model: 'a/b', disabled: true, modelToggleLevel: 'opencode', configScope: 'global' }), 400, /configScope/);
  });

  it('refuses to write a config file that does not parse', async () => {
    fs.writeFileSync(userJson, '{ "model": ');
    const { run } = setup();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expectError(run('models.toggle', { model: 'openai/gpt-5', disabled: true, modelToggleLevel: 'opencode' }), 409, /not valid JSONC/);
    expect(fs.readFileSync(userJson, 'utf8')).toBe('{ "model": ');
  });
});

describe('models.default', () => {
  it('sets the model and clears the old variant unless one is given', async () => {
    const { run, persistSettings } = setup({ settings: { defaultModel: 'openai/gpt-5', defaultVariant: 'minimal' } });

    const result = await run('models.default', { model: 'anthropic/claude-sonnet' });
    expect(persistSettings).toHaveBeenLastCalledWith({ defaultModel: 'anthropic/claude-sonnet', defaultVariant: '' });
    expect(result).toEqual({ defaultModel: 'anthropic/claude-sonnet', defaultVariant: null, defaultAgent: null });

    await run('models.default', { model: 'anthropic/claude-sonnet', variant: 'high', agent: 'plan' });
    expect(persistSettings).toHaveBeenLastCalledWith({ defaultModel: 'anthropic/claude-sonnet', defaultVariant: 'high', defaultAgent: 'plan' });
  });

  it('sets only the variant against the current default model, and clears with empty strings', async () => {
    const { run, persistSettings } = setup({ settings: { defaultModel: 'anthropic/claude-sonnet', defaultAgent: 'build' } });

    expect(await run('models.default', { variant: 'low' })).toMatchObject({ defaultModel: 'anthropic/claude-sonnet', defaultVariant: 'low', defaultAgent: 'build' });
    expect(persistSettings).toHaveBeenLastCalledWith({ defaultVariant: 'low' });

    await run('models.default', { model: '', agent: '' });
    expect(persistSettings).toHaveBeenLastCalledWith({ defaultModel: '', defaultVariant: '', defaultAgent: '' });
  });

  it('rejects a model, variant, or agent the catalog does not offer', async () => {
    const { run, persistSettings } = setup({ settings: { defaultModel: 'anthropic/claude-sonnet' } });
    await expectError(run('models.default', { model: 'anthropic/nope' }), 404, /Model not found/);
    await expectError(run('models.default', { variant: 'ultra' }), 400, /choose one of: low, high/);
    await expectError(run('models.default', { model: 'anthropic/claude-old', variant: 'low' }), 400, /no effort variants/);
    await expectError(run('models.default', { agent: 'ghost' }), 404, /Agent not found/);
    await expectError(run('models.default', {}), 400, /at least one/);
    await expectError(run('models.default', { model: 5 }), 400, /must be a string/);
    expect(persistSettings).not.toHaveBeenCalled();
  });

  it('needs a model for a variant', async () => {
    const { run } = setup();
    await expectError(run('models.default', { variant: 'low' }), 400, /needs a default model/);
  });

  it('accepts the automatic model without a catalog check', async () => {
    const { run, client } = setup();
    expect(await run('models.default', { model: 'openchamber/auto' })).toMatchObject({ defaultModel: 'openchamber/auto' });
    expect(client.model.list).not.toHaveBeenCalled();
    await expectError(run('models.default', { model: 'openchamber/auto', writeOpenCodeDefault: true }), 400, /automatic model/);
  });

  it('keeps a valid selection when the catalog cannot be read, and says so', async () => {
    const { run, persistSettings } = setup({
      client: {
        model: { list: vi.fn(async () => { throw new Error('down'); }) },
        agent: { list: vi.fn(async () => { throw new Error('down'); }) },
      },
    });
    const result = await run('models.default', { model: 'anthropic/claude-sonnet', variant: 'high', agent: 'build' });
    expect(persistSettings).toHaveBeenCalledWith({ defaultModel: 'anthropic/claude-sonnet', defaultVariant: 'high', defaultAgent: 'build' });
    expect(result.warnings).toHaveLength(2);
  });

  it('sets project defaults without touching global ones', async () => {
    const { run, persistSettings } = setup({
      settings: {
        defaultModel: 'openai/gpt-5',
        projects: [
          { id: 'project-1', path: projectDir, label: 'Repo', defaultModel: 'openai/gpt-5', defaultVariant: 'minimal' },
          { id: 'project-2', path: '/other', label: 'Other' },
        ],
      },
    });

    const result = await run('models.default', { projectId: 'project-1', model: 'anthropic/claude-sonnet', agent: 'plan' });
    expect(result).toMatchObject({ projectId: 'project-1', defaultModel: 'anthropic/claude-sonnet', defaultVariant: null, defaultAgent: 'plan' });
    expect(persistSettings).toHaveBeenCalledWith({
      projects: [
        { id: 'project-1', path: projectDir, label: 'Repo', defaultModel: 'anthropic/claude-sonnet', defaultAgent: 'plan' },
        { id: 'project-2', path: '/other', label: 'Other' },
      ],
    });
  });

  it('writes OpenCode\'s own default with the variant, and removes it when cleared', async () => {
    fs.writeFileSync(userJsonc, '{\n  // keep\n  "model": "openai/gpt-5"\n}\n');
    const { run } = setup();

    const result = await run('models.default', { model: 'anthropic/claude-sonnet', variant: 'high', writeOpenCodeDefault: true });
    expect(result.openCodeDefault).toMatchObject({ model: 'anthropic/claude-sonnet#high', path: userJsonc, scope: 'user' });
    const text = fs.readFileSync(userJsonc, 'utf8');
    expect(text).toContain('// keep');
    expect(text).toContain('"anthropic/claude-sonnet#high"');

    await run('models.default', { model: '', writeOpenCodeDefault: true });
    expect(fs.readFileSync(userJsonc, 'utf8')).not.toContain('"model"');
  });
});

describe('provider.models.add', () => {
  it('adds a new model to a built-in provider with its API id, limits, variants, and price', async () => {
    const { run } = setup();

    const result = await run('provider.models.add', {
      providerId: 'anthropic',
      modelId: 'claude-next',
      name: 'Claude Next',
      contextLimit: 500000,
      outputLimit: 32000,
      variants: ['low', 'high'],
      costInput: 2,
      costOutput: 8,
    });

    expect(result).toMatchObject({ model: 'anthropic/claude-next', created: true, success: true, path: userJson, scope: 'user' });
    expect(readJson(userJson).providers.anthropic.models['claude-next']).toEqual({
      modelID: 'claude-next',
      name: 'Claude Next',
      limit: { context: 500000, output: 32000 },
      variants: [{ id: 'low' }, { id: 'high' }],
      cost: { input: 2, output: 8 },
    });
  });

  it('overlays a catalog model without re-keying it, and merges with what is stored', async () => {
    writeJson(userJson, { providers: { anthropic: { models: { 'claude-sonnet': { limit: { context: 1000 }, headers: { a: 'b' } } } } } });
    const { run } = setup();

    const result = await run('provider.models.add', { providerId: 'anthropic', modelId: 'claude-sonnet', outputLimit: 99, costCacheRead: 0.5, variants: [] });

    expect(result.created).toBe(false);
    expect(readJson(userJson).providers.anthropic.models['claude-sonnet']).toEqual({
      limit: { context: 1000, output: 99 },
      headers: { a: 'b' },
      cost: { input: 3, output: 15, cache: { read: 0.5, write: 3.75 } },
    });
  });

  it('rewrites a v1 provider entry in v2 shape in the project config', async () => {
    writeJson(path.join(projectDir, 'opencode.json'), {
      provider: { local: { npm: '@ai-sdk/openai-compatible', options: { baseURL: 'http://localhost:1234/v1' }, models: { a: { name: 'A' } } } },
    });
    const { run } = setup();

    await run('provider.models.add', { providerId: 'local', modelId: 'b', name: 'B', configScope: 'project' });

    const written = readJson(path.join(projectDir, 'opencode.json'));
    expect(written.provider).toBeUndefined();
    expect(written.providers.local).toEqual({
      package: 'aisdk:@ai-sdk/openai-compatible',
      settings: { baseURL: 'http://localhost:1234/v1' },
      models: { a: { name: 'A' }, b: { modelID: 'b', name: 'B' } },
    });
  });

  it('validates its input and refuses an unknown provider', async () => {
    const { run } = setup();
    await expectError(run('provider.models.add', { modelId: 'x' }), 400, /providerId is required/);
    await expectError(run('provider.models.add', { providerId: 'anthropic' }), 400, /modelId is required/);
    await expectError(run('provider.models.add', { providerId: 'anthropic', modelId: 'x', name: ' ' }), 400, /name cannot be empty/);
    await expectError(run('provider.models.add', { providerId: 'anthropic', modelId: 'x', contextLimit: 0 }), 400, /contextLimit/);
    await expectError(run('provider.models.add', { providerId: 'anthropic', modelId: 'x', variants: 'high' }), 400, /variants/);
    await expectError(run('provider.models.add', { providerId: 'anthropic', modelId: 'x', costInput: -1 }), 400, /costInput/);
    await expectError(run('provider.models.add', { providerId: 'anthropic', modelId: 'x', costInput: 1 }), 400, /costOutput is required/);
    await expectError(run('provider.models.add', { providerId: 'nobody', modelId: 'x' }), 404, /Provider not found/);
    expect(fs.existsSync(userJson)).toBe(false);
  });
});

describe('provider.models.remove', () => {
  it('removes the entry and prunes what it emptied', async () => {
    writeJson(userJson, { providers: { anthropic: { models: { 'claude-next': { modelID: 'claude-next' } } }, openai: { models: { a: {}, b: {} } } } });
    const { run } = setup();

    await run('provider.models.remove', { providerId: 'anthropic', modelId: 'claude-next' });
    await run('provider.models.remove', { providerId: 'openai', modelId: 'a' });

    expect(readJson(userJson).providers).toEqual({ openai: { models: { b: {} } } });
  });

  it('reports a model with no entry in that file', async () => {
    const { run } = setup();
    await expectError(run('provider.models.remove', { providerId: 'anthropic', modelId: 'claude-sonnet' }), 404, /has no entry/);
    await expectError(run('provider.models.remove', { providerId: 'anthropic' }), 400, /modelId is required/);
  });
});

describe('models.cost', () => {
  it('fills unnamed fields from the catalog price and writes the native shape', async () => {
    const { run } = setup();

    const result = await run('models.cost', { model: 'anthropic/claude-sonnet', costOutput: 12 });

    expect(result).toMatchObject({ model: 'anthropic/claude-sonnet', cost: { input: 3, output: 12, cache: { read: 0.3, write: 3.75 } }, unit: 'USD per million tokens' });
    expect(readJson(userJson).providers.anthropic.models['claude-sonnet']).toEqual({ cost: { input: 3, output: 12, cache: { read: 0.3, write: 3.75 } } });
  });

  it('prefers the stored price over the catalog and reads v1 cache fields', async () => {
    writeJson(userJson, { providers: { custom: { models: { m: { modelID: 'm', cost: { input: 1, output: 2, cache_read: 0.1, cache_write: 0.2 } } } } } });
    const { run } = setup({ client: { model: { list: vi.fn(async () => { throw new Error('down'); }) } } });

    await run('models.cost', { providerId: 'custom', modelId: 'm', costInput: 4 });

    expect(readJson(userJson).providers.custom.models.m).toEqual({ modelID: 'm', cost: { input: 4, output: 2, cache: { read: 0.1, write: 0.2 } } });
  });

  it('validates the price', async () => {
    writeJson(userJson, { providers: { custom: { models: { m: { cost: [{ input: 1, output: 1 }] }, n: {} } } } });
    const { run } = setup();
    await expectError(run('models.cost', { model: 'anthropic/claude-sonnet' }), 400, /at least one/);
    await expectError(run('models.cost', { model: 'anthropic/claude-sonnet', costInput: 'cheap' }), 400, /costInput/);
    await expectError(run('models.cost', { model: 'anthropic/nope', costInput: 1 }), 404, /provider.models.add/);
    await expectError(run('models.cost', { model: 'custom/m', costInput: 1 }), 409, /tiered/);
    await expectError(run('models.cost', { model: 'custom/n', costInput: 1, costOutput: 1, costCacheRead: 1 }), 400, /costCacheWrite is required/);
  });
});
