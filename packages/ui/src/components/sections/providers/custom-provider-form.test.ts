import { describe, expect, test } from 'bun:test';
import {
  buildIntegrationKeyRequest,
  createEmptyCustomProviderForm,
  modelRowFromDiscovery,
  buildProviderUpsertRequest,
  storeKeyAfterConfigWrite,
  isConfigDefinedCustomProvider,
  isCustomOpenAICompatibleProvider,
  providerToCustomFormState,
  providerToEditFormState,
  storedProviderEntrySchema,
  resolveProviderConfigScope,
  validateCustomProvider,
  type CustomProviderConfig,
  type CustomProviderFormState,
} from './custom-provider-form';

const t = (key: string) => key;

const baseForm = (overrides: Partial<CustomProviderFormState> = {}): CustomProviderFormState => ({
  providerID: 'custom-provider',
  name: 'Custom Provider',
  icon: 'server',
  protocol: 'openai-chat',
  baseURL: 'https://api.example.com/v1',
  apiKey: 'sk-test',
  models: [{
    row: 'm0',
    id: 'model-a',
    name: 'Model A',
    contextWindow: '',
    maxOutputTokens: '',
    inputCapabilities: ['text'],
    outputCapabilities: ['text'],
    tools: true,
    capabilitiesKnown: false,
    variants: '',
  }],
  headers: [{ row: 'h0', key: '', value: '' }],
  ...overrides,
});

const baseModel = (overrides: Partial<CustomProviderFormState['models'][number]> = {}): CustomProviderFormState['models'][number] => ({
  row: 'm0',
  id: 'model-a',
  name: 'Model A',
  contextWindow: '',
  maxOutputTokens: '',
  inputCapabilities: ['text'],
  outputCapabilities: ['text'],
  tools: true,
  capabilitiesKnown: false,
  variants: '',
  ...overrides,
});

/** The editable fields a model row carries before anyone fills them in. */
const MODEL_ROW_DEFAULTS = {
  contextWindow: '',
  maxOutputTokens: '',
  inputCapabilities: ['text'],
  outputCapabilities: ['text'],
  tools: true,
  capabilitiesKnown: false,
};

/** Mirrors server upsert semantics for request-construction tests. */
function mergeProviderConfig(
  existing: Record<string, unknown>,
  providerID: string,
  config: CustomProviderConfig,
): Record<string, unknown> {
  const providerSection = (
    typeof existing.provider === 'object' && existing.provider !== null && !Array.isArray(existing.provider)
      ? { ...(existing.provider as Record<string, unknown>) }
      : {}
  );
  providerSection[providerID] = config;
  const next: Record<string, unknown> = {
    ...existing,
    provider: providerSection,
  };
  if (Array.isArray(existing.disabled_providers)) {
    next.disabled_providers = existing.disabled_providers.filter((entry) => entry !== providerID);
  }
  return next;
}

describe('validateCustomProvider', () => {
  test('builds trimmed config and auth payloads', () => {
    const result = validateCustomProvider({
      form: baseForm({
        providerID: ' custom-provider ',
        name: ' Custom Provider ',
        baseURL: ' https://api.example.com/v1 ',
        apiKey: ' sk-secret ',
        models: [baseModel({ id: ' model-a ', name: ' Model A ' })],
        headers: [
          { row: 'h0', key: ' X-Test ', value: ' enabled ' },
          { row: 'h1', key: '', value: '' },
        ],
      }),
      t,
      existingProviderIDs: new Set(),
    });

    expect(result.result).toEqual({
      providerID: 'custom-provider',
      icon: 'server',
      name: 'Custom Provider',
      apiKey: 'sk-secret',
      config: {
        package: 'aisdk:@ai-sdk/openai-compatible',
        name: 'Custom Provider',
        settings: {
          baseURL: 'https://api.example.com/v1',
        },
        headers: {
          'X-Test': 'enabled',
        },
        models: {
          'model-a': { modelID: 'model-a', name: 'Model A' },
        },
      },
    });
  });

  test('persists reviewed model limits and capabilities', () => {
    const result = validateCustomProvider({
      form: baseForm({
        models: [baseModel({
          contextWindow: '128000',
          maxOutputTokens: '16384',
          inputCapabilities: ['text', 'image'],
          outputCapabilities: ['text'],
          tools: false,
          capabilitiesKnown: true,
        })],
      }),
      t,
      existingProviderIDs: new Set(),
    });

    expect(result.result?.config.models['model-a']).toEqual({
      modelID: 'model-a',
      name: 'Model A',
      limit: { context: 128000, output: 16384 },
      capabilities: { tools: false, input: ['text', 'image'], output: ['text'] },
    });
  });

  test('keeps the selected OpenChamber provider icon in the persistence plan', () => {
    const result = validateCustomProvider({
      form: baseForm({ icon: 'cloud' }),
      t,
      existingProviderIDs: new Set(),
    });

    expect(result.result?.icon).toBe('cloud');
    expect('icon' in (result.result?.config ?? {})).toBe(false);
  });

  test('keeps no icon for a new provider so its own logo still shows', () => {
    expect(createEmptyCustomProviderForm().icon).toBeNull();
  });

  test('turns a discovered model into a row, the provider winning over models.dev field by field', () => {
    const row = modelRowFromDiscovery({
      id: 'llama-3',
      name: 'llama-3',
      limit: { context: 8192 },
      metadata: {
        providerID: 'meta',
        modelID: 'llama-3',
        name: 'Llama 3',
        limit: { context: 128000, output: 4096 },
        capabilities: { tools: false, input: ['text', 'image'], output: ['text'] },
      },
    });
    expect(row.id).toBe('llama-3');
    expect(row.name).toBe('Llama 3');
    expect(row.contextWindow).toBe('8192');
    expect(row.maxOutputTokens).toBe('4096');
    expect(row.inputCapabilities).toEqual(['text', 'image']);
    expect(row.tools).toBe(false);
    expect(row.metadataSource).toBe('provider-api');
  });

  test('a discovered model nothing describes gets text in and out with tool calls', () => {
    const row = modelRowFromDiscovery({ id: 'plain', name: 'plain' });
    expect(row.contextWindow).toBe('');
    expect(row.inputCapabilities).toEqual(['text']);
    expect(row.tools).toBe(true);
    expect(row.metadataSource).toBe(undefined);
  });

  test('supports {env:VAR} credentials without writing an auth key', () => {
    const result = validateCustomProvider({
      form: baseForm({
        apiKey: '{env: CUSTOM_PROVIDER_KEY}',
      }),
      t,
      existingProviderIDs: new Set(),
    });

    expect(result.result?.apiKey).toEqual(undefined);
    expect(result.result?.config.env).toEqual(['CUSTOM_PROVIDER_KEY']);
  });

  test('uses the selected OpenCode provider adapter', () => {
    const result = validateCustomProvider({
      form: baseForm({ protocol: 'openai-responses' }),
      t,
      existingProviderIDs: new Set(),
    });

    expect(result.result?.config.package).toBe('aisdk:@ai-sdk/openai');
  });

  test('rejects missing credentials', () => {
    const result = validateCustomProvider({
      form: baseForm({ apiKey: '   ' }),
      t,
      existingProviderIDs: new Set(),
    });

    expect(result.result).toEqual(undefined);
    expect(result.err.apiKey).toBe('settings.providers.page.custom.error.apiKey.required');
  });

  test('allows empty api key when editing with existing auth', () => {
    const result = validateCustomProvider({
      form: baseForm({ apiKey: '' }),
      t,
      existingProviderIDs: new Set(['custom-provider']),
      editingProviderID: 'custom-provider',
      allowExistingAuth: true,
    });

    expect(result.result?.providerID).toBe('custom-provider');
    expect(result.err.apiKey).toEqual(undefined);
    expect(result.result?.apiKey).toEqual(undefined);
  });

  test('rejects invalid provider id, base URL, and duplicate rows', () => {
    const result = validateCustomProvider({
      form: baseForm({
        providerID: 'Bad ID',
        baseURL: 'ftp://example.com',
        models: [
          baseModel(),
          baseModel({ row: 'm1', name: 'Model A 2' }),
        ],
        headers: [
          { row: 'h0', key: 'Authorization', value: 'one' },
          { row: 'h1', key: 'authorization', value: 'two' },
        ],
      }),
      t,
      existingProviderIDs: new Set(),
    });

    expect(result.result).toEqual(undefined);
    expect(result.err.providerID).toBe('settings.providers.page.custom.error.providerID.format');
    expect(result.err.baseURL).toBe('settings.providers.page.custom.error.baseURL.format');
    expect(result.models[1]).toEqual({
      id: 'settings.providers.page.custom.error.duplicate',
      name: undefined,
    });
    expect(result.headers[1]).toEqual({
      key: 'settings.providers.page.custom.error.duplicate',
      value: undefined,
    });
  });

  test('allows reconnecting a disabled provider id', () => {
    const result = validateCustomProvider({
      form: baseForm(),
      t,
      existingProviderIDs: new Set(['custom-provider']),
      disabledProviders: ['custom-provider'],
    });

    expect(result.result?.providerID).toBe('custom-provider');
    expect(result.err.providerID).toEqual(undefined);
  });

  test('rejects an already-connected provider id on create', () => {
    const result = validateCustomProvider({
      form: baseForm(),
      t,
      existingProviderIDs: new Set(['custom-provider']),
    });

    expect(result.result).toEqual(undefined);
    expect(result.err.providerID).toBe('settings.providers.page.custom.error.providerID.exists');
  });

  test('allows updating the same provider id while editing', () => {
    const result = validateCustomProvider({
      form: baseForm({ apiKey: 'sk-updated' }),
      t,
      existingProviderIDs: new Set(['custom-provider']),
      editingProviderID: 'custom-provider',
    });

    expect(result.result?.providerID).toBe('custom-provider');
    expect(result.err.providerID).toEqual(undefined);
  });
});

describe('request construction', () => {
  test('builds integration key and provider upsert requests', () => {
    const validated = validateCustomProvider({
      form: baseForm(),
      t,
      existingProviderIDs: new Set(),
    });
    const plan = validated.result!;

    expect(buildIntegrationKeyRequest(plan)).toEqual({
      integrationID: 'custom-provider',
      key: 'sk-test',
    });
    expect(buildProviderUpsertRequest(plan)).toEqual({
      providerID: 'custom-provider',
      config: plan.config,
      scope: 'user',
      hasCredential: true,
    });
  });

  test('vouches for a credential only when a key is stored or kept', () => {
    const envPlan = validateCustomProvider({
      form: baseForm({ apiKey: '{env:MY_KEY}' }),
      t,
      existingProviderIDs: new Set(),
    }).result!;
    expect(buildProviderUpsertRequest(envPlan).hasCredential).toBe(false);

    const keptPlan = validateCustomProvider({
      form: baseForm({ apiKey: '' }),
      t,
      existingProviderIDs: new Set(['custom-provider']),
      editingProviderID: 'custom-provider',
      allowExistingAuth: true,
    }).result!;
    expect(buildProviderUpsertRequest(keptPlan).hasCredential).toBe(true);
  });

  test('retries the key only while OpenCode has not registered the provider yet', async () => {
    const waits: number[] = [];
    let calls = 0;
    await storeKeyAfterConfigWrite(async () => {
      calls += 1;
      if (calls < 3) throw new Error('Integration not found: custom-provider');
    }, async (ms) => { waits.push(ms); });
    expect(calls).toBe(3);
    expect(waits).toEqual([250, 500]);

    let otherCalls = 0;
    await expect(storeKeyAfterConfigWrite(async () => {
      otherCalls += 1;
      throw new Error('Network down');
    }, async () => {})).rejects.toThrow('Network down');
    expect(otherCalls).toBe(1);

    await expect(storeKeyAfterConfigWrite(async () => {
      throw new Error('Integration not found: custom-provider');
    }, async () => {})).rejects.toThrow('Integration not found');
  });

  test('includes explicit project/custom scope on upsert requests', () => {
    const validated = validateCustomProvider({
      form: baseForm(),
      t,
      existingProviderIDs: new Set(),
    });
    const plan = validated.result!;

    expect(buildProviderUpsertRequest(plan, { scope: 'project' }).scope).toBe('project');
    expect(buildProviderUpsertRequest(plan, { scope: 'custom' }).scope).toBe('custom');
  });

  test('omits the integration key request when using env credentials', () => {
    const validated = validateCustomProvider({
      form: baseForm({ apiKey: '{env:MY_KEY}' }),
      t,
      existingProviderIDs: new Set(),
    });

    expect(buildIntegrationKeyRequest(validated.result!)).toBeNull();
  });
});

describe('mergeProviderConfig persistence shape', () => {
  test('merges provider block and clears disabled_providers entry', () => {
    const validated = validateCustomProvider({
      form: baseForm(),
      t,
      existingProviderIDs: new Set(),
    });
    const plan = validated.result!;

    const next = mergeProviderConfig(
      {
        model: 'openai/gpt-4o',
        provider: {
          openai: { name: 'OpenAI' },
        },
        disabled_providers: ['custom-provider', 'other'],
      },
      plan.providerID,
      plan.config,
    );

    expect(next).toEqual({
      model: 'openai/gpt-4o',
      provider: {
        openai: { name: 'OpenAI' },
        'custom-provider': plan.config,
      },
      disabled_providers: ['other'],
    });
  });

  test('creates provider section when missing', () => {
    const validated = validateCustomProvider({
      form: baseForm(),
      t,
      existingProviderIDs: new Set(),
    });
    const plan = validated.result!;

    const next = mergeProviderConfig({}, plan.providerID, plan.config);
    expect(next.provider).toEqual({
      'custom-provider': plan.config,
    });
  });
});

describe('provider edit helpers', () => {
  test('detects openai-compatible custom providers and prefills form state', () => {
    expect(isCustomOpenAICompatibleProvider({
      id: 'campus-llm',
      options: { baseURL: 'https://llm.example.edu/v1' },
      models: [],
    })).toBe(true);

    const state = providerToCustomFormState({
      id: 'campus-llm',
      name: 'Campus LLM',
      env: ['CAMPUS_KEY'],
      options: {
        baseURL: 'https://llm.example.edu/v1',
        headers: { 'X-Campus': '1' },
      },
      models: [{ id: 'fast', name: 'Fast' }],
    });

    expect(state.providerID).toBe('campus-llm');
    expect(state.name).toBe('Campus LLM');
    expect(state.baseURL).toBe('https://llm.example.edu/v1');
    expect(state.apiKey).toBe('{env:CAMPUS_KEY}');
    expect(state.protocol).toBe('openai-chat');
    expect(state.models[0]).toEqual({ ...MODEL_ROW_DEFAULTS, row: state.models[0].row, id: 'fast', name: 'Fast', variants: '', savedVariants: {} });
    expect(state.headers[0]).toEqual({ row: state.headers[0].row, key: 'X-Campus', value: '1' });
  });

  test('prefills the protocol from a v1 model api.npm', () => {
    const state = providerToCustomFormState({
      id: 'responses-api',
      options: { baseURL: 'https://api.example.com/v1' },
      models: [{ id: 'gpt', name: 'GPT', api: { npm: '@ai-sdk/openai' } }],
    });

    expect(state.protocol).toBe('openai-responses');
  });

  test('reads a v2 provider: package, settings, headers, modelID', () => {
    const state = providerToCustomFormState({
      id: 'campus-llm',
      name: 'Campus LLM',
      env: ['CAMPUS_KEY'],
      package: 'aisdk:@ai-sdk/anthropic',
      settings: { baseURL: 'https://llm.example.edu/v1' },
      headers: { 'X-Campus': '1' },
      models: { fast: { modelID: 'fast-model', name: 'Fast' } },
    });

    expect(state.protocol).toBe('anthropic-messages');
    expect(state.baseURL).toBe('https://llm.example.edu/v1');
    expect(state.headers[0]).toEqual({ row: state.headers[0].row, key: 'X-Campus', value: '1' });
    expect(state.models[0]).toEqual({ ...MODEL_ROW_DEFAULTS, row: state.models[0].row, id: 'fast-model', name: 'Fast', variants: '', savedVariants: {} });
  });

  test('a v2 provider with only a known package still reads as custom', () => {
    expect(isCustomOpenAICompatibleProvider({
      id: 'campus-llm',
      package: 'aisdk:@ai-sdk/openai-compatible',
      models: [],
    })).toBe(true);
  });

  test('requires a config-layer source before treating a provider as editable custom', () => {
    const catalogLike = {
      id: 'openai',
      options: { baseURL: 'https://api.openai.com/v1' },
      models: [{ id: 'gpt-4o', name: 'GPT-4o', api: { npm: '@ai-sdk/openai-compatible' } }],
    };

    expect(isCustomOpenAICompatibleProvider(catalogLike)).toBe(true);
    expect(isConfigDefinedCustomProvider(catalogLike, undefined)).toBe(false);
    expect(isConfigDefinedCustomProvider(catalogLike, {
      user: { exists: false },
      project: { exists: false },
      custom: { exists: false },
    })).toBe(false);
    expect(isConfigDefinedCustomProvider(catalogLike, {
      user: { exists: true },
      project: { exists: false },
    })).toBe(true);
  });

  test('resolveProviderConfigScope follows custom > project > user precedence', () => {
    expect(resolveProviderConfigScope(undefined)).toBe('user');
    expect(resolveProviderConfigScope({
      user: { exists: true },
      project: { exists: false },
      custom: { exists: false },
    })).toBe('user');
    expect(resolveProviderConfigScope({
      user: { exists: true },
      project: { exists: true },
      custom: { exists: false },
    })).toBe('project');
    expect(resolveProviderConfigScope({
      user: { exists: true },
      project: { exists: true },
      custom: { exists: true },
    })).toBe('custom');
    expect(resolveProviderConfigScope({
      user: { exists: false },
      project: { exists: false },
      custom: { exists: true },
    })).toBe('custom');
  });
});

describe('custom provider reasoning levels', () => {
  test('turns typed levels into variants spelled for the protocol', () => {
    const chat = validateCustomProvider({
      form: baseForm({ models: [baseModel({ variants: 'low, medium high,low' })] }),
      t,
      existingProviderIDs: new Set(),
    });
    expect(chat.result?.config.models['model-a'].variants).toEqual([
      { id: 'low', settings: { reasoningEffort: 'low' } },
      { id: 'medium', settings: { reasoningEffort: 'medium' } },
      { id: 'high', settings: { reasoningEffort: 'high' } },
    ]);

    const anthropic = validateCustomProvider({
      form: baseForm({
        protocol: 'anthropic-messages',
        models: [baseModel({ variants: 'max' })],
      }),
      t,
      existingProviderIDs: new Set(),
    });
    expect(anthropic.result?.config.models['model-a'].variants).toEqual([
      { id: 'max', settings: { thinking: { type: 'adaptive', display: 'summarized' }, effort: 'max' } },
    ]);
  });

  test('leaves variants out for a new model without levels', () => {
    const output = validateCustomProvider({ form: baseForm(), t, existingProviderIDs: new Set() });
    expect(output.result?.config.models['model-a']).toEqual({
      modelID: 'model-a',
      name: 'Model A',
    });
  });

  test('edit keeps saved overlays and sends an empty list when levels are cleared', () => {
    const form = providerToCustomFormState({
      id: 'custom-provider',
      name: 'Custom Provider',
      package: 'aisdk:@ai-sdk/openai-compatible',
      settings: { baseURL: 'https://api.example.com/v1' },
      models: [{
        id: 'model-a',
        name: 'Model A',
        variants: [{ id: 'high', settings: { reasoningEffort: 'high' }, body: { think: true } }],
      }],
    });
    expect(form.models[0].variants).toBe('high');

    const kept = validateCustomProvider({
      form: { ...form, models: [{ ...form.models[0], variants: 'high, low' }] },
      t,
      existingProviderIDs: new Set(['custom-provider']),
      editingProviderID: 'custom-provider',
      allowExistingAuth: true,
    });
    expect(kept.result?.config.models['model-a'].variants).toEqual([
      { id: 'high', settings: { reasoningEffort: 'high' }, body: { think: true } },
      { id: 'low', settings: { reasoningEffort: 'low' } },
    ]);

    const cleared = validateCustomProvider({
      form: { ...form, models: [{ ...form.models[0], variants: '' }] },
      t,
      existingProviderIDs: new Set(['custom-provider']),
      editingProviderID: 'custom-provider',
      allowExistingAuth: true,
    });
    expect(cleared.result?.config.models['model-a'].variants).toEqual([]);
  });
});

describe('live OpenCode 2 provider shape', () => {
  // OpenCode serves an `aisdk:` package through its own implementation, so the
  // provider list never echoes the package the form saved.
  const live = (pkg: string) => ({
    id: 'my-provider',
    name: 'My Provider',
    package: pkg,
    settings: { baseURL: 'https://example.invalid/v1', provider: 'my-provider' },
    models: [{ id: 'm-1', modelID: 'm-1', name: 'M1', package: pkg, variants: [] }],
  });

  test('keeps the saved protocol when editing', () => {
    expect(providerToCustomFormState(live('@opencode/ai/providers/openai-compatible')).protocol).toBe('openai-chat');
    expect(providerToCustomFormState(live('@opencode/ai/providers/openai')).protocol).toBe('openai-responses');
    expect(providerToCustomFormState(live('@opencode/ai/providers/anthropic')).protocol).toBe('anthropic-messages');
  });

  test('recognises the native package without a base URL', () => {
    expect(isCustomOpenAICompatibleProvider({ ...live('@opencode/ai/providers/anthropic'), settings: {} })).toBe(true);
  });
});

describe('edit form from the stored config entry', () => {
  // What OpenCode serves: no `env`, and reasoning levels it generated itself.
  const live = {
    id: 'campus-llm',
    name: 'Campus LLM (live)',
    package: '@opencode/ai/providers/openai-compatible',
    settings: { baseURL: 'https://live.example.com/v1' },
    models: [{
      id: 'fast',
      name: 'Fast',
      variants: [{ id: 'low', settings: { reasoningEffort: 'low' } }, { id: 'high', settings: { reasoningEffort: 'high' } }],
    }],
  };

  const editAndSave = (form: CustomProviderFormState) => validateCustomProvider({
    form,
    t,
    existingProviderIDs: new Set(['campus-llm']),
    editingProviderID: 'campus-llm',
    allowExistingAuth: true,
  }).result?.config;

  test('keeps env and writes back only the levels the user stored', () => {
    const stored = storedProviderEntrySchema.parse({
      name: 'Campus LLM',
      package: 'aisdk:@ai-sdk/openai-compatible',
      env: ['CAMPUS_KEY'],
      settings: { baseURL: 'https://llm.example.edu/v1' },
      models: { fast: { modelID: 'fast', name: 'Fast', variants: [{ id: 'max', body: { think: true } }] } },
    });
    const form = providerToEditFormState(live, stored);

    expect(form.name).toBe('Campus LLM');
    expect(form.baseURL).toBe('https://llm.example.edu/v1');
    expect(form.apiKey).toBe('{env:CAMPUS_KEY}');
    expect(form.models[0].variants).toBe('max');

    const config = editAndSave(form);
    expect(config?.env).toEqual(['CAMPUS_KEY']);
    expect(config?.models.fast).toEqual({ modelID: 'fast', name: 'Fast', variants: [{ id: 'max', body: { think: true } }] });
  });

  test('keeps saved limits and capabilities through an edit', () => {
    const stored = storedProviderEntrySchema.parse({
      name: 'Campus LLM',
      settings: { baseURL: 'https://llm.example.edu/v1' },
      models: { vision: {
        name: 'Vision',
        limit: { context: 200000, output: 8192 },
        capabilities: { tools: true, input: ['text', 'image'], output: ['text'] },
      } },
    });
    const config = editAndSave(providerToEditFormState(live, stored));
    expect(config?.models.vision?.limit).toEqual({ context: 200000, output: 8192 });
    expect(config?.models.vision?.capabilities).toEqual({ tools: true, input: ['text', 'image'], output: ['text'] });
  });

  test('a stored model without levels saves without the generated ones', () => {
    const stored = storedProviderEntrySchema.parse({
      name: 'Campus LLM',
      settings: { baseURL: 'https://llm.example.edu/v1' },
      models: { fast: { name: 'Fast' } },
    });
    const form = providerToEditFormState(live, stored);

    expect(form.protocol).toBe('openai-chat');
    expect(form.models[0].variants).toBe('');
    // An empty list: the server drops the key, so no levels are written.
    expect(editAndSave(form)?.models.fast.variants).toEqual([]);
  });

  test('falls back to live fields the entry leaves out, never to live levels', () => {
    const form = providerToEditFormState(live, storedProviderEntrySchema.parse({ env: ['CAMPUS_KEY'] }));

    expect(form.name).toBe('Campus LLM (live)');
    expect(form.baseURL).toBe('https://live.example.com/v1');
    expect(form.models.map((model) => [model.id, model.variants, model.savedVariants])).toEqual([['fast', '', undefined]]);
    expect(editAndSave(form)?.models.fast).toEqual({ modelID: 'fast', name: 'Fast' });
  });

  test('without a stored entry the live levels stay out of the save', () => {
    const form = providerToEditFormState(live, null);
    expect(editAndSave(form)?.models.fast).toEqual({ modelID: 'fast', name: 'Fast' });
  });
});
