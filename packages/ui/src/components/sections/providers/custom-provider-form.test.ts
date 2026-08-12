import { describe, expect, test } from 'bun:test';
import {
  buildAuthSetRequest,
  buildProviderUpsertRequest,
  isConfigDefinedCustomProvider,
  isSupportedCustomProvider,
  providerToCustomFormState,
  resolveProviderConfigScope,
  validateCustomProvider,
  type CustomProviderConfig,
  type CustomProviderFormState,
} from './custom-provider-form';

const t = (key: string) => key;

const baseForm = (overrides: Partial<CustomProviderFormState> = {}): CustomProviderFormState => ({
  providerID: 'custom-provider',
  name: 'Custom Provider',
  protocol: 'openaiChat',
  baseURL: 'https://api.example.com/v1',
  apiKey: 'sk-test',
  models: [{ row: 'm0', id: 'model-a', name: 'Model A' }],
  headers: [{ row: 'h0', key: '', value: '' }],
  ...overrides,
});

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
        models: [{ row: 'm0', id: ' model-a ', name: ' Model A ' }],
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
      name: 'Custom Provider',
      apiKey: 'sk-secret',
      config: {
        npm: '@ai-sdk/openai-compatible',
        name: 'Custom Provider',
        options: {
          baseURL: 'https://api.example.com/v1',
          headers: {
            'X-Test': 'enabled',
          },
        },
        models: {
          'model-a': { name: 'Model A' },
        },
      },
    });
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

  test('maps each API protocol to its OpenCode adapter', () => {
    const protocols = [
      ['openaiChat', '@ai-sdk/openai-compatible'],
      ['openaiResponses', '@ai-sdk/openai'],
      ['anthropicMessages', '@ai-sdk/anthropic'],
    ] as const;

    for (const [protocol, npm] of protocols) {
      const result = validateCustomProvider({
        form: baseForm({ protocol }),
        t,
        existingProviderIDs: new Set(),
      });
      expect(result.result?.config.npm).toBe(npm);
    }
  });

  test('uses protocol-specific defaults for new thinking variants', () => {
    const anthropic = validateCustomProvider({
      form: baseForm({
        protocol: 'anthropicMessages',
        models: [{ row: 'm0', id: 'claude', name: 'Claude', thinkingLevels: 'low, high' }],
      }),
      t,
      existingProviderIDs: new Set(),
    });
    expect(anthropic.result?.config.models.claude.variants).toEqual({
      low: { effort: 'low' },
      high: { effort: 'high' },
    });

    const responses = validateCustomProvider({
      form: baseForm({
        protocol: 'openaiResponses',
        models: [{ row: 'm0', id: 'gpt', name: 'GPT', thinkingLevels: 'low' }],
      }),
      t,
      existingProviderIDs: new Set(),
    });
    expect(responses.result?.config.models.gpt.variants).toEqual({
      low: { reasoningEffort: 'low' },
    });
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
          { row: 'm0', id: 'model-a', name: 'Model A' },
          { row: 'm1', id: 'model-a', name: 'Model A 2' },
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
  test('builds auth.set and provider upsert requests', () => {
    const validated = validateCustomProvider({
      form: baseForm(),
      t,
      existingProviderIDs: new Set(),
    });
    const plan = validated.result!;

    expect(buildAuthSetRequest(plan)).toEqual({
      providerID: 'custom-provider',
      auth: { type: 'api', key: 'sk-test' },
    });
    expect(buildProviderUpsertRequest(plan)).toEqual({
      providerID: 'custom-provider',
      config: plan.config,
      scope: 'user',
    });
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

  test('omits auth.set when using env credentials', () => {
    const validated = validateCustomProvider({
      form: baseForm({ apiKey: '{env:MY_KEY}' }),
      t,
      existingProviderIDs: new Set(),
    });

    expect(buildAuthSetRequest(validated.result!)).toBeNull();
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
  test('detects supported custom providers and prefills form state', () => {
    expect(isSupportedCustomProvider({
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
    expect(state.protocol).toBe('openaiChat');
    expect(state.baseURL).toBe('https://llm.example.edu/v1');
    expect(state.apiKey).toBe('{env:CAMPUS_KEY}');
    expect(state.models[0]).toEqual({
      row: state.models[0].row,
      id: 'fast',
      name: 'Fast',
      inputModalities: [],
      outputModalities: [],
      contextLimit: '',
      inputLimit: '',
      outputLimit: '',
      imageInput: 'default',
      reasoning: 'default',
      toolCalling: 'default',
      thinkingLevels: '',
      variantOptions: {},
    });
    expect(state.headers[0]).toEqual({ row: state.headers[0].row, key: 'X-Campus', value: '1' });
  });

  test('hydrates protocol from provider and resolved model npm metadata', () => {
    expect(providerToCustomFormState({
      id: 'responses-provider',
      npm: '@ai-sdk/openai',
      options: { baseURL: 'https://api.example.com/v1' },
      models: { model: { name: 'Model' } },
    }).protocol).toBe('openaiResponses');

    expect(providerToCustomFormState({
      id: 'anthropic-provider',
      options: { baseURL: 'https://api.example.com/v1' },
      models: [{ id: 'claude', name: 'Claude', api: { npm: '@ai-sdk/anthropic' } }],
    }).protocol).toBe('anthropicMessages');
  });

  test('does not treat supported built-in adapters without a custom base URL as custom providers', () => {
    expect(isSupportedCustomProvider({
      id: 'openai',
      options: {},
      models: [{ id: 'gpt', name: 'GPT', api: { npm: '@ai-sdk/openai' } }],
    })).toBe(false);
  });

  test('hydrates and serializes advanced model metadata without losing variant bodies', () => {
    const state = providerToCustomFormState({
      id: 'campus-llm',
      name: 'Campus LLM',
      env: ['CAMPUS_KEY'],
      options: { baseURL: 'https://llm.example.edu/v1' },
      models: {
        'vision-fast': {
          name: 'Vision Fast',
          reasoning: true,
          attachment: true,
          tool_call: false,
          modalities: { input: ['text', 'image'], output: ['text'] },
          limit: { context: 128000, input: 64000, output: 8192 },
          variants: {
            low: { reasoningEffort: 'low', headers: { 'X-Reasoning': 'low' } },
            high: { reasoningEffort: 'high' },
          },
        },
      },
    });

    expect(state.models[0]).toEqual({
      row: state.models[0].row,
      id: 'vision-fast',
      name: 'Vision Fast',
      inputModalities: ['text', 'image'],
      outputModalities: ['text'],
      contextLimit: '128000',
      inputLimit: '64000',
      outputLimit: '8192',
      imageInput: 'supported',
      reasoning: 'supported',
      toolCalling: 'unsupported',
      thinkingLevels: 'low, high',
      variantOptions: {
        low: { reasoningEffort: 'low', headers: { 'X-Reasoning': 'low' } },
        high: { reasoningEffort: 'high' },
      },
    });

    const result = validateCustomProvider({
      form: state,
      t,
      existingProviderIDs: new Set(),
    });

    expect(result.result?.config.models).toEqual({
      'vision-fast': {
        name: 'Vision Fast',
        reasoning: true,
        attachment: true,
        tool_call: false,
        modalities: { input: ['text', 'image'], output: ['text'] },
        limit: { context: 128000, input: 64000, output: 8192 },
        variants: {
          low: { reasoningEffort: 'low', headers: { 'X-Reasoning': 'low' } },
          high: { reasoningEffort: 'high' },
        },
      },
    });
  });

  test('removes stale image modality when image input is explicitly unsupported', () => {
    const result = validateCustomProvider({
      form: baseForm({
        models: [{
          row: 'm0',
          id: 'text-only',
          name: 'Text only',
          inputModalities: ['text', 'image'],
          imageInput: 'unsupported',
        }],
      }),
      t,
      existingProviderIDs: new Set(),
    });

    expect(result.result?.config.models['text-only']).toEqual({
      name: 'Text only',
      attachment: false,
      modalities: { input: ['text'] },
    });
  });

  test('validates positive limits and duplicate thinking levels', () => {
    const result = validateCustomProvider({
      form: baseForm({
        models: [{
          row: 'm0',
          id: 'model-a',
          name: 'Model A',
          contextLimit: '0',
          inputLimit: '1.5',
          outputLimit: '9007199254740992',
          thinkingLevels: 'low, medium, low',
        }],
      }),
      t,
      existingProviderIDs: new Set(),
    });

    expect(result.result).toEqual(undefined);
    expect(result.models[0]).toEqual({
      id: undefined,
      name: undefined,
      contextLimit: 'settings.providers.page.custom.error.positiveInteger',
      inputLimit: 'settings.providers.page.custom.error.positiveInteger',
      outputLimit: 'settings.providers.page.custom.error.positiveInteger',
      thinkingLevels: 'settings.providers.page.custom.error.duplicate',
    });
  });

  test('requires a config-layer source before treating a provider as editable custom', () => {
    const catalogLike = {
      id: 'openai',
      options: { baseURL: 'https://api.openai.com/v1' },
      models: [{ id: 'gpt-4o', name: 'GPT-4o', api: { npm: '@ai-sdk/openai-compatible' } }],
    };

    expect(isSupportedCustomProvider(catalogLike)).toBe(true);
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
