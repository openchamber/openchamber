import { describe, expect, test } from 'bun:test';
import {
  buildAuthSetRequest,
  buildProviderUpsertRequest,
  findAuthoredProviderBlock,
  isConfigDefinedCustomProvider,
  isCustomOpenAICompatibleProvider,
  providerToCustomFormState,
  resolveProviderConfigScope,
  validateCustomProvider,
  type CustomProviderConfig,
  type CustomProviderFormState,
  type ModelRow,
} from './custom-provider-form';

const t = (key: string) => key;

/** A ModelRow with the capability defaults the form always provides. */
const modelRow = (overrides: Partial<ModelRow> & Pick<ModelRow, 'id' | 'name'>): ModelRow => ({
  row: 'm0',
  attachment: '',
  modalitiesInput: [],
  modalitiesOutput: [],
  variantEfforts: [],
  variantExtras: {},
  ...overrides,
});

const baseForm = (overrides: Partial<CustomProviderFormState> = {}): CustomProviderFormState => ({
  providerID: 'custom-provider',
  name: 'Custom Provider',
  protocol: 'openai-chat',
  baseURL: 'https://api.example.com/v1',
  apiKey: 'sk-test',
  models: [modelRow({ row: 'm0', id: 'model-a', name: 'Model A' })],
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
        models: [modelRow({ row: 'm0', id: ' model-a ', name: ' Model A ' })],
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

  test('uses the selected OpenCode provider adapter', () => {
    const result = validateCustomProvider({
      form: baseForm({ protocol: 'openai-responses' }),
      t,
      existingProviderIDs: new Set(),
    });

    expect(result.result?.config.npm).toBe('@ai-sdk/openai');
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
          modelRow({ row: 'm0', id: 'model-a', name: 'Model A' }),
          modelRow({ row: 'm1', id: 'model-a', name: 'Model A 2' }),
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

describe('model capability serialization', () => {
  const configFor = (model: ModelRow) => {
    const validated = validateCustomProvider({
      form: baseForm({ models: [model] }),
      t,
      existingProviderIDs: new Set(),
    });
    return validated.result?.config.models[model.id.trim()];
  };

  test('emits only the fields the model actually sets', () => {
    expect(configFor(modelRow({ row: 'm0', id: 'model-a', name: 'Model A' }))).toEqual({
      name: 'Model A',
    });
  });

  test('serializes attachment, modalities, limit, and variants', () => {
    const config = configFor(modelRow({
      row: 'm0',
      id: 'model-a',
      name: 'Model A',
      attachment: 'true',
      modalitiesInput: ['text', 'image'],
      modalitiesOutput: ['text'],
      limitContext: 200000,
      limitInput: 100000,
      variantEfforts: ['low'],
      variantExtras: { plain: {} },
    }));

    expect(config).toEqual({
      name: 'Model A',
      attachment: true,
      modalities: { input: ['text', 'image'], output: ['text'] },
      limit: { context: 200000, input: 100000 },
      variants: { low: { reasoningEffort: 'low' }, plain: {} },
    });
  });

  test('keeps attachment:false but omits the unset tri-state', () => {
    expect(configFor(modelRow({ row: 'm0', id: 'm', name: 'M', attachment: 'false' })))
      .toEqual({ name: 'M', attachment: false });
    expect(configFor(modelRow({ row: 'm0', id: 'm', name: 'M', attachment: '' })))
      .toEqual({ name: 'M' });
  });
});

describe('model capability read-back', () => {
  test('reconstructs capability form state from a provider model', () => {
    const state = providerToCustomFormState({
      id: 'p',
      options: { baseURL: 'https://x.example.com/v1' },
      models: [{
        id: 'm',
        name: 'M',
        attachment: true,
        modalities: { input: ['text', 'image'], output: ['text'] },
        limit: { context: 128000, output: 4096 },
        variants: {
          low: { reasoningEffort: 'low' },
          high: { reasoningEffort: 'medium' },
          plain: {},
        },
      }],
    });

    const model = state.models[0];
    expect(model.attachment).toBe('true');
    expect(model.modalitiesInput).toEqual(['text', 'image']);
    expect(model.modalitiesOutput).toEqual(['text']);
    expect(model.limitContext).toBe(128000);
    expect(model.limitOutput).toBe(4096);
    expect(model.limitInput).toBeUndefined();
    // Only exact `{ reasoningEffort: <name> }` entries light up chips; the rest is preserved verbatim.
    expect(model.variantEfforts).toEqual(['low']);
    expect(model.variantExtras).toEqual({ high: { reasoningEffort: 'medium' }, plain: {} });

    const roundTrip = validateCustomProvider({
      form: { ...baseForm(), models: [model] },
      t,
      existingProviderIDs: new Set(),
    });
    expect(roundTrip.result?.config.models.m?.variants).toEqual({
      low: { reasoningEffort: 'low' },
      high: { reasoningEffort: 'medium' },
      plain: {},
    });
  });

  test('leaves capabilities unset when the authored block has no capability keys', () => {
    // Regression guard: a config-defined model always carries resolver defaults
    // (attachment false, text-only modalities, zero limits) in the resolved
    // provider list. Read-back must come from the authored block, so a no-op
    // edit must not seed the form — and the save that follows — with those
    // defaults under manageModelCapabilities.
    const state = providerToCustomFormState({
      id: 'p',
      npm: '@ai-sdk/openai-compatible',
      name: 'Campus LLM',
      env: ['CAMPUS_KEY'],
      options: { baseURL: 'https://x.example.com/v1' },
      models: { m: { name: 'M' } },
    });

    expect(state.protocol).toBe('openai-chat');
    expect(state.apiKey).toBe('{env:CAMPUS_KEY}');
    const model = state.models[0];
    expect(model.attachment).toBe('');
    expect(model.modalitiesInput).toEqual([]);
    expect(model.modalitiesOutput).toEqual([]);
    expect(model.limitContext).toBeUndefined();
    expect(model.limitInput).toBeUndefined();
    expect(model.limitOutput).toBeUndefined();
    expect(model.variantEfforts).toEqual([]);
    expect(model.variantExtras).toEqual({});

    // Saving this read-back must round-trip without inventing capability keys.
    const roundTrip = validateCustomProvider({
      form: { ...baseForm(), models: [model] },
      t,
      existingProviderIDs: new Set(),
    });
    expect(roundTrip.result?.config.models.m).toEqual({ name: 'M' });
  });

  test('prefills the protocol from the authored provider npm over the model api', () => {
    const state = providerToCustomFormState({
      id: 'responses-api',
      npm: '@ai-sdk/anthropic',
      options: { baseURL: 'https://api.example.com/v1' },
      models: [{ id: 'gpt', name: 'GPT', api: { npm: '@ai-sdk/openai' } }],
    });

    expect(state.protocol).toBe('anthropic-messages');
  });
});

describe('findAuthoredProviderBlock', () => {
  test('stamps the provider id from the map key onto the authored block', () => {
    const authored = findAuthoredProviderBlock('campus-llm', {
      npm: '@ai-sdk/openai-compatible',
      name: 'Campus LLM',
      env: ['CAMPUS_KEY'],
      options: { baseURL: 'https://llm.example.edu/v1' },
      models: { fast: { name: 'Fast' } },
    });

    expect(authored).toEqual({
      id: 'campus-llm',
      npm: '@ai-sdk/openai-compatible',
      name: 'Campus LLM',
      env: ['CAMPUS_KEY'],
      options: { baseURL: 'https://llm.example.edu/v1' },
      models: { fast: { name: 'Fast' } },
    });
  });

  test('keeps an explicit block id and rejects missing blocks', () => {
    expect(findAuthoredProviderBlock('p', { id: 'authored-id' })?.id).toBe('authored-id');
    expect(findAuthoredProviderBlock('p', undefined)).toBeNull();
    expect(findAuthoredProviderBlock('p', null)).toBeNull();
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
      manageModelCapabilities: true,
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
    expect(state.models[0]).toEqual({
      row: state.models[0].row,
      id: 'fast',
      name: 'Fast',
      attachment: '',
      modalitiesInput: [],
      modalitiesOutput: [],
      limitContext: undefined,
      limitInput: undefined,
      limitOutput: undefined,
      variantEfforts: [],
      variantExtras: {},
    });
    expect(state.headers[0]).toEqual({ row: state.headers[0].row, key: 'X-Campus', value: '1' });
  });

  test('prefills the protocol from a custom provider model', () => {
    const state = providerToCustomFormState({
      id: 'responses-api',
      options: { baseURL: 'https://api.example.com/v1' },
      models: [{ id: 'gpt', name: 'GPT', api: { npm: '@ai-sdk/openai' } }],
    });

    expect(state.protocol).toBe('openai-responses');
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
