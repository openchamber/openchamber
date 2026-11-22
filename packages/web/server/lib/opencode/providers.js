import { z } from 'zod';
import {
  CONFIG_FILE,
  readConfigLayers,
  isPlainObject,
  getConfigForPath,
  writeConfig,
} from './shared.js';
import {
  readSectionEntry,
  writeSectionEntry,
  deleteSectionEntry,
  toModelVariants,
  toProviderEntity,
  readStoredProviderEntry,
  toProviderPackage,
  toNpmPackage,
} from './config-v2.js';

const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9-_]*$/;
const BASE_URL_PATTERN = /^https?:\/\//;
const OPENAI_COMPATIBLE_NPM = '@ai-sdk/openai-compatible';
const CUSTOM_PROVIDER_NPM_PACKAGES = new Set([
  OPENAI_COMPATIBLE_NPM,
  '@ai-sdk/openai',
  '@ai-sdk/anthropic',
]);
const MODEL_CAPABILITIES = new Set(['text', 'image', 'audio', 'video', 'pdf']);

// OpenCode 2 keeps providers under `providers` with `package: "aisdk:<npm>"`,
// `settings.baseURL`, and `models.<id>.modelID`. The v1 `provider` map with
// `npm`/`api`/`options` is still decoded, so reads accept it; every write is v2.

function providerExistsIn(config, providerId) {
  return readSectionEntry(config, 'providers', providerId).value !== undefined;
}

function getProviderSources(providerId, workingDirectory) {
  const layers = readConfigLayers(workingDirectory);
  const { userConfig, projectConfig, customConfig, paths } = layers;

  return {
    sources: {
      auth: { exists: false },
      user: { exists: providerExistsIn(userConfig, providerId), path: paths.userPath },
      project: { exists: providerExistsIn(projectConfig, providerId), path: paths.projectPath || null },
      custom: { exists: providerExistsIn(customConfig, providerId), path: paths.customPath },
    },
    // Same precedence as the edit scope: custom > project > user.
    config: readStoredProviderEntry([customConfig, projectConfig, userConfig], providerId),
  };
}

/**
 * Validate a custom provider config payload before persistence.
 * Returns { ok: true, value } or { ok: false, error }.
 *
 * Accepts the v2 spelling (`package`, `settings.baseURL`) and the v1 spelling
 * (`npm`, `options.baseURL`); the normalized value is always v2.
 *
 * Credentials: either config.env contains a variable name, or hasStoredAuth is true
 * (auth.json already has a key — typically after auth.set, or when editing).
 */
function validateCustomProviderConfig(providerId, config, options = {}) {
  if (!providerId || typeof providerId !== 'string' || !PROVIDER_ID_PATTERN.test(providerId)) {
    return { ok: false, error: 'Provider ID must match /^[a-z0-9][a-z0-9-_]*$/' };
  }

  if (!isPlainObject(config)) {
    return { ok: false, error: 'Provider config must be an object' };
  }

  const name = typeof config.name === 'string' ? config.name.trim() : '';
  if (!name) {
    return { ok: false, error: 'Provider name is required' };
  }

  const npm = toNpmPackage(config.package ?? config.npm) || OPENAI_COMPATIBLE_NPM;
  if (!CUSTOM_PROVIDER_NPM_PACKAGES.has(npm)) {
    return { ok: false, error: 'Custom providers must use @ai-sdk/openai-compatible, @ai-sdk/openai, or @ai-sdk/anthropic' };
  }

  const settingsBlock = isPlainObject(config.settings)
    ? config.settings
    : (isPlainObject(config.options) ? config.options : null);
  if (!settingsBlock) {
    return { ok: false, error: 'Provider settings are required' };
  }

  const baseURL = typeof settingsBlock.baseURL === 'string' ? settingsBlock.baseURL.trim() : '';
  if (!baseURL) {
    return { ok: false, error: 'Base URL is required' };
  }
  if (!BASE_URL_PATTERN.test(baseURL)) {
    return { ok: false, error: 'Base URL must start with http:// or https://' };
  }

  const models = isPlainObject(config.models) ? config.models : null;
  if (!models || Object.keys(models).length === 0) {
    return { ok: false, error: 'At least one model is required' };
  }

  const normalizedModels = {};
  for (const [modelId, modelValue] of Object.entries(models)) {
    const trimmedId = typeof modelId === 'string' ? modelId.trim() : '';
    if (!trimmedId) {
      return { ok: false, error: 'Model id is required' };
    }
    if (!isPlainObject(modelValue)) {
      return { ok: false, error: `Model "${trimmedId}" must be an object` };
    }
    const modelName = typeof modelValue.name === 'string' ? modelValue.name.trim() : '';
    if (!modelName) {
      return { ok: false, error: `Model "${trimmedId}" requires a name` };
    }
    normalizedModels[trimmedId] = { modelID: trimmedId, name: modelName };
    if (isPlainObject(modelValue.limit)) {
      const context = modelValue.limit.context;
      const output = modelValue.limit.output;
      if (context !== undefined && (!Number.isSafeInteger(context) || context <= 0)) {
        return { ok: false, error: `Model "${trimmedId}" context limit must be a positive integer` };
      }
      if (output !== undefined && (!Number.isSafeInteger(output) || output <= 0)) {
        return { ok: false, error: `Model "${trimmedId}" output limit must be a positive integer` };
      }
      const limit = {};
      if (context !== undefined) limit.context = context;
      if (output !== undefined) limit.output = output;
      if (Object.keys(limit).length > 0) normalizedModels[trimmedId].limit = limit;
    }
    if (isPlainObject(modelValue.capabilities)) {
      const input = modelValue.capabilities.input;
      const output = modelValue.capabilities.output;
      const tools = modelValue.capabilities.tools;
      if (input !== undefined && (!Array.isArray(input) || input.some((value) => !MODEL_CAPABILITIES.has(value)))) {
        return { ok: false, error: `Model "${trimmedId}" input capabilities are invalid` };
      }
      if (output !== undefined && (!Array.isArray(output) || output.some((value) => !MODEL_CAPABILITIES.has(value)))) {
        return { ok: false, error: `Model "${trimmedId}" output capabilities are invalid` };
      }
      if (tools !== undefined && typeof tools !== 'boolean') {
        return { ok: false, error: `Model "${trimmedId}" tools capability must be a boolean` };
      }
      normalizedModels[trimmedId].capabilities = {
        tools: typeof tools === 'boolean' ? tools : true,
        input: input ?? ['text'],
        output: output ?? ['text'],
      };
    }
    // Present means the caller owns the levels; an empty list removes them.
    if (Array.isArray(modelValue.variants)) {
      normalizedModels[trimmedId].variants = toModelVariants(modelValue.variants);
    }
  }

  const normalized = {
    package: toProviderPackage(npm),
    name,
    settings: { baseURL },
    models: normalizedModels,
  };

  let env = [];
  if (Array.isArray(config.env)) {
    env = config.env
      .filter((entry) => typeof entry === 'string' && entry.trim().length > 0)
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

  const headerSource = isPlainObject(config.headers) ? config.headers : settingsBlock.headers;
  if (isPlainObject(headerSource)) {
    const headers = {};
    for (const [headerKey, headerValue] of Object.entries(headerSource)) {
      if (typeof headerKey !== 'string' || !headerKey.trim()) {
        continue;
      }
      if (typeof headerValue !== 'string' || !headerValue.trim()) {
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

function mergeCustomProviderConfig(existingValue, normalizedConfig) {
  // Read the existing entry through the v2 projection so a legacy
  // `npm`/`api`/`options` block is carried forward in native shape.
  const existing = toProviderEntity(existingValue);
  const mergedSettings = { ...(existing.settings ?? {}), ...(normalizedConfig.settings ?? {}) };

  const existingModels = isPlainObject(existing.models) ? existing.models : {};
  const normalizedModels = isPlainObject(normalizedConfig.models) ? normalizedConfig.models : {};
  const mergedModels = Object.fromEntries(
    Object.entries(normalizedModels).map(([modelId, normalizedModel]) => {
      const existingModel = isPlainObject(existingModels[modelId]) ? existingModels[modelId] : {};
      const mergedModel = { ...existingModel, ...normalizedModel };
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
  // Headers and env are explicit removals when the form omits them.
  if (!Object.prototype.hasOwnProperty.call(normalizedConfig, 'headers')) {
    delete merged.headers;
  }
  if (!Object.prototype.hasOwnProperty.call(normalizedConfig, 'env')) {
    delete merged.env;
  }
  return toProviderEntity(merged);
}

/**
 * Persist (create or update) a custom provider block in OpenCode user/project/custom config.
 * Does not write secrets — API keys remain in auth.json via the OpenCode auth API.
 */
function upsertProviderConfig(providerId, config, workingDirectory, scope = 'user', options = {}) {
  const validated = validateCustomProviderConfig(providerId, config, options);
  if (!validated.ok) {
    const error = new Error(validated.error);
    error.statusCode = 400;
    throw error;
  }

  const layers = readConfigLayers(workingDirectory);
  let targetPath = layers.paths.userPath;

  if (scope === 'project') {
    if (!workingDirectory) {
      throw new Error('Working directory is required for project scope');
    }
    targetPath = layers.paths.projectPath || targetPath;
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
  // Writes `providers`; a legacy `provider.<id>` in the same file is dropped so
  // the two spellings cannot disagree.
  writeSectionEntry(targetConfig, 'providers', validated.value.providerId, mergedConfig);

  if (Array.isArray(targetConfig.disabled_providers)) {
    targetConfig.disabled_providers = targetConfig.disabled_providers.filter(
      (entry) => entry !== validated.value.providerId,
    );
  }

  const writePath = targetPath || CONFIG_FILE;
  writeConfig(targetConfig, writePath);

  return {
    providerId: validated.value.providerId,
    path: writePath,
    config: mergedConfig,
  };
}

function removeProviderConfig(providerId, workingDirectory, scope = 'user') {
  if (!providerId || typeof providerId !== 'string') {
    throw new Error('Provider ID is required');
  }

  const layers = readConfigLayers(workingDirectory);
  let targetPath = layers.paths.userPath;

  if (scope === 'project') {
    if (!workingDirectory) {
      throw new Error('Working directory is required for project scope');
    }
    targetPath = layers.paths.projectPath || targetPath;
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

/**
 * Providers turned off in the user's OpenCode config (`disabled_providers`).
 * OpenCode 2 drops them from its provider list, so this list is the only
 * place Settings can still show them to turn them back on.
 */
function readDisabledProviders(workingDirectory) {
  const layers = readConfigLayers(workingDirectory);
  const config = getConfigForPath(layers, layers.paths.userPath);
  return Array.isArray(config.disabled_providers)
    ? config.disabled_providers.filter((entry) => typeof entry === 'string' && entry.length > 0)
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
function matchesProviderPattern(providerId, pattern) {
  const escaped = pattern
    .replaceAll('\\', '/')
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp('^' + escaped + '$', 's').test(providerId.replaceAll('\\', '/'));
}

function isPolicyStatement(value) {
  return isPlainObject(value)
    && typeof value.action === 'string'
    && typeof value.resource === 'string'
    && (value.effect === 'deny' || value.effect === 'allow');
}

// One config document's statements: `experimental.policies` first, then the
// top-level `policies` OpenCode 2.0.29 serves (same order as the UI's
// documentPolicies in lib/opencode/projection.ts).
function documentPolicyStatements(config) {
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
function providerUseStatements(layers) {
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

function policyDeniesProvider(statements, providerId) {
  const deciding = statements.findLast((statement) => matchesProviderPattern(providerId, statement.resource));
  return deciding?.effect === 'deny';
}

function stringList(value) {
  return Array.isArray(value)
    ? value.filter((entry) => typeof entry === 'string' && entry.length > 0)
    : [];
}

function configuredProviderIds(layers) {
  const ids = new Set();
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
function readProviderOffState(workingDirectory, knownProviderIds = []) {
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

  const reasons = {};
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

function setProviderDisabled(providerId, disabled, workingDirectory) {
  if (typeof providerId !== 'string' || !PROVIDER_ID_PATTERN.test(providerId)) {
    const error = new Error('Invalid provider ID');
    error.statusCode = 400;
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

const MODEL_SETTING_KEYS = ['hidden', 'defaultVariant', 'lockVariant'];
const variantName = z.string().regex(/^\S+$/);
// One model entry's settings as OpenCode reads them; a malformed value reads as unset.
const storedModelSettingsSchema = z.object({
  hidden: z.boolean().optional().catch(undefined),
  defaultVariant: variantName.optional().catch(undefined),
  lockVariant: z.boolean().optional().catch(undefined),
});
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
function pickModelSettings(entry) {
  const parsed = storedModelSettingsSchema.parse(entry);
  return Object.fromEntries(Object.entries(parsed).filter(([, value]) => value !== undefined));
}

/** Model settings in one config file. A provider in both spellings counts once, as
 * `providers`: OpenCode lets that entry replace the legacy `provider` one whole. */
function modelSettingsIn(config, into) {
  const native = isPlainObject(config?.providers) ? config.providers : {};
  const legacy = isPlainObject(config?.provider) ? config.provider : {};
  const entries = [
    ...Object.entries(legacy).filter(([providerID]) => !Object.hasOwn(native, providerID)),
    ...Object.entries(native),
  ];
  for (const [providerID, provider] of entries) {
    if (!isPlainObject(provider?.models)) continue;
    for (const [modelID, model] of Object.entries(provider.models)) {
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
function readModelSettings(workingDirectory) {
  const layers = readConfigLayers(workingDirectory);
  const files = [
    layers.userConfig,
    layers.userOverrideConfig,
    layers.projectConfig,
    layers.customConfig,
  ];
  const models = files.reduce((merged, config) => modelSettingsIn(config, merged), {});
  return { path: layers.paths.userPath || CONFIG_FILE, models };
}

/**
 * Sets or clears model settings in the user config file. A `null` value removes
 * the key. The entry is edited in the spelling the provider already uses in that
 * file: a `providers` entry beside a legacy `provider` one would replace it whole
 * and drop the rest of the user's provider definition.
 */
function writeModelSettings(providerID, modelID, patch, workingDirectory) {
  const layers = readConfigLayers(workingDirectory);
  const targetPath = layers.paths.userPath || CONFIG_FILE;
  if (layers.layerErrors.some((entry) => entry.path === targetPath)) {
    const error = new Error(`${targetPath} is not valid JSONC; fix it before changing it here`);
    error.statusCode = 409;
    throw error;
  }
  const config = getConfigForPath(layers, targetPath);
  const sectionKey = readSectionEntry(config, 'providers', providerID).key ?? 'providers';
  const section = isPlainObject(config[sectionKey]) ? config[sectionKey] : {};
  const provider = isPlainObject(section[providerID]) ? section[providerID] : {};
  const models = isPlainObject(provider.models) ? provider.models : {};
  const entry = isPlainObject(models[modelID]) ? { ...models[modelID] } : {};
  for (const key of MODEL_SETTING_KEYS) {
    if (!Object.hasOwn(patch, key)) continue;
    if (patch[key] === null) delete entry[key];
    else entry[key] = patch[key];
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

/** A change request from Settings, parsed, or the first reason it is refused. */
function parseModelSettingsRequest(body) {
  const parsed = modelSettingsRequestSchema.safeParse(body);
  if (parsed.success) return { success: true, data: parsed.data };
  const [issue] = parsed.error.issues;
  return { success: false, error: `${issue.path.join('.') || 'body'}: ${issue.message}` };
}

export {
  parseModelSettingsRequest,
  readModelSettings,
  writeModelSettings,
  getProviderSources,
  readDisabledProviders,
  readProviderOffState,
  setProviderDisabled,
  removeProviderConfig,
  upsertProviderConfig,
  validateCustomProviderConfig,
};
