/**
 * Custom / Other OpenAI and Anthropic provider form helpers.
 * Mirrors OpenCode web UI validation and request construction so a provider
 * can be defined from Settings without code changes.
 */

export const CUSTOM_PROVIDER_PROTOCOLS = {
  openaiChat: '@ai-sdk/openai-compatible',
  openaiResponses: '@ai-sdk/openai',
  anthropicMessages: '@ai-sdk/anthropic',
} as const;
export type CustomProviderProtocol = keyof typeof CUSTOM_PROVIDER_PROTOCOLS;
export type CustomProviderNpm = typeof CUSTOM_PROVIDER_PROTOCOLS[CustomProviderProtocol];
export const DEFAULT_CUSTOM_PROVIDER_PROTOCOL: CustomProviderProtocol = 'openaiChat';
const CUSTOM_PROVIDER_NPMS = new Set<CustomProviderNpm>(Object.values(CUSTOM_PROVIDER_PROTOCOLS));
export const CUSTOM_PROVIDER_ID = '__custom_provider__';
export const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9-_]*$/;
export const BASE_URL_PATTERN = /^https?:\/\//;
export const ENV_KEY_PATTERN = /^\{env:([^}]+)\}$/;

export type CustomProviderTranslator = (
  key: string,
  vars?: Record<string, string | number | boolean>,
) => string;

export type CapabilitySetting = 'default' | 'supported' | 'unsupported';

export type ModelRow = {
  row: string;
  id: string;
  name: string;
  inputModalities?: string[];
  outputModalities?: string[];
  contextLimit?: string;
  inputLimit?: string;
  outputLimit?: string;
  imageInput?: CapabilitySetting;
  reasoning?: CapabilitySetting;
  toolCalling?: CapabilitySetting;
  thinkingLevels?: string;
  variantOptions?: Record<string, Record<string, unknown>>;
};

export type HeaderRow = {
  row: string;
  key: string;
  value: string;
};

export type CustomProviderFormState = {
  providerID: string;
  name: string;
  protocol: CustomProviderProtocol;
  baseURL: string;
  apiKey: string;
  models: ModelRow[];
  headers: HeaderRow[];
};

export type FieldErrors = {
  providerID?: string;
  name?: string;
  baseURL?: string;
  apiKey?: string;
};

export type ModelFieldErrors = {
  id?: string;
  name?: string;
  contextLimit?: string;
  inputLimit?: string;
  outputLimit?: string;
  thinkingLevels?: string;
};

export type HeaderFieldErrors = {
  key?: string;
  value?: string;
};

export type CustomProviderConfig = {
  npm: CustomProviderNpm;
  name: string;
  env?: string[];
  options: {
    baseURL: string;
    headers?: Record<string, string>;
  };
  models: Record<string, {
    name: string;
    reasoning?: boolean;
    attachment?: boolean;
    tool_call?: boolean;
    modalities?: {
      input?: string[];
      output?: string[];
    };
    limit?: {
      context?: number;
      input?: number;
      output?: number;
    };
    variants?: Record<string, Record<string, unknown>>;
  }>;
};

export type CustomProviderPersistPlan = {
  providerID: string;
  name: string;
  /** Literal API key to send via auth.set; omitted when using {env:VAR} or empty. */
  apiKey?: string;
  config: CustomProviderConfig;
};

export type ValidateCustomProviderInput = {
  form: CustomProviderFormState;
  t: CustomProviderTranslator;
  existingProviderIDs: ReadonlySet<string>;
  disabledProviders?: readonly string[];
  /** When editing this provider id, treat it as an allowed update target. */
  editingProviderID?: string;
  /**
   * When true, empty apiKey is allowed because auth.json already has a credential
   * (edit path). Still requires env or key when false.
   */
  allowExistingAuth?: boolean;
};

export type ValidateCustomProviderResult = {
  err: FieldErrors;
  models: ModelFieldErrors[];
  headers: HeaderFieldErrors[];
  result?: CustomProviderPersistPlan;
};

export type ProviderLikeForCustomForm = {
  id: string;
  name?: string;
  npm?: string;
  env?: string[];
  options?: Record<string, unknown> | null;
  models?: Array<Record<string, unknown> & { id?: string; name?: string }> | Record<string, unknown>;
};

let rowCounter = 0;

const nextRow = (): string => `row-${rowCounter++}`;

export const createModelRow = (): ModelRow => ({
  row: nextRow(),
  id: '',
  name: '',
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

export const createHeaderRow = (): HeaderRow => ({
  row: nextRow(),
  key: '',
  value: '',
});

export const createEmptyCustomProviderForm = (): CustomProviderFormState => ({
  providerID: '',
  name: '',
  protocol: DEFAULT_CUSTOM_PROVIDER_PROTOCOL,
  baseURL: '',
  apiKey: '',
  models: [createModelRow()],
  headers: [createHeaderRow()],
});

export function parseEnvApiKey(apiKey: string): { env?: string; key?: string } {
  const trimmed = apiKey.trim();
  if (!trimmed) {
    return {};
  }
  const envMatch = trimmed.match(ENV_KEY_PATTERN);
  const env = envMatch?.[1]?.trim();
  if (env) {
    return { env };
  }
  return { key: trimmed };
}

const protocolForNpm = (npm: unknown): CustomProviderProtocol | undefined => {
  if (typeof npm !== 'string' || !CUSTOM_PROVIDER_NPMS.has(npm as CustomProviderNpm)) return undefined;
  return (Object.entries(CUSTOM_PROVIDER_PROTOCOLS) as Array<[CustomProviderProtocol, CustomProviderNpm]>)
    .find(([, candidate]) => candidate === npm)?.[0];
};

const getProviderProtocol = (provider: ProviderLikeForCustomForm): CustomProviderProtocol | undefined => {
  const direct = protocolForNpm(provider.npm);
  if (direct) return direct;

  const models = Array.isArray(provider.models)
    ? provider.models
    : (provider.models && typeof provider.models === 'object'
      ? Object.values(provider.models)
      : []);

  for (const model of models) {
    if (!model || typeof model !== 'object') continue;
    const api = 'api' in model && model.api && typeof model.api === 'object'
      ? model.api as { npm?: unknown }
      : null;
    const protocol = protocolForNpm(api?.npm);
    if (protocol) return protocol;
  }
  return undefined;
};

export function isSupportedCustomProvider(provider: ProviderLikeForCustomForm): boolean {
  const options = provider.options && typeof provider.options === 'object' ? provider.options : null;
  const baseURL = typeof options?.baseURL === 'string' ? options.baseURL.trim() : '';
  if (!baseURL || !BASE_URL_PATTERN.test(baseURL)) return false;

  const protocol = getProviderProtocol(provider);
  if (protocol) return true;

  const hasExplicitUnsupportedNpm = typeof provider.npm === 'string'
    || (Array.isArray(provider.models) ? provider.models : Object.values(provider.models ?? {})).some((model) => {
      if (!model || typeof model !== 'object' || !('api' in model)) return false;
      const api = model.api;
      return Boolean(api && typeof api === 'object' && typeof (api as { npm?: unknown }).npm === 'string');
    });
  if (hasExplicitUnsupportedNpm) return false;

  // Legacy custom provider payloads may omit npm metadata. They default to
  // OpenAI-compatible Chat Completions when a valid base URL is present.
  return true;
}

export type ProviderConfigSourcesLike = {
  user?: { exists?: boolean };
  project?: { exists?: boolean };
  custom?: { exists?: boolean };
};

export type ProviderConfigScope = 'user' | 'project' | 'custom';

/**
 * True when a provider both looks OpenAI-compatible-custom and is defined in a
 * user/project/custom OpenCode config layer. Catalog-only providers often share
 * the same npm/baseURL signals and must not get Edit / config overrides.
 */
export function isConfigDefinedCustomProvider(
  provider: ProviderLikeForCustomForm,
  sources: ProviderConfigSourcesLike | null | undefined,
): boolean {
  if (!sources) {
    return false;
  }
  const inConfigLayer = Boolean(
    sources.user?.exists || sources.project?.exists || sources.custom?.exists,
  );
  return inConfigLayer && isSupportedCustomProvider(provider);
}

/**
 * Effective writable config layer for a provider, matching OpenCode merge
 * precedence: custom > project > user.
 */
export function resolveProviderConfigScope(
  sources: ProviderConfigSourcesLike | null | undefined,
): ProviderConfigScope {
  if (sources?.custom?.exists) {
    return 'custom';
  }
  if (sources?.project?.exists) {
    return 'project';
  }
  return 'user';
}

export function providerToCustomFormState(provider: ProviderLikeForCustomForm): CustomProviderFormState {
  const options = provider.options && typeof provider.options === 'object' ? provider.options : {};
  const baseURL = typeof options.baseURL === 'string' ? options.baseURL : '';
  const headersRaw = options.headers && typeof options.headers === 'object' && !Array.isArray(options.headers)
    ? options.headers as Record<string, unknown>
    : {};
  const headerRows = Object.entries(headersRaw)
    .filter((entry): entry is [string, string] => typeof entry[0] === 'string' && typeof entry[1] === 'string')
    .map(([key, value]) => ({ row: nextRow(), key, value }));

  const modelEntries = Array.isArray(provider.models)
    ? provider.models.map((model) => ({
        id: model.id,
        name: model.name,
        raw: model as Record<string, unknown>,
      }))
    : (provider.models && typeof provider.models === 'object'
      ? Object.entries(provider.models).map(([id, value]) => ({
          id,
          name: getString(value, 'name') ?? id,
          raw: asRecord(value) ?? {},
        }))
      : []);

  const models = modelEntries.length > 0
    ? modelEntries.map((model) => modelToFormRow({
        id: typeof model.id === 'string' ? model.id : '',
        name: typeof model.name === 'string' ? model.name : (typeof model.id === 'string' ? model.id : ''),
        model: model.raw,
      }))
    : [createModelRow()];

  const envName = Array.isArray(provider.env)
    ? provider.env.find((entry) => typeof entry === 'string' && entry.trim().length > 0)?.trim()
    : undefined;

  return {
    providerID: provider.id,
    name: typeof provider.name === 'string' && provider.name.trim() ? provider.name : provider.id,
    protocol: getProviderProtocol(provider) ?? DEFAULT_CUSTOM_PROVIDER_PROTOCOL,
    baseURL,
    apiKey: envName ? `{env:${envName}}` : '',
    models,
    headers: headerRows.length > 0 ? headerRows : [createHeaderRow()],
  };
}

const MODEL_MODALITIES = new Set(['text', 'audio', 'image', 'video', 'pdf']);

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

const getString = (value: unknown, key: string): string | undefined => {
  const candidate = asRecord(value)[key];
  return typeof candidate === 'string' ? candidate : undefined;
};

const getBoolean = (value: unknown, key: string): boolean | undefined => {
  const candidate = asRecord(value)[key];
  return typeof candidate === 'boolean' ? candidate : undefined;
};

const getNumber = (value: unknown, key: string): number | undefined => {
  const candidate = asRecord(value)[key];
  return typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : undefined;
};

const getCapabilityBoolean = (model: Record<string, unknown>, key: string): boolean | undefined => {
  const direct = getBoolean(model, key);
  if (direct !== undefined) return direct;

  const capabilities = asRecord(model.capabilities);
  if (key === 'tool_call') {
    return getBoolean(capabilities, 'toolcall') ?? getBoolean(capabilities, 'tools');
  }
  return getBoolean(capabilities, key);
};

const getModalities = (model: Record<string, unknown>, direction: 'input' | 'output'): string[] | undefined => {
  const direct = asRecord(model.modalities)[direction];
  const capabilities = asRecord(model.capabilities);
  const candidate = direct ?? capabilities[direction];
  if (Array.isArray(candidate)) {
    return candidate.filter((entry): entry is string => typeof entry === 'string');
  }
  const flags = asRecord(candidate);
  if (Object.keys(flags).length === 0) return undefined;
  return Object.entries(flags)
    .filter(([, supported]) => supported === true)
    .map(([modality]) => modality);
};

const capabilitySetting = (value: boolean | undefined): CapabilitySetting => {
  if (value === true) return 'supported';
  if (value === false) return 'unsupported';
  return 'default';
};

const imageInputSetting = (model: Record<string, unknown>): CapabilitySetting => {
  const modalities = getModalities(model, 'input');
  if (modalities !== undefined) return capabilitySetting(modalities.includes('image'));
  return capabilitySetting(getCapabilityBoolean(model, 'attachment'));
};

const getVariantOptions = (model: Record<string, unknown>): Record<string, Record<string, unknown>> => {
  const variants = model.variants;
  if (Array.isArray(variants)) {
    return Object.fromEntries(
      variants.flatMap((variant) => {
        const entry = asRecord(variant);
        const id = getString(entry, 'id');
        if (!id) return [];
        const body = asRecord(entry.body);
        const directOptions = Object.fromEntries(
          Object.entries(entry).filter(([key]) => key !== 'id' && key !== 'body'),
        );
        return [[id, { ...directOptions, ...body }]];
      }),
    );
  }
  const variantRecord = asRecord(variants);
  return Object.fromEntries(
    Object.entries(variantRecord).map(([id, value]) => [id, asRecord(value)]),
  );
};

const modelToFormRow = ({
  id,
  name,
  model,
}: {
  id: string;
  name: string;
  model: Record<string, unknown>;
}): ModelRow => {
  const limit = asRecord(model.limit);
  const variantOptions = getVariantOptions(model);
  const inputModalities = getModalities(model, 'input');

  return {
    row: nextRow(),
    id,
    name,
    inputModalities: inputModalities ?? [],
    outputModalities: getModalities(model, 'output') ?? [],
    contextLimit: getNumber(limit, 'context')?.toString() ?? '',
    inputLimit: getNumber(limit, 'input')?.toString() ?? '',
    outputLimit: getNumber(limit, 'output')?.toString() ?? '',
    imageInput: inputModalities !== undefined
      ? capabilitySetting(inputModalities.includes('image'))
      : imageInputSetting(model),
    reasoning: capabilitySetting(getCapabilityBoolean(model, 'reasoning')),
    toolCalling: capabilitySetting(getCapabilityBoolean(model, 'tool_call')),
    thinkingLevels: Object.keys(variantOptions).join(', '),
    variantOptions,
  };
};

/**
 * Validates form input and builds the auth + OpenCode provider config payloads.
 */
export function validateCustomProvider(input: ValidateCustomProviderInput): ValidateCustomProviderResult {
  const providerID = input.form.providerID.trim();
  const name = input.form.name.trim();
  const baseURL = input.form.baseURL.trim();
  const { env, key } = parseEnvApiKey(input.form.apiKey);
  const disabledProviders = input.disabledProviders ?? [];
  const editingProviderID = input.editingProviderID?.trim();

  const idError = !providerID
    ? input.t('settings.providers.page.custom.error.providerID.required')
    : !PROVIDER_ID_PATTERN.test(providerID)
      ? input.t('settings.providers.page.custom.error.providerID.format')
      : undefined;

  const nameError = !name
    ? input.t('settings.providers.page.custom.error.name.required')
    : undefined;

  const urlError = !baseURL
    ? input.t('settings.providers.page.custom.error.baseURL.required')
    : !BASE_URL_PATTERN.test(baseURL)
      ? input.t('settings.providers.page.custom.error.baseURL.format')
      : undefined;

  const credentialsSatisfied = Boolean(env || key || (editingProviderID && input.allowExistingAuth && editingProviderID === providerID));
  const apiKeyError = credentialsSatisfied
    ? undefined
    : input.t('settings.providers.page.custom.error.apiKey.required');

  const disabled = disabledProviders.includes(providerID);
  const isSelfEdit = Boolean(editingProviderID && editingProviderID === providerID);
  const existsError = idError || isSelfEdit
    ? undefined
    : input.existingProviderIDs.has(providerID) && !disabled
      ? input.t('settings.providers.page.custom.error.providerID.exists')
      : undefined;

  const seenModels = new Set<string>();
  const normalizedModels = input.form.models.map((model) => {
    const id = typeof model.id === 'string' ? model.id.trim() : '';
    const modelIdError = !id
      ? input.t('settings.providers.page.custom.error.required')
      : seenModels.has(id)
        ? input.t('settings.providers.page.custom.error.duplicate')
        : (() => {
            seenModels.add(id);
            return undefined;
          })();
    const modelName = typeof model.name === 'string' ? model.name.trim() : '';
    const modelNameError = !modelName
      ? input.t('settings.providers.page.custom.error.required')
      : undefined;
    const contextLimit = parseOptionalPositiveInteger(model.contextLimit ?? '', input.t);
    const inputLimit = parseOptionalPositiveInteger(model.inputLimit ?? '', input.t);
    const outputLimit = parseOptionalPositiveInteger(model.outputLimit ?? '', input.t);
    const thinkingLevels = (model.thinkingLevels ?? '')
      .split(',')
      .map((level) => level.trim())
      .filter(Boolean);
    const duplicateThinkingLevel = new Set(thinkingLevels).size !== thinkingLevels.length;
    const errors: ModelFieldErrors = {
      id: modelIdError,
      name: modelNameError,
      ...(contextLimit.error ? { contextLimit: contextLimit.error } : {}),
      ...(inputLimit.error ? { inputLimit: inputLimit.error } : {}),
      ...(outputLimit.error ? { outputLimit: outputLimit.error } : {}),
      ...(duplicateThinkingLevel
        ? { thinkingLevels: input.t('settings.providers.page.custom.error.duplicate') }
        : {}),
    };

    const inputModalities = new Set(
      (model.inputModalities ?? []).filter((modality) => MODEL_MODALITIES.has(modality)),
    );
    const outputModalities = new Set(
      (model.outputModalities ?? []).filter((modality) => MODEL_MODALITIES.has(modality)),
    );
    if (model.imageInput === 'supported') {
      inputModalities.add('text');
      inputModalities.add('image');
    }
    if (model.imageInput === 'unsupported') {
      inputModalities.add('text');
      inputModalities.delete('image');
    }

    const limit = {
      ...(contextLimit.value !== undefined ? { context: contextLimit.value } : {}),
      ...(inputLimit.value !== undefined ? { input: inputLimit.value } : {}),
      ...(outputLimit.value !== undefined ? { output: outputLimit.value } : {}),
    };
    const modalities = {
      ...(inputModalities.size > 0 ? { input: Array.from(inputModalities) } : {}),
      ...(outputModalities.size > 0 ? { output: Array.from(outputModalities) } : {}),
    };
    const variants = Object.fromEntries(
      thinkingLevels.map((level) => [
        level,
        model.variantOptions && Object.prototype.hasOwnProperty.call(model.variantOptions, level)
          ? model.variantOptions[level]
          : input.form.protocol === 'anthropicMessages'
            ? { effort: level }
            : { reasoningEffort: level },
      ]),
    );

    return {
      id,
      errors,
      config: {
        name: modelName,
        ...((model.reasoning ?? 'default') !== 'default' || thinkingLevels.length > 0
          ? { reasoning: thinkingLevels.length > 0 || model.reasoning === 'supported' }
          : {}),
        ...((model.imageInput ?? 'default') !== 'default'
          ? { attachment: model.imageInput === 'supported' }
          : {}),
        ...((model.toolCalling ?? 'default') !== 'default'
          ? { tool_call: model.toolCalling === 'supported' }
          : {}),
        ...(Object.keys(modalities).length > 0 ? { modalities } : {}),
        ...(Object.keys(limit).length > 0 ? { limit } : {}),
        ...(thinkingLevels.length > 0 ? { variants } : {}),
      },
    };
  });

  const modelErrors = normalizedModels.map((model) => model.errors);
  const modelsValid = modelErrors.every((entry) => Object.values(entry).every((error) => !error));
  const modelConfig = Object.fromEntries(
    normalizedModels.map((model) => [model.id, model.config]),
  );

  const seenHeaders = new Set<string>();
  const headerErrors = input.form.headers.map((header) => {
    const headerKey = header.key.trim();
    const headerValue = header.value.trim();
    if (!headerKey && !headerValue) {
      return {};
    }
    const keyError = !headerKey
      ? input.t('settings.providers.page.custom.error.required')
      : seenHeaders.has(headerKey.toLowerCase())
        ? input.t('settings.providers.page.custom.error.duplicate')
        : (() => {
            seenHeaders.add(headerKey.toLowerCase());
            return undefined;
          })();
    const valueError = !headerValue
      ? input.t('settings.providers.page.custom.error.required')
      : undefined;
    return { key: keyError, value: valueError };
  });

  const headersValid = headerErrors.every((entry) => !entry.key && !entry.value);
  const headerConfig = Object.fromEntries(
    input.form.headers
      .map((header) => ({ key: header.key.trim(), value: header.value.trim() }))
      .filter((header) => header.key && header.value)
      .map((header) => [header.key, header.value]),
  );

  const err: FieldErrors = {
    providerID: idError ?? existsError,
    name: nameError,
    baseURL: urlError,
    apiKey: apiKeyError,
  };

  const ok = !idError && !existsError && !nameError && !urlError && !apiKeyError && modelsValid && headersValid;
  if (!ok) {
    return { err, models: modelErrors, headers: headerErrors };
  }

  return {
    err,
    models: modelErrors,
    headers: headerErrors,
    result: {
      providerID,
      name,
      apiKey: key,
      config: {
        npm: CUSTOM_PROVIDER_PROTOCOLS[input.form.protocol],
        name,
        ...(env ? { env: [env] } : {}),
        options: {
          baseURL,
          ...(Object.keys(headerConfig).length > 0 ? { headers: headerConfig } : {}),
        },
        models: modelConfig,
      },
    },
  };
}

function parseOptionalPositiveInteger(
  input: string | undefined,
  t: CustomProviderTranslator,
): { value?: number; error?: string } {
  const trimmed = typeof input === 'string' ? input.trim() : '';
  if (!trimmed) return {};
  if (!/^\d+$/.test(trimmed)) {
    return { error: t('settings.providers.page.custom.error.positiveInteger') };
  }
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value <= 0) {
    return { error: t('settings.providers.page.custom.error.positiveInteger') };
  }
  return { value };
}

/**
 * Builds the OpenCode auth.set request body when a literal API key is present.
 */
export function buildAuthSetRequest(plan: CustomProviderPersistPlan): {
  providerID: string;
  auth: { type: 'api'; key: string };
} | null {
  if (!plan.apiKey) {
    return null;
  }
  return {
    providerID: plan.providerID,
    auth: { type: 'api', key: plan.apiKey },
  };
}

/**
 * Builds the OpenChamber provider upsert request body (config persistence).
 * `scope` selects the OpenCode config layer (user/project/custom). Create
 * defaults to user; edit must pass the provider's effective existing layer.
 */
export function buildProviderUpsertRequest(
  plan: CustomProviderPersistPlan,
  options?: { scope?: ProviderConfigScope },
): {
  providerID: string;
  config: CustomProviderConfig;
  scope: ProviderConfigScope;
} {
  return {
    providerID: plan.providerID,
    config: plan.config,
    scope: options?.scope ?? 'user',
  };
}
