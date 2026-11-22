/**
 * Provider and model actions for the `openchamber` control tool.
 *
 * Two owners hold model state, and each action names which one it touches:
 * - OpenChamber profile settings (`hiddenModels`, `defaultModel`,
 *   `defaultVariant`, `defaultAgent`, `projects[].default*`), written through
 *   `persistSettings` exactly as the Settings UI writes them.
 * - OpenCode config files (`disabled_providers`, `providers.<id>.models.<id>`,
 *   `model`), written in v2 shape through `writeConfig`, which keeps JSONC
 *   comments and unrelated keys. OpenCode watches those files, so a change is
 *   live without a restart (`../opencode/config-mutation-response.js`).
 *
 * Live catalogs come from the directory-scoped OpenCode client; a failed
 * lookup is an error, never an empty list.
 *
 * Dependencies (identifiers in scope in `packages/web/server/index.js`):
 * - `readSettingsFromDiskMigrated` — `readSettingsFromDiskMigrated`
 * - `persistSettings` — `persistSettings`
 *
 * Execution context (`ctx`), supplied per call by the control service:
 * - `contextDirectory` — the calling session's directory
 * - `contextSessionId` — the calling session (unused here)
 * - `getClient(directory)` — the service's directory-scoped `@opencode/client`
 */
import { asNonEmptyString, isPlainObject, isString } from '../shared/guards.js';
import { OpenChamberControlError, asControlError } from './error.js';
import { CONFIG_FILE, getConfigForPath, readConfigLayers, writeConfig } from '../opencode/shared.js';
import { readDisabledProviders, setProviderDisabled } from '../opencode/providers.js';
import {
  deleteSectionEntry,
  formatModelSelection,
  readSectionEntry,
  toModelVariants,
  toProviderEntity,
  writeSectionEntry,
} from '../opencode/config-v2.js';
import { buildAppliedResponse } from '../opencode/config-mutation-response.js';

export const PROVIDER_ACTION_DEFINITIONS = Object.freeze([
  { action: 'providers.list', title: 'List model providers', description: 'List model providers with whether each is on, turned off, or set up in OpenCode config, and how many of its models are enabled; optional directory or projectId' },
  { action: 'providers.toggle', title: 'Turn a provider on or off', description: 'Turn providerId off or back on for OpenCode; requires the disabled boolean. Turned-off providers and their models disappear from every picker' },
  { action: 'models.available', title: 'List available models', description: 'List the models OpenCode offers, with effort variants, cost in USD per million tokens, limits, and whether each is enabled, hidden in OpenChamber, a favorite, or the default; filter with providerId and enabledOnly' },
  { action: 'models.toggle', title: 'Show or hide a model', description: 'Hide (disabled true) or show (disabled false) model, or providerId with modelId. By default it only hides the model in OpenChamber pickers; modelToggleLevel opencode disables it in OpenCode config instead, at configScope' },
  { action: 'models.default', title: 'Set the default model, effort, and agent', description: 'Set the defaults new sessions start with; pass any of model (provider/model), variant (effort), agent; an empty string clears one. A new model clears the variant unless variant is given. projectId sets that project\'s defaults instead of the global ones. writeOpenCodeDefault also writes OpenCode\'s own model key at configScope' },
  { action: 'provider.models.add', title: 'Add a model to a provider', description: 'Add modelId to providerId in OpenCode config, or update its entry; optional name, contextLimit, outputLimit, variants, and cost fields. configScope picks the user (default) or project config. The provider must already exist' },
  { action: 'provider.models.remove', title: 'Remove a model from a provider', description: 'Remove modelId\'s entry under providerId from OpenCode config at configScope. A model built into the provider stays available; only the configured entry goes' },
  { action: 'models.cost', title: 'Set a model\'s price', description: 'Set model\'s price (or providerId with modelId) in USD per million tokens with costInput, costOutput, costCacheRead, costCacheWrite; fields not given keep their current price. Written to OpenCode config at configScope' },
]);

const COST_DESCRIPTION = 'USD per million tokens, for models.cost and provider.models.add';

export const PROVIDER_PARAMETERS = {
  providerId: { type: 'string', description: 'Provider ID as providers.list shows it, such as anthropic' },
  modelId: { type: 'string', description: 'Model ID within providerId, as models.available shows it; an alternative to model' },
  enabledOnly: { type: 'boolean', description: 'models.available: only models OpenCode enables and OpenChamber shows' },
  modelToggleLevel: { type: 'string', enum: ['openchamber', 'opencode'], description: 'models.toggle: openchamber (default) hides the model in OpenChamber pickers; opencode disables it in OpenCode config' },
  // configScope is shared with config-actions.js, which declares it (with the
  // read-only merged/custom values the provider actions refuse).
  writeOpenCodeDefault: { type: 'boolean', description: 'models.default: also write OpenCode\'s own default model at configScope' },
  contextLimit: { type: 'integer', minimum: 1, description: 'provider.models.add: context window in tokens' },
  outputLimit: { type: 'integer', minimum: 1, description: 'provider.models.add: maximum output tokens' },
  variants: { type: 'array', items: { type: 'string' }, description: 'provider.models.add: effort variant IDs such as low, medium, high; replaces the configured list, empty removes it' },
  costInput: { type: 'number', minimum: 0, description: `Input price, ${COST_DESCRIPTION}` },
  costOutput: { type: 'number', minimum: 0, description: `Output price, ${COST_DESCRIPTION}` },
  costCacheRead: { type: 'number', minimum: 0, description: `Cache read price, ${COST_DESCRIPTION}` },
  costCacheWrite: { type: 'number', minimum: 0, description: `Cache write price, ${COST_DESCRIPTION}` },
};

const LIVE_HINT = 'OpenCode watches its config files, so the change is already live; no restart is needed.';
// OpenChamber's router model: a picker entry OpenCode does not list.
const AUTO_MODEL = 'openchamber/auto';
const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9-_]*$/;
const CONFIG_SCOPES = ['user', 'project'];
const COST_FIELDS = [
  ['costInput', 'input'],
  ['costOutput', 'output'],
  ['costCacheRead', 'cacheRead'],
  ['costCacheWrite', 'cacheWrite'],
];

const badRequest = (message) => new OpenChamberControlError(message, 400);

const listData = (response) => (Array.isArray(response?.data) ? response.data : []);

const modelKey = (providerID, modelID) => `${providerID}/${modelID}`;

const sameRef = (ref, providerID, modelID) => ref?.providerID === providerID && ref?.modelID === modelID;

const refList = (value) => (Array.isArray(value) ? value.filter((ref) => isPlainObject(ref)) : []);

const readBoolean = (input, field, { required = false } = {}) => {
  const value = input[field];
  if (value === undefined && !required) return undefined;
  if (value !== true && value !== false) throw badRequest(`${field} must be true or false`);
  return value;
};

/** `model` ('provider/model') or `providerId` + `modelId`, never both. */
const readModelRef = (input) => {
  const model = asNonEmptyString(input.model);
  const providerId = asNonEmptyString(input.providerId);
  const modelId = asNonEmptyString(input.modelId);
  if (model && (providerId || modelId)) throw badRequest('Provide model or providerId with modelId, not both');
  if (model) {
    const separator = model.indexOf('/');
    if (separator <= 0 || separator === model.length - 1) throw badRequest('model must be in provider/model format');
    return { providerID: model.slice(0, separator), modelID: model.slice(separator + 1) };
  }
  if (!providerId || !modelId) throw badRequest('model, or providerId with modelId, is required');
  return { providerID: providerId, modelID: modelId };
};

const readProviderId = (input) => {
  const providerId = asNonEmptyString(input.providerId);
  if (!providerId) throw badRequest('providerId is required');
  return providerId;
};

/** The catalog entry a stored ref means: an exact `id` wins over `modelID`, as in the UI. */
const findModel = (models, providerID, modelID) => {
  const own = models.filter((model) => model.providerID === providerID);
  return own.find((model) => model.id === modelID) ?? own.find((model) => model.modelID === modelID) ?? null;
};

const summarizeCost = (cost) => {
  const tiers = Array.isArray(cost) ? cost : [];
  const base = tiers.find((tier) => !tier?.tier) ?? tiers[0];
  if (!base) return null;
  const summary = {
    input: base.input,
    output: base.output,
    cacheRead: base.cache?.read,
    cacheWrite: base.cache?.write,
  };
  // Context-size tiers change the price past a threshold; the count says to look closer.
  if (tiers.length > 1) summary.tiers = tiers.length;
  return summary;
};

const nonNegativeNumber = (value, field) => {
  if (value === undefined) return undefined;
  if (!Number.isFinite(value) || value < 0) throw badRequest(`${field} must be a number of at least 0`);
  return value;
};

const positiveInteger = (value, field) => {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || value < 1) throw badRequest(`${field} must be a positive integer`);
  return value;
};

/** Cost fields the call names, or null when it names none. */
const readCostInput = (input) => {
  const cost = {};
  for (const [field, key] of COST_FIELDS) {
    const value = nonNegativeNumber(input[field], field);
    if (value !== undefined) cost[key] = value;
  }
  return Object.keys(cost).length ? cost : null;
};

// ============== OpenCode config files ==============

/** The one config file a write lands in, refusing a file that does not parse. */
const resolveConfigTarget = (configScope, directory) => {
  const scope = configScope ?? 'user';
  if (!CONFIG_SCOPES.includes(scope)) throw badRequest('configScope must be user or project');
  if (scope === 'project' && !directory) throw badRequest('configScope project needs a directory or projectId');
  const layers = readConfigLayers(directory || null);
  const targetPath = (scope === 'project' ? layers.paths.projectPath : layers.paths.userPath) || CONFIG_FILE;
  const broken = layers.layerErrors.find((entry) => entry.path === targetPath);
  if (broken) {
    throw new OpenChamberControlError(`${targetPath} is not valid JSONC; fix it before changing it here`, 409);
  }
  return { layers, scope, path: targetPath, config: getConfigForPath(layers, targetPath) };
};

/** Higher-precedence files whose value for the same key wins over the one just written. */
const overridingFiles = (target, holdsKey) => {
  const { layers, scope } = target;
  const above = [
    ...(scope === 'user' && layers.paths.userOverridePath ? [[layers.userOverrideConfig, layers.paths.userOverridePath]] : []),
    ...(scope === 'user' && layers.paths.projectPath ? [[layers.projectConfig, layers.paths.projectPath]] : []),
    ...(layers.paths.customPath ? [[layers.customConfig, layers.paths.customPath]] : []),
  ];
  return above.filter(([config, filePath]) => filePath !== target.path && holdsKey(config)).map(([, filePath]) => filePath);
};

const storedModelEntry = (config, providerID, modelID) => {
  const provider = readSectionEntry(config, 'providers', providerID).value;
  const models = isPlainObject(provider?.models) ? provider.models : null;
  return models && isPlainObject(models[modelID]) ? models[modelID] : null;
};

/**
 * Apply `edit` to `providers.<providerID>.models.<modelID>` in `config`.
 * A v2 entry is edited in place so fields OpenChamber does not model survive;
 * a v1 `provider.<id>` entry is rewritten in v2 shape first, because the
 * write lands under `providers`. `edit` returns the next model entry, or null
 * to remove it; emptied containers are pruned.
 */
const editModelEntry = (config, providerID, modelID, edit) => {
  const found = readSectionEntry(config, 'providers', providerID);
  const provider = found.legacy ? toProviderEntity(found.value) : (isPlainObject(found.value) ? found.value : {});
  const models = isPlainObject(provider.models) ? provider.models : {};
  const current = isPlainObject(models[modelID]) ? models[modelID] : null;
  const next = edit(current ? { ...current } : null);
  if (next) models[modelID] = next;
  else delete models[modelID];
  if (Object.keys(models).length > 0) provider.models = models;
  else delete provider.models;
  if (Object.keys(provider).length > 0) writeSectionEntry(config, 'providers', providerID, provider);
  else deleteSectionEntry(config, 'providers', providerID);
  return next;
};

const writeTarget = (target) => {
  try {
    writeConfig(target.config, target.path);
  } catch (error) {
    throw asControlError(error, 'Failed to write OpenCode configuration');
  }
};

/** The stored cost as `{ input, output, cacheRead, cacheWrite }`, accepting v1 `cache_read`. */
const storedCost = (cost) => {
  if (!isPlainObject(cost)) return {};
  const cache = isPlainObject(cost.cache) ? cost.cache : {};
  return Object.fromEntries([
    ['input', cost.input],
    ['output', cost.output],
    ['cacheRead', cache.read ?? cost.cache_read],
    ['cacheWrite', cache.write ?? cost.cache_write],
  ].filter(([, value]) => Number.isFinite(value)));
};

/**
 * The complete cost object to store: the requested fields over the stored
 * ones over the live catalog price, so naming one field never erases another.
 * OpenCode reads `input` and `output` as required and `cache` as a pair.
 */
const buildCost = (requested, stored, live, label) => {
  if (Array.isArray(stored)) {
    throw new OpenChamberControlError(`${label} has tiered pricing in config; edit that file directly`, 409);
  }
  const merged = { ...(live ?? {}), ...storedCost(stored), ...requested };
  for (const [field, key] of [['costInput', 'input'], ['costOutput', 'output']]) {
    if (!Number.isFinite(merged[key])) throw badRequest(`${field} is required: ${label} has no ${key} price yet`);
  }
  const hasRead = Number.isFinite(merged.cacheRead);
  const hasWrite = Number.isFinite(merged.cacheWrite);
  if (hasRead !== hasWrite) {
    throw badRequest(`${hasRead ? 'costCacheWrite' : 'costCacheRead'} is required: cache prices are set as a pair`);
  }
  const cost = { input: merged.input, output: merged.output };
  if (hasRead) cost.cache = { read: merged.cacheRead, write: merged.cacheWrite };
  return cost;
};

const readVariants = (value) => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((entry) => !asNonEmptyString(entry) && !isPlainObject(entry))) {
    throw badRequest('variants must be a list of variant IDs');
  }
  return toModelVariants(value.map((entry) => (isPlainObject(entry) ? entry : { id: entry.trim() })));
};

// ============== Actions ==============

export const createProviderActions = (deps) => {
  const { readSettingsFromDiskMigrated, persistSettings } = deps;

  const readSettings = async () => (await readSettingsFromDiskMigrated()) ?? {};

  /** projectId resolves through configured projects; an unknown one is an error, never the caller's directory. */
  const resolveDirectory = async (input, ctx) => {
    const projectId = asNonEmptyString(input.projectId);
    const directory = asNonEmptyString(input.directory);
    if (projectId && directory) throw badRequest('Provide only one of projectId or directory');
    if (!projectId) return { directory: directory || asNonEmptyString(ctx.contextDirectory) || null, project: null };
    const settings = await readSettings();
    const project = (Array.isArray(settings.projects) ? settings.projects : []).find((entry) => entry?.id === projectId);
    if (!project || !asNonEmptyString(project.path)) throw new OpenChamberControlError(`Project not found: ${projectId}`, 404);
    return { directory: project.path, project };
  };

  const fetchList = async (ctx, directory, kind) => {
    try {
      const client = await ctx.getClient(directory || '');
      const response = kind === 'providers' ? await client.provider.list() : await client.model.list();
      return listData(response);
    } catch (error) {
      throw asControlError(error, `Could not read the OpenCode ${kind === 'providers' ? 'provider' : 'model'} list`, 502);
    }
  };

  // A lookup that only validates input: failing or empty, it never rejects a
  // valid selection; the caller reports that it went unchecked.
  const tryFetchModels = async (ctx, directory) => {
    try {
      const models = await fetchList(ctx, directory, 'models');
      return models.length > 0 ? models : null;
    } catch {
      return null;
    }
  };

  const listProviders = async (input, ctx) => {
    const { directory } = await resolveDirectory(input, ctx);
    const [providers, models] = await Promise.all([
      fetchList(ctx, directory, 'providers'),
      fetchList(ctx, directory, 'models'),
    ]);
    const settings = await readSettings();
    const hidden = refList(settings.hiddenModels);
    const layers = readConfigLayers(directory);
    const disabled = readDisabledProviders(directory);
    const configuredIn = (providerID) => [
      ['user', layers.userConfig],
      ['user', layers.userOverrideConfig],
      ['project', layers.projectConfig],
      ['custom', layers.customConfig],
    ].filter(([, config]) => readSectionEntry(config, 'providers', providerID).value !== undefined)
      .map(([scope]) => scope)
      .filter((scope, index, all) => all.indexOf(scope) === index);
    const counts = (providerID) => {
      const own = models.filter((model) => model.providerID === providerID);
      const enabled = own.filter((model) => model.enabled !== false);
      return {
        total: own.length,
        enabled: enabled.length,
        visible: enabled.filter((model) => !hidden.some((ref) => sameRef(ref, providerID, model.id))).length,
      };
    };
    const listed = providers.map((provider) => ({
      id: provider.id,
      name: provider.name,
      activation: provider.activation,
      disabled: disabled.includes(provider.id),
      configuredIn: configuredIn(provider.id),
      models: counts(provider.id),
    }));
    // OpenCode drops turned-off providers from its list, so they are added
    // back from config; that is the only way to offer turning them on again.
    const turnedOff = disabled
      .filter((id) => !providers.some((provider) => provider.id === id))
      .map((id) => ({ id, name: id, activation: 'disabled', disabled: true, configuredIn: configuredIn(id), models: null }));
    return { providers: [...listed, ...turnedOff] };
  };

  const toggleProvider = (input) => {
    const providerId = readProviderId(input);
    const disabled = readBoolean(input, 'disabled', { required: true });
    if (!PROVIDER_ID_PATTERN.test(providerId)) throw badRequest('Invalid provider ID');
    try {
      const providers = setProviderDisabled(providerId, disabled, null);
      return { providerId, disabled, disabledProviders: providers, ...buildAppliedResponse(`Provider ${disabled ? 'turned off' : 'turned on'}. ${LIVE_HINT}`) };
    } catch (error) {
      throw asControlError(error, 'Failed to update disabled providers');
    }
  };

  const availableModels = async (input, ctx) => {
    const { directory } = await resolveDirectory(input, ctx);
    const providerId = asNonEmptyString(input.providerId);
    const enabledOnly = readBoolean(input, 'enabledOnly') === true;
    const [models, settings] = await Promise.all([fetchList(ctx, directory, 'models'), readSettings()]);
    const hidden = refList(settings.hiddenModels);
    const favorites = refList(settings.favoriteModels);
    const defaultModel = asNonEmptyString(settings.defaultModel);
    const result = models
      .filter((model) => !providerId || model.providerID === providerId)
      .map((model) => {
        const isHidden = hidden.some((ref) => sameRef(ref, model.providerID, model.id));
        return {
          model: modelKey(model.providerID, model.id),
          providerID: model.providerID,
          modelId: model.id,
          name: model.name,
          status: model.status,
          enabled: model.enabled !== false,
          hidden: isHidden,
          favorite: favorites.some((ref) => sameRef(ref, model.providerID, model.id)),
          default: defaultModel === modelKey(model.providerID, model.id),
          variants: (Array.isArray(model.variants) ? model.variants : []).map((variant) => variant.id),
          cost: summarizeCost(model.cost),
          limit: model.limit ?? null,
        };
      })
      .filter((model) => !enabledOnly || (model.enabled && !model.hidden));
    return { models: result, count: result.length };
  };

  const toggleModel = async (input, ctx) => {
    const { providerID, modelID } = readModelRef(input);
    const disabled = readBoolean(input, 'disabled', { required: true });
    const level = input.modelToggleLevel ?? 'openchamber';
    if (level !== 'openchamber' && level !== 'opencode') throw badRequest('modelToggleLevel must be openchamber or opencode');

    if (level === 'openchamber') {
      const settings = await readSettings();
      const others = refList(settings.hiddenModels).filter((ref) => !sameRef(ref, providerID, modelID));
      // Newest first, as the UI's toggleHiddenModel stores it.
      const hiddenModels = disabled ? [{ providerID, modelID }, ...others] : others;
      await persistSettings({ hiddenModels });
      return {
        model: modelKey(providerID, modelID),
        level,
        hidden: disabled,
        message: disabled ? 'Hidden in OpenChamber model pickers.' : 'Shown in OpenChamber model pickers.',
      };
    }

    const { directory } = await resolveDirectory(input, ctx);
    const target = resolveConfigTarget(input.configScope, directory);
    editModelEntry(target.config, providerID, modelID, (entry) => {
      const next = entry ?? {};
      if (disabled) return { ...next, disabled: true };
      delete next.disabled;
      return Object.keys(next).length > 0 ? next : null;
    });
    writeTarget(target);
    const overriddenBy = overridingFiles(target, (config) => storedModelEntry(config, providerID, modelID)?.disabled === !disabled);
    const result = {
      model: modelKey(providerID, modelID),
      level,
      disabled,
      ...buildAppliedResponse(`${disabled ? 'Disabled' : 'Enabled'} in OpenCode config. ${LIVE_HINT}`, { path: target.path, scope: target.scope }),
    };
    if (overriddenBy.length) result.warning = `Still ${disabled ? 'enabled' : 'disabled'} by ${overriddenBy.join(', ')}, which takes precedence`;
    return result;
  };

  /** Rejects a model the live catalog lacks; without a catalog there is nothing to check. */
  const checkModel = (models, providerID, modelID) => {
    if (models && !findModel(models, providerID, modelID)) {
      throw new OpenChamberControlError(`Model not found: ${modelKey(providerID, modelID)}. models.available lists the choices`, 404);
    }
  };

  const setDefaults = async (input, ctx) => {
    const touched = ['model', 'variant', 'agent'].filter((field) => input[field] !== undefined);
    if (touched.length === 0) throw badRequest('Provide at least one of model, variant, or agent');
    for (const field of touched) {
      if (!isString(input[field])) throw badRequest(`${field} must be a string; an empty string clears it`);
    }
    const writeOpenCode = readBoolean(input, 'writeOpenCodeDefault') === true;
    const { directory, project } = await resolveDirectory(input, ctx);
    const settings = await readSettings();
    const owner = project ?? settings;
    const warnings = [];

    const nextModel = input.model === undefined ? asNonEmptyString(owner.defaultModel) : asNonEmptyString(input.model);
    // A thinking level belongs to the model it was chosen for.
    let nextVariant = input.variant !== undefined
      ? asNonEmptyString(input.variant)
      : (input.model !== undefined ? null : asNonEmptyString(owner.defaultVariant));
    const nextAgent = input.agent === undefined ? asNonEmptyString(owner.defaultAgent) : asNonEmptyString(input.agent);

    const needsCatalog = (input.model !== undefined && nextModel && nextModel !== AUTO_MODEL) || (input.variant !== undefined && nextVariant);
    const models = needsCatalog ? await tryFetchModels(ctx, directory) : null;
    if (needsCatalog && !models) warnings.push('Could not check the selection against the OpenCode model list');

    let ref = null;
    if (nextModel) {
      const separator = nextModel.indexOf('/');
      if (separator <= 0 || separator === nextModel.length - 1) throw badRequest('model must be in provider/model format');
      ref = { providerID: nextModel.slice(0, separator), modelID: nextModel.slice(separator + 1) };
    }
    if (input.model !== undefined && ref && nextModel !== AUTO_MODEL) checkModel(models, ref.providerID, ref.modelID);
    if (input.variant !== undefined && nextVariant) {
      if (!ref) throw badRequest('variant needs a default model; pass model too');
      if (nextModel === AUTO_MODEL) throw badRequest('The automatic model has no effort variants');
      const catalogModel = models ? findModel(models, ref.providerID, ref.modelID) : null;
      if (catalogModel) {
        const ids = (Array.isArray(catalogModel.variants) ? catalogModel.variants : []).map((variant) => variant.id);
        if (!ids.includes(nextVariant)) {
          throw badRequest(ids.length
            ? `Variant ${nextVariant} is not offered by ${nextModel}; choose one of: ${ids.join(', ')}`
            : `${nextModel} has no effort variants`);
        }
      } else if (models) {
        warnings.push(`${nextModel} is not in the OpenCode model list, so the variant was not checked`);
      }
    }

    if (input.agent !== undefined && nextAgent) {
      try {
        const client = await ctx.getClient(directory || '');
        const agents = listData(await client.agent.list());
        if (agents.length > 0 && !agents.some((agent) => agent.id === nextAgent || agent.name === nextAgent)) {
          throw new OpenChamberControlError(`Agent not found: ${nextAgent}`, 404);
        }
        if (agents.length === 0) warnings.push('Could not check the agent against the OpenCode agent list');
      } catch (error) {
        if (error instanceof OpenChamberControlError) throw error;
        warnings.push('Could not check the agent against the OpenCode agent list');
      }
    }

    let openCode = null;
    if (writeOpenCode) {
      if (nextModel === AUTO_MODEL) throw badRequest('OpenCode cannot use the automatic model as its default');
      // Resolved before the settings write so a bad scope changes nothing.
      openCode = { target: resolveConfigTarget(input.configScope, directory) };
    }

    if (project) {
      const projects = (Array.isArray(settings.projects) ? settings.projects : []).map((entry) => {
        if (entry?.id !== project.id) return entry;
        const { defaultModel: _model, defaultVariant: _variant, defaultAgent: _agent, ...next } = entry;
        if (nextModel) next.defaultModel = nextModel;
        if (nextModel && nextVariant) next.defaultVariant = nextVariant;
        if (nextAgent) next.defaultAgent = nextAgent;
        return next;
      });
      await persistSettings({ projects });
    } else {
      // Empty strings clear, as the Settings UI sends them.
      const changes = {};
      if (input.model !== undefined) changes.defaultModel = nextModel ?? '';
      if (input.model !== undefined || input.variant !== undefined) changes.defaultVariant = nextVariant ?? '';
      if (input.agent !== undefined) changes.defaultAgent = nextAgent ?? '';
      await persistSettings(changes);
    }
    if (!nextModel) nextVariant = null;

    if (openCode) {
      const selection = ref ? formatModelSelection({ ...ref, variant: nextVariant ?? undefined }) : null;
      if (selection) openCode.target.config.model = selection;
      else delete openCode.target.config.model;
      writeTarget(openCode.target);
      openCode = { model: selection, path: openCode.target.path, scope: openCode.target.scope, message: LIVE_HINT };
    }

    const result = {
      defaultModel: nextModel ?? null,
      defaultVariant: nextVariant ?? null,
      defaultAgent: nextAgent ?? null,
    };
    if (project) result.projectId = project.id;
    if (openCode) result.openCodeDefault = openCode;
    if (warnings.length) result.warnings = warnings;
    return result;
  };

  /** True when the provider exists live or in any config layer; model writes need one. */
  const providerKnown = async (ctx, directory, target, providerID) => {
    const { layers } = target;
    const inConfig = [layers.userConfig, layers.userOverrideConfig, layers.projectConfig, layers.customConfig]
      .some((config) => readSectionEntry(config, 'providers', providerID).value !== undefined);
    if (inConfig) return true;
    const providers = await fetchList(ctx, directory, 'providers');
    return providers.some((provider) => provider.id === providerID);
  };

  const addProviderModel = async (input, ctx) => {
    const providerID = readProviderId(input);
    const modelID = asNonEmptyString(input.modelId);
    if (!modelID) throw badRequest('modelId is required');
    const name = input.name === undefined ? undefined : asNonEmptyString(input.name);
    if (input.name !== undefined && !name) throw badRequest('name cannot be empty');
    const context = positiveInteger(input.contextLimit, 'contextLimit');
    const output = positiveInteger(input.outputLimit, 'outputLimit');
    const variants = readVariants(input.variants);
    const requestedCost = readCostInput(input);
    const { directory } = await resolveDirectory(input, ctx);
    const target = resolveConfigTarget(input.configScope, directory);
    if (!(await providerKnown(ctx, directory, target, providerID))) {
      throw new OpenChamberControlError(`Provider not found: ${providerID}. Connect or create it first`, 404);
    }
    const models = await tryFetchModels(ctx, directory);
    const live = models ? findModel(models, providerID, modelID) : null;
    const label = modelKey(providerID, modelID);
    const existing = storedModelEntry(target.config, providerID, modelID);
    const cost = requestedCost ? buildCost(requestedCost, existing?.cost, summarizeCost(live?.cost), label) : undefined;

    const entry = editModelEntry(target.config, providerID, modelID, (current) => {
      const next = current ?? {};
      // A model the catalog already has is an overlay keyed by its catalog
      // id; a new one needs the id the provider's API expects.
      if (!live && !next.modelID && !next.id) next.modelID = modelID;
      if (name) next.name = name;
      if (context !== undefined || output !== undefined) {
        next.limit = isPlainObject(next.limit) ? { ...next.limit } : {};
        if (context !== undefined) next.limit.context = context;
        if (output !== undefined) next.limit.output = output;
      }
      if (variants !== undefined) {
        if (variants.length > 0) next.variants = variants;
        else delete next.variants;
      }
      if (cost) next.cost = cost;
      return next;
    });
    writeTarget(target);
    return {
      model: label,
      created: existing === null,
      entry,
      ...buildAppliedResponse(`${existing === null ? 'Added' : 'Updated'} ${label}. ${LIVE_HINT}`, { path: target.path, scope: target.scope }),
    };
  };

  const removeProviderModel = async (input, ctx) => {
    const providerID = readProviderId(input);
    const modelID = asNonEmptyString(input.modelId);
    if (!modelID) throw badRequest('modelId is required');
    const { directory } = await resolveDirectory(input, ctx);
    const target = resolveConfigTarget(input.configScope, directory);
    const label = modelKey(providerID, modelID);
    if (!storedModelEntry(target.config, providerID, modelID)) {
      throw new OpenChamberControlError(`${label} has no entry in ${target.path}`, 404);
    }
    editModelEntry(target.config, providerID, modelID, () => null);
    writeTarget(target);
    return {
      model: label,
      removed: true,
      ...buildAppliedResponse(`Removed ${label} from config. ${LIVE_HINT}`, { path: target.path, scope: target.scope }),
    };
  };

  const setModelCost = async (input, ctx) => {
    const { providerID, modelID } = readModelRef(input);
    const requested = readCostInput(input);
    if (!requested) throw badRequest('Provide at least one of costInput, costOutput, costCacheRead, costCacheWrite');
    const { directory } = await resolveDirectory(input, ctx);
    const target = resolveConfigTarget(input.configScope, directory);
    const label = modelKey(providerID, modelID);
    const existing = storedModelEntry(target.config, providerID, modelID);
    const configured = [target.layers.userConfig, target.layers.userOverrideConfig, target.layers.projectConfig, target.layers.customConfig]
      .some((config) => storedModelEntry(config, providerID, modelID) !== null);
    // Only an unconfigured model needs the catalog to prove it exists.
    const models = configured ? await tryFetchModels(ctx, directory) : await fetchList(ctx, directory, 'models');
    const live = models ? findModel(models, providerID, modelID) : null;
    // An entry with nothing but a price is not a model; a new one starts with provider.models.add.
    if (!configured && !live) {
      throw new OpenChamberControlError(`Model not found: ${label}. Add it with provider.models.add first`, 404);
    }
    const cost = buildCost(requested, existing?.cost, summarizeCost(live?.cost), label);
    editModelEntry(target.config, providerID, modelID, (current) => ({ ...(current ?? {}), cost }));
    writeTarget(target);
    const overriddenBy = overridingFiles(target, (config) => storedModelEntry(config, providerID, modelID)?.cost !== undefined);
    const result = {
      model: label,
      cost,
      unit: 'USD per million tokens',
      ...buildAppliedResponse(`Price set for ${label}. ${LIVE_HINT}`, { path: target.path, scope: target.scope }),
    };
    if (overriddenBy.length) result.warning = `A price in ${overriddenBy.join(', ')} takes precedence`;
    return result;
  };

  const handlers = {
    'providers.list': listProviders,
    'providers.toggle': toggleProvider,
    'models.available': availableModels,
    'models.toggle': toggleModel,
    'models.default': setDefaults,
    'provider.models.add': addProviderModel,
    'provider.models.remove': removeProviderModel,
    'models.cost': setModelCost,
  };

  const execute = async (action, input = {}, ctx = {}) => {
    const handler = Object.hasOwn(handlers, action) ? handlers[action] : null;
    if (!handler) throw badRequest(`Unsupported provider action: ${action || 'missing'}`);
    return handler(input ?? {}, ctx);
  };

  return { actions: Object.keys(handlers), execute };
};
