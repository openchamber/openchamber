import { z } from 'zod';
import { editableCapabilities, resolveDiscoveredCapabilities } from './model-capabilities';
import type { Model } from '@/lib/opencode/model';
import type { CustomProviderIcon } from '@/lib/customProviderIcons';
import { storedCapabilitiesSchema, storedLimitSchema, storedVariantsSchema, type InheritedCanonical, type StoredProviderSource } from './stored-provider-entry';

export { storedProviderEntrySchema, type StoredProviderSource } from './stored-provider-entry';


export const CUSTOM_PROVIDER_PROTOCOLS = {
  'openai-chat': 'aisdk:@ai-sdk/openai-compatible',
  'openai-responses': 'aisdk:@ai-sdk/openai',
  'anthropic-messages': 'aisdk:@ai-sdk/anthropic',
} as const;
export type CustomProviderProtocol = keyof typeof CUSTOM_PROVIDER_PROTOCOLS;
export type CustomProviderPackage = (typeof CUSTOM_PROVIDER_PROTOCOLS)[CustomProviderProtocol]
  | keyof typeof NATIVE_CUSTOM_PROVIDER_PACKAGES;
export const CUSTOM_PROVIDER_ID = '__custom_provider__';
const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9-_]*$/;
const BASE_URL_PATTERN = /^https?:\/\//;
const ENV_KEY_PATTERN = /^\{env:([^}]+)\}$/;

export type CustomProviderTranslator = (
  key: string,
  vars?: Record<string, string | number | boolean>,
) => string;

type ModelVariantConfig = Model['variants'][number];
export type ModelVariantOverlay = Omit<ModelVariantConfig, 'id'>;

export type ModelRow = {
  row: string;
  id: string;
  name: string;
  contextWindow: string;
  maxOutputTokens: string;
  inputCapabilities: string[];
  outputCapabilities: string[];
  tools: boolean;
  type?: string;
  capabilitiesKnown: KnownCapabilities;
  metadataSource?: 'provider-api' | 'models.dev' | 'manual';
  variants: string;
  savedVariants?: Record<string, ModelVariantOverlay>;
};

export type KnownCapabilities = { tools: boolean; input: boolean; output: boolean };

const NO_KNOWN_CAPABILITIES: KnownCapabilities = { tools: false, input: false, output: false };
const knownCapabilitiesOf = (capabilities: { tools?: boolean; input?: string[]; output?: string[] } | undefined): KnownCapabilities => ({
  tools: capabilities?.tools !== undefined,
  input: capabilities?.input !== undefined,
  output: capabilities?.output !== undefined,
});

export type HeaderRow = {
  row: string;
  key: string;
  value: string;
};

export type CustomProviderLogoPlan =
  | { kind: 'keep' }
  | { kind: 'remove' }
  | { kind: 'upload'; file: File };

export type ClientCertificateFields = {
  cert: string;
  key: string;
  passphrase: string;
};

export type CustomProviderFormState = {
  providerID: string;
  name: string;
  icon: CustomProviderIcon | null;
  logo: File | 'removed' | null;
  protocol: CustomProviderProtocol;
  package?: CustomProviderPackage;
  baseURL: string;
  apiKey: string;
  models: ModelRow[];
  headers: HeaderRow[];
  tls: ClientCertificateFields | null;
  canonical: string | null;
  inheritedCanonical?: InheritedCanonical;
};

export type FieldErrors = {
  providerID?: string;
  name?: string;
  baseURL?: string;
  apiKey?: string;
  tlsCert?: string;
  tlsKey?: string;
};

export type ModelFieldErrors = {
  id?: string;
  name?: string;
  contextWindow?: string;
  maxOutputTokens?: string;
};

export type HeaderFieldErrors = {
  key?: string;
  value?: string;
};

export type CustomProviderConfig = {
  package: CustomProviderPackage;
  name: string;
  canonical?: string | null;
  env?: string[];
  settings: {
    baseURL: string;
    tls?: StoredClientCertificate | null;
  };
  headers?: Record<string, string>;
  models: Record<string, CustomProviderModelConfig>;
};

export type StoredClientCertificate = { cert: string; key: string; passphrase?: string };

export type CustomProviderModelConfig = {
  modelID: string;
  name: string;
  type?: string;
  variants?: ModelVariantConfig[];
  limit?: { context?: number; output?: number };
  capabilities?: { tools?: boolean; input?: string[]; output?: string[] };
};

export type CustomProviderPersistPlan = {
  providerID: string;
  name: string;
  icon: CustomProviderIcon | null;
  logo: CustomProviderLogoPlan;
  apiKey?: string;
  keepsStoredCredential?: boolean;
  config: CustomProviderConfig;
};

export type ValidateCustomProviderInput = {
  form: CustomProviderFormState;
  t: CustomProviderTranslator;
  existingProviderIDs: ReadonlySet<string>;
  disabledProviders?: readonly string[];
  editingProviderID?: string;
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
  canonical?: string;
  env?: string[];
  package?: string;
  settings?: Record<string, unknown> | null;
  headers?: Record<string, string> | null;
  options?: Record<string, unknown> | null;
  models?:
    | Array<{
      id?: string;
      modelID?: string;
      name?: string;
      type?: string;
      package?: string;
      api?: { npm?: string };
      variants?: readonly ModelVariantConfig[];
      limit?: { context?: number; output?: number };
      capabilities?: { tools?: boolean; input?: string[]; output?: string[] };
    }>
    | Record<string, unknown>;
};

const readPackage = (
  source: { package?: string; api?: { npm?: string } } | null | undefined,
): string | undefined => {
  if (!source) return undefined;
  if (typeof source.package === 'string' && source.package) return source.package;
  const npm = source.api?.npm;
  return typeof npm === 'string' && npm ? `aisdk:${npm}` : undefined;
};

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
  contextWindow: '',
  maxOutputTokens: '',
  inputCapabilities: ['text'],
  outputCapabilities: ['text'],
  tools: true,
  capabilitiesKnown: NO_KNOWN_CAPABILITIES,
  variants: '',
});

const discoveredLimitSchema = z.object({ context: z.number().optional(), output: z.number().optional() });
const discoveredModelSchema = z.object({
  id: z.string(),
  name: z.string(),
  limit: discoveredLimitSchema.optional(),
  capabilities: storedCapabilitiesSchema.optional(),
  metadata: z.object({
    providerID: z.string(),
    modelID: z.string(),
    name: z.string().optional(),
    limit: discoveredLimitSchema.optional(),
    capabilities: storedCapabilitiesSchema.optional(),
  }).optional(),
});

export const modelDiscoveryResponseSchema = z.object({ models: z.array(discoveredModelSchema) });
export const modelDiscoveryErrorSchema = z.object({ error: z.string() });

export type DiscoveredModel = z.infer<typeof discoveredModelSchema>;

export const modelRowFromDiscovery = (model: DiscoveredModel): ModelRow => {
  const metadata = model.metadata;
  const context = model.limit?.context ?? metadata?.limit?.context;
  const output = model.limit?.output ?? metadata?.limit?.output;
  const capabilities = resolveDiscoveredCapabilities(model.capabilities, metadata?.capabilities);
  const describedByProvider = Boolean(model.limit || model.capabilities);
  return {
    ...createModelRow(),
    id: model.id,
    name: model.name !== model.id ? model.name : (metadata?.name ?? model.id),
    contextWindow: context ? String(context) : '',
    maxOutputTokens: output ? String(output) : '',
    ...editableCapabilities(capabilities),
    tools: capabilities.tools ?? true,
    capabilitiesKnown: knownCapabilitiesOf(capabilities),
    ...(describedByProvider
      ? { metadataSource: 'provider-api' as const }
      : metadata ? { metadataSource: 'models.dev' as const } : {}),
  };
};

function customVariantOverlay(protocol: CustomProviderProtocol, effort: string): ModelVariantOverlay {
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

function parseVariantIDs(value: string): string[] {
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

export const EMPTY_CLIENT_CERTIFICATE: ClientCertificateFields = { cert: '', key: '', passphrase: '' };

export const createEmptyCustomProviderForm = (): CustomProviderFormState => ({
  providerID: '',
  name: '',
  icon: null,
  logo: null,
  protocol: 'openai-chat',
  baseURL: '',
  apiKey: '',
  models: [createModelRow()],
  headers: [createHeaderRow()],
  tls: EMPTY_CLIENT_CERTIFICATE,
  canonical: '',
});

const FILE_REFERENCE_PATTERN = /^\{file:([^}]+)\}$/;

const storedTlsSchema = z.object({
  cert: z.string().optional(),
  key: z.string().optional(),
  passphrase: z.string().optional(),
});
type StoredTlsFields = z.infer<typeof storedTlsSchema>;

const clientCertificateFieldOf = (value: string | undefined): string => {
  if (value === undefined) return '';
  return value.trim().match(FILE_REFERENCE_PATTERN)?.[1]?.trim() ?? value;
};

const storedClientCertificateValueOf = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith('{') || trimmed.includes('-----BEGIN')) return trimmed;
  return `{file:${trimmed}}`;
};

const isRelativeCertificatePath = (value: string): boolean => {
  const trimmed = value.trim();
  const path = trimmed.match(FILE_REFERENCE_PATTERN)?.[1]?.trim()
    ?? (trimmed.startsWith('{') || trimmed.includes('-----BEGIN') ? '' : trimmed);
  return Boolean(path) && !/^(\/|~\/|[A-Za-z]:[\\/]|\\\\)/.test(path);
};

const clientCertificateFieldsOf = (stored: StoredTlsFields | undefined): ClientCertificateFields => {
  if (!stored) return EMPTY_CLIENT_CERTIFICATE;
  return {
    cert: clientCertificateFieldOf(stored.cert),
    key: clientCertificateFieldOf(stored.key),
    passphrase: stored.passphrase ?? '',
  };
};

export const storedClientCertificateOf = (
  fields: ClientCertificateFields | null,
): StoredClientCertificate | null | undefined => {
  if (fields === null) return undefined;
  const cert = storedClientCertificateValueOf(fields.cert);
  const key = storedClientCertificateValueOf(fields.key);
  const passphrase = fields.passphrase.trim() ? fields.passphrase : '';
  if (!cert && !key && !passphrase) return null;
  const stored: StoredClientCertificate = { cert, key };
  if (passphrase) stored.passphrase = passphrase;
  return stored;
};

const NATIVE_CUSTOM_PROVIDER_PACKAGES = {
  '@opencode/ai/providers/openai-compatible': 'openai-chat',
  '@opencode/ai/providers/openai-compatible/responses': 'openai-responses',
  '@opencode/ai/providers/openai-compatible-responses': 'openai-responses',
  '@opencode/ai/providers/openai': 'openai-responses',
  '@opencode/ai/providers/openai/chat': 'openai-chat',
  '@opencode/ai/providers/openai/responses': 'openai-responses',
  '@opencode/ai/providers/anthropic': 'anthropic-messages',
  '@opencode/ai/providers/anthropic-compatible': 'anthropic-messages',
} as const;

function isNativeCustomProviderPackage(pkg: string | undefined): pkg is keyof typeof NATIVE_CUSTOM_PROVIDER_PACKAGES {
  return pkg !== undefined && Object.hasOwn(NATIVE_CUSTOM_PROVIDER_PACKAGES, pkg);
}

function protocolFromPackage(pkg: string | undefined): CustomProviderProtocol {
  if (isNativeCustomProviderPackage(pkg)) return NATIVE_CUSTOM_PROVIDER_PACKAGES[pkg];
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
            type: z.string().safeParse(entry.type).data,
            package: typeof entry.package === 'string' ? entry.package : undefined,
            variants: storedVariantsSchema.safeParse(entry.variants).data,
            limit: storedLimitSchema.safeParse(entry.limit).data,
            capabilities: storedCapabilitiesSchema.safeParse(entry.capabilities).data,
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
          contextWindow: model.limit?.context ? String(model.limit.context) : '',
          maxOutputTokens: model.limit?.output ? String(model.limit.output) : '',
          inputCapabilities: model.capabilities?.input ?? ['text'],
          outputCapabilities: model.capabilities?.output ?? ['text'],
          tools: model.capabilities?.tools ?? true,
          type: model.type,
          capabilitiesKnown: knownCapabilitiesOf(model.capabilities),
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
    icon: null,
    logo: null,
    protocol: protocolFromPackage(readPackage(provider) ?? modelPackage),
    baseURL,
    apiKey: envName ? `{env:${envName}}` : '',
    models,
    headers: headerRows.length > 0 ? headerRows : [createHeaderRow()],
    tls: clientCertificateFieldsOf(storedTlsSchema.safeParse(settings.tls).data),
    canonical: provider.canonical ?? '',
  };
}

function withInheritedCapabilities(model: ModelRow, live: ModelRow | undefined): ModelRow {
  if (!live) return model;
  return {
    ...model,
    tools: model.capabilitiesKnown.tools ? model.tools : live.tools,
    inputCapabilities: model.capabilitiesKnown.input ? model.inputCapabilities : live.inputCapabilities,
    outputCapabilities: model.capabilitiesKnown.output ? model.outputCapabilities : live.outputCapabilities,
  };
}

export function providerToEditFormState(
  live: ProviderLikeForCustomForm,
  stored: StoredProviderSource | null,
  icon: CustomProviderIcon | null = null,
): CustomProviderFormState {
  const liveModels = Array.isArray(live.models)
    ? live.models.map((model) => ({ ...model, variants: undefined }))
    : live.models;
  const liveState = providerToCustomFormState({ ...live, models: liveModels });
  const liveRows = liveState.models.map((model) => ({
    ...model,
    ...editableCapabilities({ input: model.inputCapabilities, output: model.outputCapabilities }),
    savedVariants: undefined,
  }));
  if (!stored) {
    return {
      ...liveState,
      icon,
      models: liveRows,
      tls: null,
      canonical: null,
    };
  }

  const storedState = providerToCustomFormState({ ...stored, id: live.id });
  return {
    providerID: live.id,
    name: stored.name?.trim() ? storedState.name : liveState.name,
    icon,
    logo: null,
    protocol: stored.package ? storedState.protocol : liveState.protocol,
    package: isNativeCustomProviderPackage(stored.package) ? stored.package : undefined,
    baseURL: storedState.baseURL || liveState.baseURL,
    apiKey: storedState.apiKey,
    models: stored.models && Object.keys(stored.models).length > 0
      ? storedState.models.map((model) => withInheritedCapabilities(model, liveRows.find((entry) => entry.id === model.id)))
      : liveRows,
    headers: storedState.headers,
    tls: storedState.tls,
    canonical: storedState.canonical,
    inheritedCanonical: stored.inheritedCanonical,
  };
}

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
    const contextWindowError = model.contextWindow.trim() && !parsePositiveInteger(model.contextWindow)
      ? input.t('settings.providers.page.custom.error.positiveInteger')
      : undefined;
    const maxOutputTokensError = model.maxOutputTokens.trim() && !parsePositiveInteger(model.maxOutputTokens)
      ? input.t('settings.providers.page.custom.error.positiveInteger')
      : undefined;
    return { id: modelIdError, name: modelNameError, contextWindow: contextWindowError, maxOutputTokens: maxOutputTokensError };
  });

  const modelsValid = modelErrors.every((entry) => !entry.id && !entry.name && !entry.contextWindow && !entry.maxOutputTokens);
  const modelConfig = Object.fromEntries(
    input.form.models.map((model) => {
      const modelID = model.id.trim();
      const entry: CustomProviderModelConfig = { modelID, name: model.name.trim() };
      if (model.type) entry.type = model.type;
      const context = parsePositiveInteger(model.contextWindow);
      const output = parsePositiveInteger(model.maxOutputTokens);
      if (context || output) entry.limit = { ...(context ? { context } : {}), ...(output ? { output } : {}) };
      const capabilities: NonNullable<CustomProviderModelConfig['capabilities']> = {};
      if (model.capabilitiesKnown.tools) capabilities.tools = model.tools;
      if (model.capabilitiesKnown.input) capabilities.input = model.inputCapabilities;
      if (model.capabilitiesKnown.output) capabilities.output = model.outputCapabilities;
      if (Object.keys(capabilities).length > 0) entry.capabilities = capabilities;
      const variantIDs = parseVariantIDs(model.variants);
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

  const tls = storedClientCertificateOf(input.form.tls);
  const certificatePathError = (field: string): string | undefined => {
    if (!tls) return undefined;
    if (!field.trim()) return input.t('settings.providers.page.custom.error.tls.incomplete');
    return isRelativeCertificatePath(field) ? input.t('settings.providers.page.custom.error.tls.relativePath') : undefined;
  };
  const tlsCertError = certificatePathError(input.form.tls?.cert ?? '');
  const tlsKeyError = certificatePathError(input.form.tls?.key ?? '');

  const err: FieldErrors = {
    providerID: idError ?? existsError,
    name: nameError,
    baseURL: urlError,
    apiKey: apiKeyError,
    tlsCert: tlsCertError,
    tlsKey: tlsKeyError,
  };

  const ok = !idError && !existsError && !nameError && !urlError && !apiKeyError && !tlsCertError && !tlsKeyError
    && modelsValid && headersValid;
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
      icon: input.form.icon,
      logo: logoPlanOf(input.form.logo),
      apiKey: key,
      ...(!env && !key ? { keepsStoredCredential: true } : {}),
      config: buildCustomProviderConfig({
        protocol: input.form.protocol,
        package: input.form.package,
        name,
        env,
        baseURL,
        tls,
        canonical: input.form.canonical === null ? undefined : input.form.canonical || null,
        headers: headerConfig,
        models: modelConfig,
      }),
    },
  };
}

function logoPlanOf(logo: CustomProviderFormState['logo']): CustomProviderLogoPlan {
  if (logo === null) return { kind: 'keep' };
  if (logo === 'removed') return { kind: 'remove' };
  return { kind: 'upload', file: logo };
}

function parsePositiveInteger(value: string): number | undefined {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function buildCustomProviderConfig(input: {
  protocol: CustomProviderProtocol;
  package?: CustomProviderPackage;
  name: string;
  env?: string;
  baseURL: string;
  tls?: StoredClientCertificate | null;
  canonical?: string | null;
  headers: Record<string, string>;
  models: Record<string, CustomProviderModelConfig>;
}): CustomProviderConfig {
  const config: CustomProviderConfig = {
    package: input.package && protocolFromPackage(input.package) === input.protocol
      ? input.package
      : CUSTOM_PROVIDER_PROTOCOLS[input.protocol],
    name: input.name,
    settings: { baseURL: input.baseURL },
    models: input.models,
  };
  if (input.tls !== undefined) config.settings.tls = input.tls;
  if (input.canonical !== undefined) config.canonical = input.canonical;
  if (input.env) config.env = [input.env];
  if (Object.keys(input.headers).length > 0) config.headers = input.headers;
  return config;
}

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

export function buildProviderUpsertRequest(
  plan: CustomProviderPersistPlan,
  options?: { scope?: ProviderConfigScope },
): {
  providerID: string;
  config: CustomProviderConfig;
  scope: ProviderConfigScope;
  hasCredential: boolean;
} {
  return {
    providerID: plan.providerID,
    config: plan.config,
    scope: options?.scope ?? 'user',
    hasCredential: Boolean(plan.apiKey || plan.keepsStoredCredential),
  };
}
