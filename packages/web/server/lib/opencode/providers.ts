import { z } from 'zod';
import {
  CONFIG_FILE,
  readConfigLayers,
  getConfigForPath,
  isPlainObject,
  writeConfig,
} from './config-files.js';
import {
  readSectionEntry,
  writeSectionEntry,
  deleteSectionEntry,
  toModelVariants,
  toProviderEntity,
  readStoredProviderEntry,
  toProviderPackage,
} from './config-v2.js';
import { isBoolean, isRecord, isString } from '../shared/object-guards.js';
import type { OpenCodeConfigLayer, OpenCodeConfigLayers } from './config-files.js';
import type { JsonValue } from '../shared/json-values.js';
import { canonicalSourceConnectionError, readInheritedProviderCanonical, type ProviderConfigLayers } from './inherited-canonical.js';
import type { ProviderEntity, ProviderModelEntity } from './config-v2.js';
import { isModelModality, toModelModalities } from './model-modalities.js';

export interface CustomProviderConfig {
  package: string;
  name: string;
  canonical?: string | null;
  settings: { baseURL: string; tls?: ClientCertificate | null };
  headers?: Record<string, string>;
  models: Record<string, CustomProviderModel>;
  env?: string[];
}

export type CustomProviderModel = ProviderModelEntity & { modelID: string; name: string };
export type CustomProviderValidation =
  | { ok: false; error: string }
  | { ok: true; value: { providerId: string; config: CustomProviderConfig } };

interface ClientCertificate {
  cert: string;
  key: string;
  passphrase?: string;
}

interface ProviderValidationOptions {
  hasStoredAuth?: boolean;
  layers?: ProviderConfigLayers<object>;
}

const MODEL_TYPE_SCHEMA = z.string().trim().min(1);
const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9-_]*$/;
const BASE_URL_PATTERN = /^https?:\/\//;
const OPENAI_COMPATIBLE_PACKAGE = 'aisdk:@ai-sdk/openai-compatible';
const CUSTOM_PROVIDER_PACKAGES = new Set([
  OPENAI_COMPATIBLE_PACKAGE,
  'aisdk:@ai-sdk/openai',
  'aisdk:@ai-sdk/anthropic',
  '@opencode/ai/providers/openai-compatible',
  '@opencode/ai/providers/openai-compatible/responses',
  '@opencode/ai/providers/openai-compatible-responses',
  '@opencode/ai/providers/openai',
  '@opencode/ai/providers/openai/chat',
  '@opencode/ai/providers/openai/responses',
  '@opencode/ai/providers/anthropic',
  '@opencode/ai/providers/anthropic-compatible',
]);
const CANONICAL_PROVIDER_SCHEMA = z.string().trim().regex(/^\S+$/);

const isPositiveSafeInteger = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) > 0;

const isStringList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(isString);

function providerExistsIn(config: OpenCodeConfigLayers['userConfig'], providerId: string) {
  return readSectionEntry(config, 'providers', providerId).value !== undefined;
}

function getUserProviderPath(layers: OpenCodeConfigLayers, providerId: string) {
  const { userPath, userOverridePath } = layers.paths;
  return userOverridePath && providerExistsIn(layers.userOverrideConfig, providerId) ? userOverridePath : userPath;
}

function getProviderSources(providerId: string, workingDirectory: string | null) {
  const layers = readConfigLayers(workingDirectory);
  const { userConfig, userOverrideConfig, projectConfig, customConfig, paths } = layers;
  const userPath = getUserProviderPath(layers, providerId);

  return {
    sources: {
      auth: { exists: false },
      user: { exists: providerExistsIn(getConfigForPath(layers, userPath), providerId), path: userPath },
      project: { exists: providerExistsIn(projectConfig, providerId), path: paths.projectPath || null },
      custom: { exists: providerExistsIn(customConfig, providerId), path: paths.customPath },
    },
    config: readStoredProviderEntry([customConfig, projectConfig, userOverrideConfig, userConfig], providerId),
    inheritedCanonical: readInheritedProviderCanonical(layers, providerId),
  };
}

function validateCustomProviderConfig<Config>(providerId: string, config: Config, options: ProviderValidationOptions = {}): CustomProviderValidation {
  if (!providerId || !isString(providerId) || !PROVIDER_ID_PATTERN.test(providerId)) {
    return { ok: false, error: 'Provider ID must match /^[a-z0-9][a-z0-9-_]*$/' };
  }

  if (!isRecord(config)) {
    return { ok: false, error: 'Provider config must be an object' };
  }

  const name = isString(config.name) ? config.name.trim() : '';
  if (!name) {
    return { ok: false, error: 'Provider name is required' };
  }

  const packageName = toProviderPackage(config.package ?? config.npm) || OPENAI_COMPATIBLE_PACKAGE;
  if (!CUSTOM_PROVIDER_PACKAGES.has(packageName)) {
    return { ok: false, error: 'Custom providers must use @ai-sdk/openai-compatible, @ai-sdk/openai, @ai-sdk/anthropic, or a supported built-in OpenCode adapter' };
  }

  const settingsBlock = isRecord(config.settings)
    ? config.settings
    : (isRecord(config.options) ? config.options : null);
  if (!settingsBlock) {
    return { ok: false, error: 'Provider settings are required' };
  }

  const baseURL = isString(settingsBlock.baseURL) ? settingsBlock.baseURL.trim() : '';
  if (!baseURL) {
    return { ok: false, error: 'Base URL is required' };
  }
  if (!BASE_URL_PATTERN.test(baseURL)) {
    return { ok: false, error: 'Base URL must start with http:// or https://' };
  }

  const models = isRecord(config.models) ? config.models : null;
  if (!models || Object.keys(models).length === 0) {
    return { ok: false, error: 'At least one model is required' };
  }

  const normalizedModels: CustomProviderConfig['models'] = {};
  for (const [modelId, modelValue] of Object.entries(models)) {
    const trimmedId = modelId.trim();
    if (!trimmedId) {
      return { ok: false, error: 'Model id is required' };
    }
    if (!isRecord(modelValue)) {
      return { ok: false, error: `Model "${trimmedId}" must be an object` };
    }
    const modelName = isString(modelValue.name) ? modelValue.name.trim() : '';
    if (!modelName) {
      return { ok: false, error: `Model "${trimmedId}" requires a name` };
    }
    const normalizedModel: CustomProviderModel = { modelID: trimmedId, name: modelName };
    normalizedModels[trimmedId] = normalizedModel;
    const modelType = MODEL_TYPE_SCHEMA.safeParse(modelValue.type).data;
    if (modelType) normalizedModel.type = modelType;
    if (isRecord(modelValue.limit)) {
      const context = modelValue.limit.context;
      const output = modelValue.limit.output;
      if (context !== undefined && !isPositiveSafeInteger(context)) {
        return { ok: false, error: `Model "${trimmedId}" context limit must be a positive integer` };
      }
      if (output !== undefined && !isPositiveSafeInteger(output)) {
        return { ok: false, error: `Model "${trimmedId}" output limit must be a positive integer` };
      }
      const limit: Record<string, number> = {};
      if (context !== undefined) limit.context = context;
      if (output !== undefined) limit.output = output;
      if (Object.keys(limit).length > 0) normalizedModel.limit = limit;
    }
    if (isRecord(modelValue.capabilities)) {
      const input = modelValue.capabilities.input;
      const output = modelValue.capabilities.output;
      const tools = modelValue.capabilities.tools;
      if (input !== undefined && !isStringList(input)) {
        return { ok: false, error: `Model "${trimmedId}" input capabilities are invalid` };
      }
      if (output !== undefined && !isStringList(output)) {
        return { ok: false, error: `Model "${trimmedId}" output capabilities are invalid` };
      }
      if (tools !== undefined && !isBoolean(tools)) {
        return { ok: false, error: `Model "${trimmedId}" tools capability must be a boolean` };
      }
      const capabilities: NonNullable<CustomProviderModel['capabilities']> = {};
      if (isBoolean(tools)) capabilities.tools = tools;
      if (input !== undefined) capabilities.input = toModelModalities(input);
      if (output !== undefined) capabilities.output = toModelModalities(output);
      if (Object.keys(capabilities).length > 0) normalizedModel.capabilities = capabilities;
    }
    if (Array.isArray(modelValue.variants)) {
      normalizedModel.variants = toModelVariants(modelValue.variants);
    }
  }

  const tls = validateClientCertificate(settingsBlock.tls);
  if (!tls.ok) return tls;

  let canonical: string | null | undefined;
  if (config.canonical === undefined || config.canonical === null) {
    canonical = config.canonical;
  } else {
    canonical = CANONICAL_PROVIDER_SCHEMA.safeParse(config.canonical).data;
    if (!canonical) return { ok: false, error: 'Canonical provider must be a provider ID' };
    const connectionError = options.layers && canonicalSourceConnectionError(options.layers, providerId, canonical);
    if (connectionError) return { ok: false, error: connectionError };
  }

  const normalized: CustomProviderConfig = {
    package: packageName,
    name,
    settings: { baseURL },
    models: normalizedModels,
  };
  if (tls.value !== undefined) normalized.settings.tls = tls.value;
  if (canonical !== undefined) normalized.canonical = canonical;

  let env: string[] = [];
  if (Array.isArray(config.env)) {
    env = config.env
      .filter((entry: unknown): entry is string => isString(entry) && entry.trim().length > 0)
      .map((entry) => entry.trim());
    if (env.length > 0) {
      normalized.env = env;
    }
  }

  const hasStoredAuth = Boolean(options.hasStoredAuth);
  if (env.length === 0 && !hasStoredAuth) {
    return {
      ok: false,
      error: 'API key or {env:VAR} credentials are required',
    };
  }

  const headerSource = isRecord(config.headers) ? config.headers : settingsBlock.headers;
  if (isRecord(headerSource)) {
    const headers: Record<string, string> = {};
    for (const [headerKey, headerValue] of Object.entries(headerSource)) {
      if (!headerKey.trim()) {
        continue;
      }
      if (!isString(headerValue) || !headerValue.trim()) {
        return { ok: false, error: `Header "${headerKey}" requires a non-empty value` };
      }
      headers[headerKey.trim()] = headerValue.trim();
    }
    if (Object.keys(headers).length > 0) {
      normalized.headers = headers;
    }
  }

  return { ok: true, value: { providerId, config: normalized } };
}

const CLIENT_CERTIFICATE_SCHEMA = z.object({
  cert: z.string().trim().min(1),
  key: z.string().trim().min(1),
  passphrase: z.string().optional(),
});

function validateClientCertificate(value: Parameters<typeof CLIENT_CERTIFICATE_SCHEMA.safeParse>[0]): { ok: true; value: ClientCertificate | null | undefined } | { ok: false; error: string } {
  if (value === undefined || value === null) return { ok: true, value };
  const parsed = CLIENT_CERTIFICATE_SCHEMA.safeParse(value);
  if (!parsed.success) return { ok: false, error: 'A client certificate needs both the certificate and the key' };
  const certificate: ClientCertificate = { cert: parsed.data.cert, key: parsed.data.key };
  if (parsed.data.passphrase?.trim()) certificate.passphrase = parsed.data.passphrase;
  return { ok: true, value: certificate };
}

function assertStoredOrKnownModalities(
  modelId: string,
  capabilities: ProviderModelEntity['capabilities'],
  stored: ProviderModelEntity['capabilities'],
) {
  if (!capabilities) return;
  for (const target of ['input', 'output'] as const) {
    const storedList = stored?.[target] ?? [];
    if (capabilities[target]?.some((entry) => !isModelModality(entry) && !storedList.includes(entry))) {
      throw Object.assign(new Error(`Model "${modelId}" ${target} capabilities are invalid`), { statusCode: 400 });
    }
  }
}

function mergeCustomProviderConfig(existingValue: Parameters<typeof toProviderEntity>[0], normalizedConfig: CustomProviderConfig): ProviderEntity {
  const existing = toProviderEntity(existingValue);
  const mergedSettings = { ...(existing.settings ?? {}), ...(normalizedConfig.settings ?? {}) } satisfies ProviderEntity['settings'];
  if (mergedSettings.tls === null) delete mergedSettings.tls;

  const existingModels: NonNullable<ProviderEntity['models']> = isRecord(existing.models) ? existing.models : {};
  const normalizedModels = isRecord(normalizedConfig.models) ? normalizedConfig.models : {};
  const mergedModels = Object.fromEntries(
    Object.entries(normalizedModels).map(([modelId, normalizedModel]) => {
      const existingModel = existingModels[modelId];
      const mergedModel = { ...existingModel, ...normalizedModel };
      assertStoredOrKnownModalities(modelId, normalizedModel.capabilities, existingModel?.capabilities);
      if (normalizedModel.capabilities) {
        mergedModel.capabilities = { ...existingModel?.capabilities, ...normalizedModel.capabilities };
      }
      if (Array.isArray(mergedModel.variants) && mergedModel.variants.length === 0) {
        delete mergedModel.variants;
      }
      return [modelId, mergedModel];
    }),
  );

  const merged = {
    ...existing,
    ...normalizedConfig,
    settings: mergedSettings,
    models: mergedModels,
  };
  if (merged.canonical === null) delete merged.canonical;
  if (!Object.prototype.hasOwnProperty.call(normalizedConfig, 'headers')) {
    delete merged.headers;
  }
  if (!Object.prototype.hasOwnProperty.call(normalizedConfig, 'env')) {
    delete merged.env;
  }
  return toProviderEntity(merged);
}

function upsertProviderConfig<Config>(providerId: string, config: Config, workingDirectory: string | null, scope: string = 'user', options: ProviderValidationOptions = {}) {
  const layers = readConfigLayers(workingDirectory);
  const validated = validateCustomProviderConfig(providerId, config, { ...options, layers });
  if (!validated.ok) {
    const error = Object.assign(new Error(validated.error), { statusCode: 400 });
    throw error;
  }

  let targetPath = getUserProviderPath(layers, validated.value.providerId);

  if (scope === 'project') {
    if (!workingDirectory) {
      throw new Error('Working directory is required for project scope');
    }
    targetPath = layers.paths.projectPath || layers.paths.userPath;
  } else if (scope === 'custom') {
    if (!layers.paths.customPath) {
      throw new Error('Custom config path (OPENCODE_CONFIG) is not set');
    }
    targetPath = layers.paths.customPath;
  } else if (scope !== 'user') {
    throw new Error('Invalid scope');
  }

  const targetConfig = getConfigForPath(layers, targetPath);
  const existing = readSectionEntry(targetConfig, 'providers', validated.value.providerId).value;
  const mergedConfig = mergeCustomProviderConfig(existing, validated.value.config);
  writeSectionEntry(targetConfig, 'providers', validated.value.providerId, mergedConfig);

  if (Array.isArray(targetConfig.disabled_providers)) {
    targetConfig.disabled_providers = targetConfig.disabled_providers.filter(
      (entry) => entry !== validated.value.providerId,
    );
  }

  const writePath = targetPath || CONFIG_FILE;
  writeConfig(targetConfig, writePath);

  const { userConfig } = layers;
  if (writePath === layers.paths.userOverridePath
    && Array.isArray(userConfig.disabled_providers)
    && userConfig.disabled_providers.includes(validated.value.providerId)) {
    userConfig.disabled_providers = userConfig.disabled_providers.filter(
      (entry) => entry !== validated.value.providerId,
    );
    writeConfig(userConfig, layers.paths.userPath);
  }

  return {
    providerId: validated.value.providerId,
    path: writePath,
    config: mergedConfig,
  };
}

function removeProviderConfig(providerId: string, workingDirectory: string | null, scope: string = 'user') {
  if (!providerId || !isString(providerId)) {
    throw new Error('Provider ID is required');
  }

  const layers = readConfigLayers(workingDirectory);
  let targetPath = getUserProviderPath(layers, providerId);

  if (scope === 'project') {
    if (!workingDirectory) {
      throw new Error('Working directory is required for project scope');
    }
    targetPath = layers.paths.projectPath || layers.paths.userPath;
  } else if (scope === 'custom') {
    if (!layers.paths.customPath) {
      return false;
    }
    targetPath = layers.paths.customPath;
  }

  const targetConfig = getConfigForPath(layers, targetPath);
  if (!deleteSectionEntry(targetConfig, 'providers', providerId)) {
    return false;
  }

  writeConfig(targetConfig, targetPath || CONFIG_FILE);
  console.log(`Removed provider ${providerId} from config: ${targetPath}`);
  return true;
}

function readDisabledProviders(workingDirectory: string | null): string[] {
  const layers = readConfigLayers(workingDirectory);
  const config = getConfigForPath(layers, layers.paths.userPath);
  return Array.isArray(config.disabled_providers)
    ? config.disabled_providers.filter((entry): entry is string => isString(entry) && entry.length > 0)
    : [];
}

// --- Effective off state (#218) -------------------------------------------
// Settings can only toggle `disabled_providers`, but OpenCode also refuses
// providers through two other mechanisms: a `provider.use` deny policy and
// a non-empty `enabled_providers` allowlist that omits them. Those offs are
// real (OpenCode drops the provider) yet invisible to the toggle, so the
// read below reports the effective off set with the binding reason per
// provider: 'policy' (a Settings toggle cannot undo it), 'disabled' (the
// user's own list, toggleable), or 'allowlist' (omitted from
// `enabled_providers`).

const POLICY_OFF = 'policy';
const LIST_OFF = 'disabled';
const ALLOWLIST_OFF = 'allowlist';

// Wildcard matching for policy resources, mirroring matchesWildcard in
// openchamber-control/integration-actions.js: `*` matches any run, `?` one
// character, everything else literal.
function matchesProviderPattern(providerId: string, pattern: string) {
  const escaped = pattern
    .replaceAll('\\', '/')
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp('^' + escaped + '$', 's').test(providerId.replaceAll('\\', '/'));
}

type PolicyStatement = { action: string; resource: string; effect: 'deny' | 'allow' };

function isPolicyStatement(value: unknown): value is PolicyStatement {
  return isPlainObject(value)
    && typeof value.action === 'string'
    && typeof value.resource === 'string'
    && (value.effect === 'deny' || value.effect === 'allow');
}

// One config document's statements: `experimental.policies` first, then the
// top-level `policies` OpenCode 2.0.29 serves (same order as the UI's
// documentPolicies in lib/opencode/projection.ts).
function documentPolicyStatements(config: OpenCodeConfigLayer): PolicyStatement[] {
  if (!isPlainObject(config)) return [];
  const experimental = isPlainObject(config.experimental) && Array.isArray(config.experimental.policies)
    ? config.experimental.policies
    : [];
  const topLevel = Array.isArray(config.policies) ? config.policies : [];
  return [...experimental, ...topLevel].filter(isPolicyStatement);
}

// Every layer's `provider.use` statements in deciding order. Policies from
// every layer apply (they are not folded like ordinary config), and the
// user-global file decides last (upstream ManagedPolicy.statements order),
// so layers are read project-first and the LAST matching statement wins.
function providerUseStatements(layers: OpenCodeConfigLayers) {
  const orderedConfigs = [
    layers.projectConfig,
    layers.customConfig,
    layers.userOverrideConfig,
    layers.userConfig,
  ];
  return orderedConfigs
    .flatMap((config) => documentPolicyStatements(config))
    .filter((statement) => statement.action === 'provider.use');
}

function policyDeniesProvider(statements: PolicyStatement[], providerId: string) {
  for (let index = statements.length - 1; index >= 0; index -= 1) {
    const statement = statements[index];
    if (statement && matchesProviderPattern(providerId, statement.resource)) return statement.effect === 'deny';
  }
  return false;
}

function stringList(value: JsonValue | undefined): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
    : [];
}

function configuredProviderIds(layers: OpenCodeConfigLayers) {
  const ids = new Set<string>();
  for (const config of [layers.userConfig, layers.userOverrideConfig, layers.customConfig, layers.projectConfig]) {
    if (!isPlainObject(config)) continue;
    for (const key of ['providers', 'provider']) {
      if (isPlainObject(config[key])) {
        for (const id of Object.keys(config[key])) ids.add(id);
      }
    }
  }
  return ids;
}

/**
 * The effective off state for providers, across all three off mechanisms.
 * `knownProviderIds` is the caller's provider universe (catalog ids, when
 * it has one): allowlist omissions and wildcard policy denies can only be
 * enumerated against known ids, so the universe is those ids plus every
 * provider named in config (either section spelling), in the two lists,
 * or by an exact (non-wildcard) policy resource.
 * Returns { providers, reasons, enabledProviders } where `providers` is
 * the effective off set, `reasons` maps each off id to its binding reason
 * ('policy' over 'disabled' over 'allowlist'), and `enabledProviders` is
 * the allowlist, or null when no non-empty allowlist is configured.
 */
function readProviderOffState(workingDirectory: string | null | undefined, knownProviderIds: string[] = []) {
  const layers = readConfigLayers(workingDirectory);
  const config = getConfigForPath(layers, layers.paths.userPath);
  const disabled = stringList(config.disabled_providers);
  const enabled = stringList(config.enabled_providers);
  const enabledProviders = enabled.length > 0 ? enabled : null;
  const statements = providerUseStatements(layers);

  const universe = new Set([
    ...stringList(knownProviderIds),
    ...configuredProviderIds(layers),
    ...disabled,
    ...enabled,
  ]);
  for (const statement of statements) {
    if (!statement.resource.includes('*') && !statement.resource.includes('?')) {
      universe.add(statement.resource);
    }
  }

  const reasons: Record<string, string> = {};
  for (const providerId of universe) {
    if (policyDeniesProvider(statements, providerId)) {
      reasons[providerId] = POLICY_OFF;
    } else if (disabled.includes(providerId)) {
      reasons[providerId] = LIST_OFF;
    } else if (enabledProviders && !enabledProviders.includes(providerId)) {
      reasons[providerId] = ALLOWLIST_OFF;
    }
  }
  return { providers: Object.keys(reasons), reasons, enabledProviders };
}

function setProviderDisabled(providerId: string, disabled: boolean, workingDirectory: string | null) {
  if (!isString(providerId) || !PROVIDER_ID_PATTERN.test(providerId)) {
    const error = Object.assign(new Error('Invalid provider ID'), { statusCode: 400 });
    throw error;
  }
  const layers = readConfigLayers(workingDirectory);
  const targetPath = layers.paths.userPath;
  const config = getConfigForPath(layers, targetPath);
  const current = Array.isArray(config.disabled_providers)
    ? config.disabled_providers.filter((entry) => entry !== providerId)
    : [];
  const next = disabled ? [...current, providerId] : current;
  if (next.length > 0) config.disabled_providers = next;
  else delete config.disabled_providers;
  writeConfig(config, targetPath || CONFIG_FILE);
  return next;
}

// --- OpenCode's own per-model settings ----------------------------------------
// `providers.<id>.models.<id>` in OpenCode's config can keep a model out of the
// picker (`hidden`), name the effort it runs at (`defaultVariant`) and keep it
// there (`lockVariant`). The catalog OpenChamber reads drops these fields, so
// Settings reads them from the config files and writes them to the user file.

const MODEL_SETTING_KEYS = ['hidden', 'defaultVariant', 'lockVariant'] as const;
const variantName = z.string().regex(/^\S+$/);
// One model entry's settings as OpenCode reads them; a malformed value reads as unset.
const storedModelSettingsSchema = z.object({
  hidden: z.boolean().optional().catch(undefined),
  defaultVariant: variantName.optional().catch(undefined),
  lockVariant: z.boolean().optional().catch(undefined),
});
type StoredModelSettings = Partial<Record<typeof MODEL_SETTING_KEYS[number], string | boolean>>;
// A change from Settings: one model, only the three keys, each a value or `null` to clear.
const modelSettingsRequestSchema = z.object({
  providerID: z.string().min(1),
  modelID: z.string().min(1),
  settings: z.object({
    hidden: z.boolean().nullable().optional(),
    defaultVariant: variantName.nullable().optional(),
    lockVariant: z.boolean().nullable().optional(),
  }).strict(),
});

/** The three settings one model entry carries, as OpenCode would read them. */
function pickModelSettings(entry: OpenCodeConfigLayer): StoredModelSettings {
  const parsed = storedModelSettingsSchema.parse(entry);
  return Object.fromEntries(Object.entries(parsed).filter(([, value]) => value !== undefined));
}

/** Model settings in one config file. A provider in both spellings counts once, as
 * `providers`: OpenCode lets that entry replace the legacy `provider` one whole. */
type ModelSettingsMap = Record<string, StoredModelSettings>;

function modelSettingsIn(config: OpenCodeConfigLayer, into: ModelSettingsMap) {
  const fields = isPlainObject(config) ? config : {};
  const native = isPlainObject(fields.providers) ? fields.providers : {};
  const legacy = isPlainObject(fields.provider) ? fields.provider : {};
  const entries = [
    ...Object.entries(legacy).filter(([providerID]) => !Object.hasOwn(native, providerID)),
    ...Object.entries(native),
  ];
  for (const [providerID, provider] of entries) {
    const providerModels = isPlainObject(provider) ? provider.models : undefined;
    if (!isPlainObject(providerModels)) continue;
    for (const [modelID, model] of Object.entries(providerModels)) {
      if (!isPlainObject(model)) continue;
      const picked = pickModelSettings(model);
      if (Object.keys(picked).length === 0) continue;
      const key = `${providerID}/${modelID}`;
      into[key] = { ...into[key], ...picked };
    }
  }
  return into;
}

/** Every model's settings across the files OpenCode reads, later files winning
 * per key, and the user file a change from Settings is written to. */
function readModelSettings(workingDirectory: string | null | undefined) {
  const layers = readConfigLayers(workingDirectory);
  const files = [
    layers.userConfig,
    layers.userOverrideConfig,
    layers.projectConfig,
    layers.customConfig,
  ];
  const models = files.reduce<ModelSettingsMap>((merged, config) => modelSettingsIn(config, merged), {});
  return { path: layers.paths.userPath || CONFIG_FILE, models };
}

/**
 * Sets or clears model settings in the user config file. A `null` value removes
 * the key. The entry is edited in the spelling the provider already uses in that
 * file: a `providers` entry beside a legacy `provider` one would replace it whole
 * and drop the rest of the user's provider definition.
 */
function writeModelSettings(providerID: string, modelID: string, patch: z.infer<typeof modelSettingsRequestSchema>['settings'], workingDirectory: string | null | undefined) {
  const layers = readConfigLayers(workingDirectory);
  const targetPath = layers.paths.userPath || CONFIG_FILE;
  if (layers.layerErrors.some((entry) => entry.path === targetPath)) {
    throw Object.assign(new Error(`${targetPath} is not valid JSONC; fix it before changing it here`), { statusCode: 409 });
  }
  const config = getConfigForPath(layers, targetPath);
  const sectionKey = readSectionEntry(config, 'providers', providerID).key ?? 'providers';
  const section = isPlainObject(config[sectionKey]) ? config[sectionKey] : {};
  const provider = isPlainObject(section[providerID]) ? section[providerID] : {};
  const models = isPlainObject(provider.models) ? provider.models : {};
  const entry = isPlainObject(models[modelID]) ? { ...models[modelID] } : {};
  for (const key of MODEL_SETTING_KEYS) {
    if (!Object.hasOwn(patch, key)) continue;
    const value = patch[key];
    if (value === null || value === undefined) delete entry[key];
    else entry[key] = value;
  }
  if (Object.keys(entry).length > 0) models[modelID] = entry;
  else delete models[modelID];
  if (Object.keys(models).length > 0) provider.models = models;
  else delete provider.models;
  if (Object.keys(provider).length > 0) section[providerID] = provider;
  else delete section[providerID];
  if (Object.keys(section).length > 0) config[sectionKey] = section;
  else delete config[sectionKey];
  writeConfig(config, targetPath);
  return readModelSettings(workingDirectory);
}

/** The first reason a change request from Settings is refused. */
function modelSettingsRequestError(error: z.ZodError) {
  const [issue] = error.issues;
  return issue ? `${issue.path.join('.') || 'body'}: ${issue.message}` : 'body: invalid';
}

export {
  modelSettingsRequestSchema,
  modelSettingsRequestError,
  readModelSettings,
  writeModelSettings,
  getProviderSources,
  mergeCustomProviderConfig,
  readDisabledProviders,
  readProviderOffState,
  setProviderDisabled,
  removeProviderConfig,
  upsertProviderConfig,
  validateCustomProviderConfig,
};
