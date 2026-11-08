import { appendManagedCommand, appendManagedPermissions, appendManagedPolicies, appendManagedPlugin, appendManagedSkills } from './managed-plugin-config.js';
import { managedPermissionRules } from '../agent-tool/runtime.js';
import { isLimitFailoverConfigured } from '../limit-failover/policy.js';
import { materializeSessionTitlePlugin } from './session-title-plugin.js';
import { EXTENSION_AUTHORING_COMMAND, materializeAuthoringSkill } from '../guests/agent-context.js';

export const MANAGED_CONFIG_FILE_NAME = 'opencode.managed.json';

/**
 * Built-in OpenCode plugins OpenChamber switches off for its managed child.
 *
 * `opencode.browser` only works when OpenCode's own desktop app attaches a
 * browser to the session; OpenChamber does not implement that protocol, so its
 * tools always fail with `browser.disconnected` and agents conclude browsing is
 * unavailable instead of using `openchamber_web`. A project config that lists
 * `opencode.browser` still re-enables it, because that layer sits above ours.
 */
const DISABLED_BUILTIN_PLUGINS = ['-opencode.browser'];
/**
 * OpenCode's own `experimental_image_generate` tool (2.2.1+, on by default
 * since 2.2.2), switched off while `openchamber_image` is
 * on, so the agent sees one image tool, the one using the model the user chose.
 */
const BUILTIN_IMAGE_PLUGIN = '-opencode.tool.image-generate';

/**
 * Campaign prices a provider reports beside its quota (`quota/model-prices.js`).
 *
 * OpenCode takes its price list from models.dev, which carries the list price,
 * while DeepInfra bills a discount campaign. The usage read hands the reported
 * prices here, and they are written as `providers.<id>.models.<id>.cost` into
 * this layer: OpenCode watches the file, so the model card and the cost of the
 * running session show what the provider charges. Only the models the user
 * configured are written, because OpenCode reads a `models` entry as a model to
 * offer.
 */

/** A price is USD per million tokens; six decimals hold a campaign price. */
const roundPrice = (value) => Math.round(value * 1e6) / 1e6;

/**
 * Costs in the shape the quota providers report: `input` and `output` are
 * required, the cache prices optional. Anything else is dropped.
 *
 * @param {Record<string, {input?: number, output?: number, cache_read?: number, cache_write?: number}>} costs
 * @returns {Record<string, {input: number, output: number, cache_read?: number, cache_write?: number}>}
 */
const normalizeModelCosts = (costs) => {
  if (!costs || typeof costs !== 'object') return {};
  const normalized = {};
  for (const [modelId, cost] of Object.entries(costs)) {
    if (!modelId.trim() || !cost || typeof cost !== 'object') continue;
    const entry = {};
    for (const field of ['input', 'output', 'cache_read', 'cache_write']) {
      const value = cost[field];
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) entry[field] = roundPrice(value);
    }
    if (entry.input === undefined || entry.output === undefined) continue;
    normalized[modelId] = entry;
  }
  return normalized;
};

/** v2 model cost: `cache` nests the read and the write price. */
const toConfigModelCost = (cost) => {
  const cache = {};
  if (cost.cache_read !== undefined) cache.read = cost.cache_read;
  if (cost.cache_write !== undefined) cache.write = cost.cache_write;
  return {
    input: cost.input,
    output: cost.output,
    ...(Object.keys(cache).length ? { cache } : {})
  };
};

/** The inverse of `toConfigModelCost`: the prices this layer wrote last run. */
const fromConfigModelCost = (cost) => {
  if (!cost || typeof cost !== 'object') return null;
  const cache = cost.cache && typeof cost.cache === 'object' ? cost.cache : {};
  return normalizeModelCosts({
    model: { input: cost.input, output: cost.output, cache_read: cache.read, cache_write: cache.write }
  }).model ?? null;
};

/**
 * The prices an existing layer already holds, so a restart keeps the last
 * campaign price until the first provider read refreshes it.
 *
 * @param {object} config the parsed layer file
 * @returns {Record<string, Record<string, object>>} provider id to model costs
 */
const readModelCostsFromConfig = (config) => {
  const providers = {};
  const sections = [config?.providers, config?.provider].filter((section) => section && typeof section === 'object');
  for (const section of sections) {
    for (const [providerId, entry] of Object.entries(section)) {
      const models = entry && typeof entry === 'object' ? entry.models : null;
      if (!models || typeof models !== 'object') continue;
      const costs = {};
      for (const [modelId, model] of Object.entries(models)) {
        const cost = fromConfigModelCost(model?.cost);
        if (cost) costs[modelId] = cost;
      }
      if (Object.keys(costs).length > 0) providers[providerId] = { ...(providers[providerId] ?? {}), ...costs };
    }
  }
  return providers;
};

/**
 * The managed OpenCode config layer.
 *
 * OpenCode 2 watches every config source it reads, including the file named by
 * the `OPENCODE_CONFIG` environment variable, and reloads its plugin list when
 * that file changes. Writing OpenChamber's own plugin entries into a file we
 * own therefore makes toggling a managed tool take effect in the running
 * process — where `OPENCODE_CONFIG_CONTENT` (an environment variable) could
 * only ever change across a restart.
 *
 * The file is OpenChamber-owned and holds `plugins`: the built-in plugins
 * OpenChamber disables, then its own plugin directories; `policies`: the
 * `integration.use` denials for the plugins switched off in OpenChamber; and
 * `permissions` its tools need, such as the workflow answer tool denied
 * everywhere but in the sessions that allow it. OpenCode appends every layer's
 * permissions to each agent, so ours add to the user's rules and replace none.
 * `skills` lists our extension-writing skill and the folders active extensions
 * ship, and `commands` the command that starts extension work. `providers`
 * carries the campaign prices a quota provider reports for the models the user
 * configured (`quota/model-prices.js`), so OpenCode bills what the provider
 * charges instead of the models.dev list price. It sits above
 * the user's global `opencode.json` and below their project config, so it never
 * shadows a project-level choice. The plugin folders active extensions ship
 * come after OpenChamber's own plugins: OpenCode loads in list order, so an
 * extension never shadows a managed tool.
 *
 * When the user's own environment already sets `OPENCODE_CONFIG`, that file is
 * theirs: OpenChamber does not hijack it and falls back to merging its plugins
 * into `OPENCODE_CONFIG_CONTENT`, which keeps the old restart requirement for
 * managed-tool toggles.
 *
 * @param {object} dependencies
 * @param {typeof import('node:fs/promises')} dependencies.fsPromises
 * @param {typeof import('node:path')} dependencies.path
 * @param {string} dependencies.instanceDir this server's own directory (`instance-dir.js`)
 * @param {NodeJS.ProcessEnv} [dependencies.env] environment the managed child inherits
 * @param {object|null} [dependencies.agentToolRuntime]
 * @param {object|null} [dependencies.limitFailoverRuntime] `../limit-failover/runtime.js`; its plugin calls back through the agent tool's address
 * @param {() => Promise<object|null>} dependencies.readSettings
 * @param {() => Promise<string[]>} [dependencies.listExtensionSkillDirectories] skill folders of active extensions
 * @param {() => Promise<string[]>} [dependencies.listExtensionPluginDirectories] OpenCode plugin folders of active extensions
 * @param {string} [dependencies.openchamberVersion] the running app, which the extension-writing skill pins its SDK to
 * @param {() => { action: string, resource: string, effect: string }[]} [dependencies.readPluginDenials] the plugins switched off in OpenChamber
 */
export const createManagedConfigRuntime = ({
  fsPromises,
  path,
  instanceDir,
  env = process.env,
  agentToolRuntime = null,
  limitFailoverRuntime = null,
  readSettings,
  listExtensionSkillDirectories = async () => [],
  listExtensionPluginDirectories = async () => [],
  openchamberVersion,
  readPluginDenials = () => [],
}) => {
  const filePath = path.join(instanceDir, MANAGED_CONFIG_FILE_NAME);

  /** Prices the providers reported, provider id to model id to cost. */
  const providerModelCosts = new Map();
  let providerCostsLoaded = null;

  const ensureProviderModelCosts = async () => {
    if (providerCostsLoaded) return providerCostsLoaded;
    providerCostsLoaded = (async () => {
      try {
        const parsed = JSON.parse(await fsPromises.readFile(filePath, 'utf8'));
        for (const [providerId, costs] of Object.entries(readModelCostsFromConfig(parsed))) {
          providerModelCosts.set(providerId, costs);
        }
      } catch {
        // No layer yet, or one we cannot read: the first provider read fills it.
      }
    })();
    return providerCostsLoaded;
  };

  /** The `providers` section of the layer, or null while no price is known. */
  const providerCostsSection = () => {
    const providers = {};
    for (const [providerId, costs] of providerModelCosts) {
      const models = {};
      for (const [modelId, cost] of Object.entries(costs)) models[modelId] = { cost: toConfigModelCost(cost) };
      if (Object.keys(models).length > 0) providers[providerId] = { models };
    }
    return Object.keys(providers).length > 0 ? providers : null;
  };

  /** The user owns `OPENCODE_CONFIG` when their environment already set it. */
  const ownsConfigFile = () => (env.OPENCODE_CONFIG ?? '').trim().length === 0;

  const writeConfigFile = async ({ disabled, directories, extensionPlugins, permissions, policies, skills, commands }) => {
    await fsPromises.mkdir(instanceDir, { recursive: true });
    const config = { plugins: [...disabled, ...directories, ...extensionPlugins], skills, commands };
    if (policies.length > 0) config.policies = policies;
    if (permissions.length > 0) config.permissions = permissions;
    const providers = providerCostsSection();
    if (providers) config.providers = providers;
    const text = `${JSON.stringify(config, null, 2)}\n`;
    // Temp + rename: OpenCode reacts to the write immediately, and a partial
    // read would make it drop every managed plugin until the next change.
    const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    try {
      await fsPromises.writeFile(tmp, text, { encoding: 'utf8', mode: 0o600 });
      await fsPromises.rename(tmp, filePath);
    } catch (error) {
      await fsPromises.rm(tmp, { force: true }).catch(() => {});
      throw error;
    }
  };

  /**
   * Materialize the plugins the current settings ask for and return their
   * directories in load order, with the permission rules their tools need.
   * Directories exist on disk before the config file names them.
   */
  const materializeEnabledPlugins = async () => {
    const settings = await Promise.resolve(readSettings()).catch(() => null);
    const includeControl = settings?.agentControlToolEnabled !== false;
    const includeSchedule = settings?.agentScheduleToolEnabled !== false;
    const includeWeb = settings?.agentWebToolEnabled !== false;
    const includeMemory = settings?.agentMemoryToolEnabled === true;
    const includeKnowledge = settings?.agentKnowledgeToolEnabled !== false;
    const includeNotify = settings?.agentNotifyToolEnabled === true;
    const includeRender = settings?.agentRenderToolEnabled !== false;
    const includeImage = settings?.agentImageToolEnabled === true;
    const includeSecret = settings?.agentSecretToolEnabled !== false;
    const includeUsage = settings?.agentUsageToolEnabled === true;
    const includeWorkflow = settings?.agentWorkflowToolEnabled === true;

    const directories = [];
    let permissions = [];
    if (agentToolRuntime && (includeControl || includeSchedule || includeWeb || includeMemory || includeKnowledge || includeNotify || includeRender || includeImage || includeSecret || includeUsage || includeWorkflow)) {
      directories.push(await agentToolRuntime.materializePlugin({ includeControl, includeSchedule, includeWeb, includeMemory, includeKnowledge, includeNotify, includeRender, includeImage, includeSecret, includeUsage, includeWorkflow }));
      permissions = managedPermissionRules({ includeWorkflow });
    }
    // Only while an option is on: otherwise every limit error would cost the
    // plugin a round trip to hear "do nothing".
    if (agentToolRuntime && limitFailoverRuntime && isLimitFailoverConfigured(settings)) {
      directories.push(await limitFailoverRuntime.materializePlugin());
    }
    directories.push(await materializeSessionTitlePlugin({ fsPromises, path, instanceDir }));
    const disabled = includeImage ? [...DISABLED_BUILTIN_PLUGINS, BUILTIN_IMAGE_PLUGIN] : DISABLED_BUILTIN_PLUGINS;
    const authoring = await materializeAuthoringSkill({ fsPromises, instanceDir, openchamberVersion });
    const skills = [authoring.skillsRoot, ...await listExtensionSkillDirectories()];
    const extensionPlugins = await listExtensionPluginDirectories();
    return { disabled, directories, extensionPlugins, permissions, policies: readPluginDenials(), skills, commands: { [EXTENSION_AUTHORING_COMMAND]: authoring.command } };
  };

  let writing = null;
  let writeAgain = false;
  /**
   * One write at a time. The catalog is read before the file is written, so
   * two refreshes could land in read order and bring back what a pause just
   * removed; a request during a write runs the whole read-then-write once
   * more instead, so the file always ends with the newest catalog.
   */
  const writeLatestConfigFile = () => {
    if (writing) {
      writeAgain = true;
      return writing;
    }
    writing = (async () => {
      do {
        writeAgain = false;
        await ensureProviderModelCosts();
        await writeConfigFile(await materializeEnabledPlugins());
      } while (writeAgain);
    })().finally(() => {
      writing = null;
    });
    return writing;
  };

  /**
   * Record what a provider charges for the models the user configured and, when
   * that differs from the layer on disk, rewrite it so the running OpenCode
   * bills the new price. A no-op when the user owns `OPENCODE_CONFIG`: their
   * prices stay theirs and the next write of the file carries ours only if
   * OpenChamber ever owns it.
   *
   * @param {string} providerId
   * @param {Record<string, {input: number, output: number, cache_read?: number, cache_write?: number}>} costs
   * @returns {Promise<boolean>} whether the layer was rewritten
   */
  const setProviderModelCosts = async (providerId, costs) => {
    const id = typeof providerId === 'string' ? providerId.trim() : '';
    if (!id) return false;
    await ensureProviderModelCosts();
    const normalized = normalizeModelCosts(costs);
    const next = Object.keys(normalized).length > 0 ? normalized : null;
    if (JSON.stringify(providerModelCosts.get(id) ?? null) === JSON.stringify(next)) return false;
    if (next) providerModelCosts.set(id, next);
    else providerModelCosts.delete(id);
    if (!ownsConfigFile()) return false;
    await writeLatestConfigFile();
    return true;
  };

  /**
   * Environment for a managed OpenCode child: the callback URL and per-child
   * token are always present, so a tool enabled later in the session can still
   * call back without a restart.
   */
  const buildManagedChildEnv = async () => {
    const childEnv = agentToolRuntime ? agentToolRuntime.createChildEnv() : {};
    if (ownsConfigFile()) {
      await writeLatestConfigFile();
      return { ...childEnv, OPENCODE_CONFIG: filePath };
    }
    const enabled = await materializeEnabledPlugins();
    let content = env.OPENCODE_CONFIG_CONTENT;
    for (const directory of [...enabled.disabled, ...enabled.directories, ...enabled.extensionPlugins]) {
      content = appendManagedPlugin(content, directory, 'managed plugin');
    }
    if (enabled.policies.length > 0) content = appendManagedPolicies(content, enabled.policies);
    if (enabled.permissions.length > 0) content = appendManagedPermissions(content, enabled.permissions);
    content = appendManagedSkills(content, enabled.skills);
    for (const [name, command] of Object.entries(enabled.commands)) content = appendManagedCommand(content, name, command);
    return { ...childEnv, OPENCODE_CONFIG_CONTENT: content };
  };

  /**
   * Rewrite the managed config file after a managed-plugin setting or the
   * extension catalog changed, so the running OpenCode picks the new plugin
   * list up. A no-op when the user owns `OPENCODE_CONFIG`; those installs
   * still need a restart.
   *
   * @returns {Promise<{updated: boolean, reason?: string}>}
   */
  const refreshManagedConfigFile = async () => {
    if (!ownsConfigFile()) return { updated: false, reason: 'external-config' };
    await writeLatestConfigFile();
    return { updated: true };
  };

  return {
    filePath,
    ownsConfigFile,
    buildManagedChildEnv,
    refreshManagedConfigFile,
    setProviderModelCosts,
  };
};
