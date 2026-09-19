/**
 * Custom provider form helpers.
 * Mirrors OpenCode web UI validation and request construction so a provider
 * can be defined from Settings without code changes.
 */

export const CUSTOM_PROVIDER_PROTOCOLS = {
  'openai-chat': '@ai-sdk/openai-compatible',
  'openai-responses': '@ai-sdk/openai',
  'anthropic-messages': '@ai-sdk/anthropic',
} as const;
export type CustomProviderProtocol = keyof typeof CUSTOM_PROVIDER_PROTOCOLS;
export type CustomProviderNpm = (typeof CUSTOM_PROVIDER_PROTOCOLS)[CustomProviderProtocol];
export const CUSTOM_PROVIDER_ID = '__custom_provider__';
const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9-_]*$/;
const BASE_URL_PATTERN = /^https?:\/\//;
const ENV_KEY_PATTERN = /^\{env:([^}]+)\}$/;

export type CustomProviderTranslator = (
  key: string,
  vars?: Record<string, string | number | boolean>,
) => string;

export type HeaderRow = {
  row: string;
  key: string;
  value: string;
};

/** Tri-state for `attachment`: '' leaves the field out of the config. */
export type ModelAttachmentState = '' | 'true' | 'false';

type FormJsonValue =
  | string
  | number
  | boolean
  | null
  | FormJsonValue[]
  | { [key: string]: FormJsonValue };
type FormJsonObject = { [key: string]: FormJsonValue };

/** Modality tokens offered as chips; other tokens found in configs are preserved. */
export const MODEL_MODALITY_OPTIONS = ['text', 'image', 'audio', 'video', 'pdf'] as const;

/** Reasoning efforts offered as variant chips; each serializes to `{ reasoningEffort: <name> }`. */
export const MODEL_REASONING_EFFORT_OPTIONS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

const REASONING_EFFORT_OPTION_SET: ReadonlySet<string> = new Set(MODEL_REASONING_EFFORT_OPTIONS);

export type ModelRow = {
  row: string;
  id: string;
  name: string;
  attachment: ModelAttachmentState;
  modalitiesInput: string[];
  modalitiesOutput: string[];
  limitContext?: number;
  limitInput?: number;
  limitOutput?: number;
  variantEfforts: string[];
  // Hand-authored variants the chips cannot express; kept verbatim so editing never loses them.
  variantExtras: FormJsonObject;
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
};

export type HeaderFieldErrors = {
  key?: string;
  value?: string;
};

export type ModelCapabilityConfig = {
  name: string;
  attachment?: boolean;
  modalities?: {
    input?: string[];
    output?: string[];
  };
  limit?: {
    context?: number;
    input?: number;
    output?: number;
  };
  variants?: FormJsonObject;
};

export type CustomProviderConfig = {
  npm: CustomProviderNpm;
  name: string;
  env?: string[];
  options: {
    baseURL: string;
    headers?: Record<string, string>;
  };
  models: Record<string, ModelCapabilityConfig>;
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

export type ProviderModelLikeForCustomForm = {
  id?: string;
  name?: string;
  api?: { npm?: string };
  attachment?: boolean;
  modalities?: { input?: string[]; output?: string[] };
  limit?: { context?: number; input?: number; output?: number };
  /** Read-only view of authored variants; the SDK types values as `unknown`. */
  variants?: { [key: string]: unknown };
};

export type ProviderLikeForCustomForm = {
  id: string;
  name?: string;
  /** Authored protocol adapter (`@ai-sdk/...`) straight from the config block. */
  npm?: string;
  env?: string[];
  options?: Record<string, unknown> | null;
  models?: Array<ProviderModelLikeForCustomForm> | Record<string, ProviderModelLikeForCustomForm>;
};

/**
 * Authored provider block as stored in an OpenCode config layer, where the map
 * key is the provider id. Matches the SDK `Config.provider` entry shape.
 */
export type AuthoredProviderBlock = Omit<ProviderLikeForCustomForm, 'id'> & { id?: string };

/**
 * Stamps the provider id onto an authored provider block handed over by the
 * owning runtime (OpenChamber server route / VS Code bridge). The block carries
 * exactly the keys the user authored — capability fields read from it must not
 * be seeded with resolver defaults from the resolved provider list. Returns
 * null when the runtime delivered no block, which callers must surface as a
 * read failure instead of falling back to resolved data. Both runtimes deliver
 * a plain object or null; fields are validated where they are read.
 */
export function findAuthoredProviderBlock(
  providerId: string,
  block: AuthoredProviderBlock | null | undefined,
): ProviderLikeForCustomForm | null {
  if (!block) {
    return null;
  }
  return { ...block, id: block.id || providerId };
}

let rowCounter = 0;

const nextRow = (): string => `row-${rowCounter++}`;

export const createModelRow = (): ModelRow => ({
  row: nextRow(),
  id: '',
  name: '',
  attachment: '',
  modalitiesInput: [],
  modalitiesOutput: [],
  variantEfforts: [],
  variantExtras: {},
});

export const createHeaderRow = (): HeaderRow => ({
  row: nextRow(),
  key: '',
  value: '',
});

export const createEmptyCustomProviderForm = (): CustomProviderFormState => ({
  providerID: '',
  name: '',
  protocol: 'openai-chat',
  baseURL: '',
  apiKey: '',
  models: [createModelRow()],
  headers: [createHeaderRow()],
});

function protocolFromNpm(npm: string | undefined): CustomProviderProtocol {
  switch (npm) {
    case '@ai-sdk/openai':
      return 'openai-responses';
    case '@ai-sdk/anthropic':
      return 'anthropic-messages';
    default:
      return 'openai-chat';
  }
}

function parseEnvApiKey(apiKey: string): { env?: string; key?: string } {
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

export function isCustomOpenAICompatibleProvider(provider: ProviderLikeForCustomForm): boolean {
  const options = provider.options && typeof provider.options === 'object' ? provider.options : null;
  const baseURL = typeof options?.baseURL === 'string' ? options.baseURL.trim() : '';
  if (baseURL && BASE_URL_PATTERN.test(baseURL)) {
    return true;
  }

  const models = Array.isArray(provider.models)
    ? provider.models
    : (provider.models && typeof provider.models === 'object'
      ? Object.values(provider.models)
      : []);

  return models.some((model) => {
    if (!model || typeof model !== 'object') {
      return false;
    }
    const api = 'api' in model && model.api && typeof model.api === 'object'
      ? model.api as { npm?: unknown }
      : null;
    return typeof api?.npm === 'string' && new Set<string>(Object.values(CUSTOM_PROVIDER_PROTOCOLS)).has(api.npm);
  });
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
  return inConfigLayer && isCustomOpenAICompatibleProvider(provider);
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

function readModalities(model: ProviderModelLikeForCustomForm) {
  return {
    input: model.modalities?.input ?? [],
    output: model.modalities?.output ?? [],
  };
}

function readAttachment(model: ProviderModelLikeForCustomForm): ModelAttachmentState {
  if (model.attachment === true) {
    return 'true';
  }
  if (model.attachment === false) {
    return 'false';
  }
  return '';
}

function readVariants(value: ProviderModelLikeForCustomForm['variants']) {
  const efforts: string[] = [];
  const extras: FormJsonObject = {};
  for (const [name, rawValue] of Object.entries(value ?? {})) {
    const jsonText = JSON.stringify(rawValue ?? {});
    if (REASONING_EFFORT_OPTION_SET.has(name) && jsonText === JSON.stringify({ reasoningEffort: name })) {
      efforts.push(name);
      continue;
    }
    try {
      // SAFETY: jsonText comes straight from JSON.stringify, so parsing it back yields a JSON value.
      extras[name] = JSON.parse(jsonText) as FormJsonValue;
    } catch {
      extras[name] = {};
    }
  }
  return { efforts, extras };
}

function modelRowFromProviderModel(model: ProviderModelLikeForCustomForm): ModelRow {
  const id = model.id ?? '';
  const modalities = readModalities(model);
  const variants = readVariants(model.variants);
  return {
    row: nextRow(),
    id,
    name: model.name || id,
    attachment: readAttachment(model),
    modalitiesInput: modalities.input,
    modalitiesOutput: modalities.output,
    limitContext: model.limit?.context,
    limitInput: model.limit?.input,
    limitOutput: model.limit?.output,
    variantEfforts: variants.efforts,
    variantExtras: variants.extras,
  };
}

function serializeModelConfig(model: ModelRow): ModelCapabilityConfig {
  const entry: ModelCapabilityConfig = { name: model.name.trim() };

  if (model.attachment === 'true') {
    entry.attachment = true;
  } else if (model.attachment === 'false') {
    entry.attachment = false;
  }

  if (model.modalitiesInput.length > 0 || model.modalitiesOutput.length > 0) {
    const modalities: NonNullable<ModelCapabilityConfig['modalities']> = {};
    if (model.modalitiesInput.length > 0) {
      modalities.input = [...model.modalitiesInput];
    }
    if (model.modalitiesOutput.length > 0) {
      modalities.output = [...model.modalitiesOutput];
    }
    entry.modalities = modalities;
  }

  const limit: NonNullable<ModelCapabilityConfig['limit']> = {};
  if (model.limitContext !== undefined) {
    limit.context = model.limitContext;
  }
  if (model.limitInput !== undefined) {
    limit.input = model.limitInput;
  }
  if (model.limitOutput !== undefined) {
    limit.output = model.limitOutput;
  }
  if (Object.keys(limit).length > 0) {
    entry.limit = limit;
  }

  const variants: FormJsonObject = {};
  for (const effort of model.variantEfforts) {
    variants[effort] = { reasoningEffort: effort };
  }
  for (const [name, value] of Object.entries(model.variantExtras)) {
    variants[name] = value;
  }
  if (Object.keys(variants).length > 0) {
    entry.variants = variants;
  }

  return entry;
}

/**
 * Maps an authored provider config block into editable form state.
 * Expects the raw config-layer block (`findAuthoredProviderBlock` result) —
 * capability fields reflect exactly the keys the user authored, so unsetting
 * one in the form and saving deletes it instead of materializing resolver
 * defaults from the resolved provider list.
 */
export function providerToCustomFormState(provider: ProviderLikeForCustomForm): CustomProviderFormState {
  const options = provider.options && typeof provider.options === 'object' ? provider.options : {};
  const baseURL = typeof options.baseURL === 'string' ? options.baseURL : '';
  const headersRaw = options.headers && typeof options.headers === 'object' && !Array.isArray(options.headers)
    ? options.headers as Record<string, unknown>
    : {};
  const headerRows = Object.entries(headersRaw)
    .filter((entry): entry is [string, string] => typeof entry[0] === 'string' && typeof entry[1] === 'string')
    .map(([key, value]) => ({ row: nextRow(), key, value }));

  const rawModelEntries: ProviderModelLikeForCustomForm[] = Array.isArray(provider.models)
    ? provider.models
    : (provider.models && typeof provider.models === 'object'
      ? Object.entries(provider.models).map(([id, value]) => ({ ...value, id: value?.id ?? id }))
      : []);

  const models = rawModelEntries.length > 0
    ? rawModelEntries.map(modelRowFromProviderModel)
    : [createModelRow()];

  const envName = Array.isArray(provider.env)
    ? provider.env.find((entry) => typeof entry === 'string' && entry.trim().length > 0)?.trim()
    : undefined;

  const modelWithApi = rawModelEntries.find((model) => model && typeof model.api === 'object' && model.api !== null);

  return {
    providerID: provider.id,
    name: typeof provider.name === 'string' && provider.name.trim() ? provider.name : provider.id,
    protocol: protocolFromNpm(provider.npm || modelWithApi?.api?.npm),
    baseURL,
    apiKey: envName ? `{env:${envName}}` : '',
    models,
    headers: headerRows.length > 0 ? headerRows : [createHeaderRow()],
  };
}

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
  const modelErrors: ModelFieldErrors[] = input.form.models.map((model) => {
    const id = model.id.trim();
    const modelIdError = !id
      ? input.t('settings.providers.page.custom.error.required')
      : seenModels.has(id)
        ? input.t('settings.providers.page.custom.error.duplicate')
        : (() => {
            seenModels.add(id);
            return undefined;
          })();
    const modelNameError = !model.name.trim()
      ? input.t('settings.providers.page.custom.error.required')
      : undefined;

    return {
      id: modelIdError,
      name: modelNameError,
    };
  });

  const modelsValid = modelErrors.every((entry) => !entry.id && !entry.name);
  const modelConfig = Object.fromEntries(
    input.form.models.map((model) => [model.id.trim(), serializeModelConfig(model)]),
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
 *
 * `manageModelCapabilities` tells the server this form authors the four model
 * capability fields (attachment/modalities/limit/variants), so it should apply
 * removals rather than passively preserving stale values for those keys.
 */
export function buildProviderUpsertRequest(
  plan: CustomProviderPersistPlan,
  options?: { scope?: ProviderConfigScope },
): {
  providerID: string;
  config: CustomProviderConfig;
  scope: ProviderConfigScope;
  manageModelCapabilities: true;
} {
  return {
    providerID: plan.providerID,
    config: plan.config,
    scope: options?.scope ?? 'user',
    manageModelCapabilities: true,
  };
}
