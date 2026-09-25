import { z } from 'zod';
import type { Model } from '@/lib/opencode/model';

/**
 * Custom provider form helpers.
 * Mirrors OpenCode web UI validation and request construction so a provider
 * can be defined from Settings without code changes.
 */

/**
 * OpenCode 2 names a provider's SDK in `package`, and an AI SDK package carries
 * the `aisdk:` prefix. `@ai-sdk/openai-compatible` is the default because that
 * is what a self-hosted OpenAI-shaped endpoint needs.
 */
export const CUSTOM_PROVIDER_PROTOCOLS = {
  'openai-chat': 'aisdk:@ai-sdk/openai-compatible',
  'openai-responses': 'aisdk:@ai-sdk/openai',
  'anthropic-messages': 'aisdk:@ai-sdk/anthropic',
} as const;
export type CustomProviderProtocol = keyof typeof CUSTOM_PROVIDER_PROTOCOLS;
export type CustomProviderPackage = (typeof CUSTOM_PROVIDER_PROTOCOLS)[CustomProviderProtocol];
export const CUSTOM_PROVIDER_ID = '__custom_provider__';
const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9-_]*$/;
const BASE_URL_PATTERN = /^https?:\/\//;
const ENV_KEY_PATTERN = /^\{env:([^}]+)\}$/;

export type CustomProviderTranslator = (
  key: string,
  vars?: Record<string, string | number | boolean>,
) => string;

/** One reasoning level as OpenCode stores it: an id plus the request change. */
export type ModelVariantConfig = Model['variants'][number];
/** What one reasoning level changes on the request. */
export type ModelVariantOverlay = Omit<ModelVariantConfig, 'id'>;

export type ModelRow = {
  row: string;
  id: string;
  name: string;
  /** Comma-separated reasoning levels, e.g. "low, medium, high". */
  variants: string;
  /**
   * Levels loaded from the saved config, kept verbatim so a hand-written
   * overlay survives an edit. Emptied when the protocol changes; undefined
   * only for rows the user added in this form.
   */
  savedVariants?: Record<string, ModelVariantOverlay>;
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
};

export type HeaderFieldErrors = {
  key?: string;
  value?: string;
};

export type CustomProviderConfig = {
  package: CustomProviderPackage;
  name: string;
  env?: string[];
  settings: {
    baseURL: string;
  };
  headers?: Record<string, string>;
  models: Record<string, CustomProviderModelConfig>;
};

export type CustomProviderModelConfig = {
  modelID: string;
  name: string;
  variants?: ModelVariantConfig[];
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
  env?: string[];
  /** v2 spelling. */
  package?: string;
  settings?: Record<string, unknown> | null;
  headers?: Record<string, string> | null;
  /** v1 spelling, still read from older config entries. */
  options?: Record<string, unknown> | null;
  models?:
    | Array<{
      id?: string;
      modelID?: string;
      name?: string;
      package?: string;
      api?: { npm?: string };
      variants?: readonly ModelVariantConfig[];
    }>
    | Record<string, unknown>;
};

/** The SDK package of a provider or of one of its models, either spelling. */
const readPackage = (
  source: { package?: string; api?: { npm?: string } } | null | undefined,
): string | undefined => {
  if (!source) return undefined;
  if (typeof source.package === 'string' && source.package) return source.package;
  const npm = source.api?.npm;
  return typeof npm === 'string' && npm ? `aisdk:${npm}` : undefined;
};

/** The provider's request settings, v2 `settings` first, v1 `options` after. */
const readSettings = (provider: ProviderLikeForCustomForm): Record<string, unknown> => {
  if (provider.settings && typeof provider.settings === 'object') return provider.settings;
  if (provider.options && typeof provider.options === 'object') return provider.options;
  return {};
};

let rowCounter = 0;

const nextRow = (): string => `row-${rowCounter++}`;

export const createModelRow = (): ModelRow => ({
  row: nextRow(),
  id: '',
  name: '',
  variants: '',
});

/**
 * The request change for one reasoning level, spelled the way OpenCode spells
 * it for its own providers of the same protocol (core/src/variant.ts). The
 * `aisdk:` packages a custom provider uses get no automatic levels there.
 */
export function customVariantOverlay(protocol: CustomProviderProtocol, effort: string): ModelVariantOverlay {
  switch (protocol) {
    case 'openai-chat':
      return { settings: { reasoningEffort: effort } };
    case 'openai-responses':
      return {
        settings: { reasoningEffort: effort, reasoningSummary: 'auto', include: ['reasoning.encrypted_content'] },
      };
    case 'anthropic-messages':
      return { settings: { thinking: { type: 'adaptive', display: 'summarized' }, effort } };
  }
}

export function parseVariantIDs(value: string): string[] {
  const ids = value.split(/[,\s]+/).map((id) => id.trim()).filter(Boolean);
  return ids.filter((id, index) => ids.indexOf(id) === index);
}

function readSavedVariants(variants: readonly ModelVariantConfig[] | undefined): Record<string, ModelVariantOverlay> {
  return Object.fromEntries((variants ?? []).map(({ id, ...overlay }) => [id, overlay]));
}

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

/**
 * The live provider list reports OpenCode's own implementation of an `aisdk:`
 * package (`aisdk:@ai-sdk/openai` is served as `@opencode/ai/providers/openai`),
 * so both spellings map to the protocol the form saved.
 */
const NATIVE_CUSTOM_PROVIDER_PACKAGES: Record<string, CustomProviderProtocol> = {
  '@opencode/ai/providers/openai-compatible': 'openai-chat',
  '@opencode/ai/providers/openai': 'openai-responses',
  '@opencode/ai/providers/anthropic': 'anthropic-messages',
};

function protocolFromPackage(pkg: string | undefined): CustomProviderProtocol {
  const native = pkg ? NATIVE_CUSTOM_PROVIDER_PACKAGES[pkg] : undefined;
  if (native) return native;
  switch (pkg) {
    case 'aisdk:@ai-sdk/openai':
    case '@ai-sdk/openai':
      return 'openai-responses';
    case 'aisdk:@ai-sdk/anthropic':
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
  const settings = readSettings(provider);
  const baseURL = typeof settings.baseURL === 'string' ? settings.baseURL.trim() : '';
  if (baseURL && BASE_URL_PATTERN.test(baseURL)) {
    return true;
  }

  const knownPackages = new Set<string>([
    ...Object.values(CUSTOM_PROVIDER_PROTOCOLS),
    ...Object.keys(NATIVE_CUSTOM_PROVIDER_PACKAGES),
  ]);
  if (knownPackages.has(readPackage(provider) ?? '')) {
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
    // SAFETY: only the two package spellings are read off the entry; anything
    // else stays untouched.
    return knownPackages.has(readPackage(model as { package?: string; api?: { npm?: string } }) ?? '');
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

export function providerToCustomFormState(provider: ProviderLikeForCustomForm): CustomProviderFormState {
  const settings = readSettings(provider);
  const baseURL = typeof settings.baseURL === 'string' ? settings.baseURL : '';
  const headersSource = provider.headers && typeof provider.headers === 'object'
    ? provider.headers
    : (settings.headers && typeof settings.headers === 'object' && !Array.isArray(settings.headers)
      ? settings.headers as Record<string, unknown>
      : {});
  const headerRows = Object.entries(headersSource)
    .filter((entry): entry is [string, string] => typeof entry[0] === 'string' && typeof entry[1] === 'string')
    .map(([key, value]) => ({ row: nextRow(), key, value }));

  const modelEntries = Array.isArray(provider.models)
    ? provider.models
    : (provider.models && typeof provider.models === 'object'
      ? Object.entries(provider.models).map(([id, value]) => {
          const entry = value && typeof value === 'object' ? value as Record<string, unknown> : {};
          return {
            id,
            modelID: typeof entry.modelID === 'string' ? entry.modelID : id,
            name: typeof entry.name === 'string' ? entry.name : id,
            package: typeof entry.package === 'string' ? entry.package : undefined,
            variants: storedVariantsSchema.safeParse(entry.variants).data,
          };
        })
      : []);

  const models = modelEntries.length > 0
    ? modelEntries.map((model) => {
        const id = typeof model?.modelID === 'string' && model.modelID
          ? model.modelID
          : (typeof model?.id === 'string' ? model.id : '');
        const savedVariants = readSavedVariants(model?.variants);
        return {
          row: nextRow(),
          id,
          name: typeof model?.name === 'string' ? model.name : id,
          variants: Object.keys(savedVariants).join(', '),
          savedVariants,
        };
      })
    : [createModelRow()];

  const envName = Array.isArray(provider.env)
    ? provider.env.find((entry) => typeof entry === 'string' && entry.trim().length > 0)?.trim()
    : undefined;

  const modelPackage = modelEntries
    .map((model) => readPackage(model))
    .find((pkg) => Boolean(pkg));

  return {
    providerID: provider.id,
    name: typeof provider.name === 'string' && provider.name.trim() ? provider.name : provider.id,
    protocol: protocolFromPackage(readPackage(provider) ?? modelPackage),
    baseURL,
    apiKey: envName ? `{env:${envName}}` : '',
    models,
    headers: headerRows.length > 0 ? headerRows : [createHeaderRow()],
  };
}

const storedVariantsSchema = z.array(z.object({
  id: z.string(),
  settings: z.record(z.string(), z.unknown()).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.record(z.string(), z.unknown()).optional(),
}));

export const storedProviderEntrySchema = z.object({
  name: z.string().optional(),
  package: z.string().optional(),
  env: z.array(z.string()).optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  models: z.record(z.string(), z.object({
    modelID: z.string().optional(),
    name: z.string().optional(),
    package: z.string().optional(),
    variants: storedVariantsSchema.optional(),
  })).optional(),
});

/**
 * The provider entry as written in the OpenCode config file, returned by
 * `/api/provider/:id/source` in v2 shape. Unlike the live provider it keeps
 * `env` and carries only the reasoning levels the user wrote.
 */
export type StoredProviderEntry = z.infer<typeof storedProviderEntrySchema>;

/**
 * Edit form state for a config-defined provider. The stored entry is the
 * source of truth; the live provider only fills the name, protocol, base URL,
 * or models when the entry leaves them out (inherited from elsewhere). Live reasoning levels are never
 * loaded: OpenCode generates them, and saving them back would write levels the
 * user never configured. Without a stored entry, live models load without
 * levels, so a save leaves the models' stored levels as they are.
 */
export function providerToEditFormState(
  live: ProviderLikeForCustomForm,
  stored: StoredProviderEntry | null,
): CustomProviderFormState {
  const liveModels = Array.isArray(live.models)
    ? live.models.map((model) => ({ ...model, variants: undefined }))
    : live.models;
  const liveState = providerToCustomFormState({ ...live, models: liveModels });
  if (!stored) {
    return { ...liveState, models: liveState.models.map((model) => ({ ...model, savedVariants: undefined })) };
  }

  const storedState = providerToCustomFormState({ ...stored, id: live.id });
  return {
    providerID: live.id,
    name: stored.name?.trim() ? storedState.name : liveState.name,
    protocol: stored.package ? storedState.protocol : liveState.protocol,
    baseURL: storedState.baseURL || liveState.baseURL,
    // The live `env` and headers may come from a built-in provider this one
    // inherits from; only what the entry itself stores is edited here.
    apiKey: storedState.apiKey,
    models: stored.models && Object.keys(stored.models).length > 0
      ? storedState.models
      : liveState.models.map((model) => ({ ...model, savedVariants: undefined })),
    headers: storedState.headers,
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
  const modelErrors = input.form.models.map((model) => {
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
    return { id: modelIdError, name: modelNameError };
  });

  const modelsValid = modelErrors.every((entry) => !entry.id && !entry.name);
  // v2 keeps the model id inside the entry too; the catalog reads `modelID`.
  const modelConfig = Object.fromEntries(
    input.form.models.map((model) => {
      const modelID = model.id.trim();
      const entry: CustomProviderModelConfig = { modelID, name: model.name.trim() };
      const variantIDs = parseVariantIDs(model.variants);
      // A row loaded from config always sends its list, so emptying the field
      // clears saved levels; a new row with no levels leaves the key out.
      if (variantIDs.length > 0 || model.savedVariants !== undefined) {
        entry.variants = variantIDs.map((id) => ({
          id,
          ...(model.savedVariants?.[id] ?? customVariantOverlay(input.form.protocol, id)),
        }));
      }
      return [modelID, entry];
    }),
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
      config: buildCustomProviderConfig({
        protocol: input.form.protocol,
        name,
        env,
        baseURL,
        headers: headerConfig,
        models: modelConfig,
      }),
    },
  };
}

function buildCustomProviderConfig(input: {
  protocol: CustomProviderProtocol;
  name: string;
  env?: string;
  baseURL: string;
  headers: Record<string, string>;
  models: Record<string, CustomProviderModelConfig>;
}): CustomProviderConfig {
  const config: CustomProviderConfig = {
    package: CUSTOM_PROVIDER_PROTOCOLS[input.protocol],
    name: input.name,
    settings: { baseURL: input.baseURL },
    models: input.models,
  };
  if (input.env) config.env = [input.env];
  if (Object.keys(input.headers).length > 0) config.headers = input.headers;
  return config;
}

/**
 * Builds the `integration.connect.key` request body when a literal API key is
 * present. OpenCode v2 stores provider keys as integration credentials; there
 * is no `auth.json` to write any more.
 */
export function buildIntegrationKeyRequest(plan: CustomProviderPersistPlan): {
  integrationID: string;
  key: string;
} | null {
  if (!plan.apiKey) {
    return null;
  }
  return {
    integrationID: plan.providerID,
    key: plan.apiKey,
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
