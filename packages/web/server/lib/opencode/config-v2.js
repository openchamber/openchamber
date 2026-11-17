import { z } from 'zod';
import { isRecord } from '../shared/guards.js';



const SECTIONS = {
  agents: { v2: 'agents', v1: 'agent' },
  commands: { v2: 'commands', v1: 'command' },
  providers: { v2: 'providers', v1: 'provider' },
};

function sectionKeys(kind) {
  const section = SECTIONS[kind];
  if (!section) throw new Error(`Unknown config section: ${kind}`);
  return section;
}

function readSectionEntry(config, kind, name) {
  const { v2, v1 } = sectionKeys(kind);
  if (isRecord(config?.[v2]) && config[v2][name] !== undefined) {
    return { value: config[v2][name], key: v2, legacy: false };
  }
  if (isRecord(config?.[v1]) && config[v1][name] !== undefined) {
    return { value: config[v1][name], key: v1, legacy: true };
  }
  return { value: undefined, key: null, legacy: false };
}

function writeSectionEntry(config, kind, name, value) {
  const { v2, v1 } = sectionKeys(kind);
  if (!isRecord(config[v2])) config[v2] = {};
  config[v2][name] = value;
  if (isRecord(config[v1]) && config[v1][name] !== undefined) {
    delete config[v1][name];
    if (Object.keys(config[v1]).length === 0) delete config[v1];
  }
  return v2;
}

function deleteSectionEntry(config, kind, name) {
  const { v2, v1 } = sectionKeys(kind);
  let removed = false;
  for (const key of [v2, v1]) {
    if (!isRecord(config?.[key]) || config[key][name] === undefined) continue;
    delete config[key][name];
    removed = true;
    if (Object.keys(config[key]).length === 0) delete config[key];
  }
  return removed;
}


const PERMISSION_EFFECTS = new Set(['allow', 'deny', 'ask']);

function normalizePermissionAction(action) {
  if (action === 'write' || action === 'patch') return 'edit';
  if (action === 'task') return 'subagent';
  if (action === 'bash') return 'shell';
  return action;
}

function makeRule(action, resource, effect) {
  return { action: String(action), resource: String(resource), effect };
}

function permissionMapToRules(value) {
  if (value === undefined || value === null) return [];
  if (typeof value === 'string') {
    return PERMISSION_EFFECTS.has(value) ? [makeRule('*', '*', value)] : [];
  }
  if (!isRecord(value)) return [];
  const rules = [];
  for (const [rawAction, raw] of Object.entries(value)) {
    const action = normalizePermissionAction(rawAction);
    if (typeof raw === 'string') {
      if (PERMISSION_EFFECTS.has(raw)) rules.push(makeRule(action, '*', raw));
      continue;
    }
    if (!isRecord(raw)) continue;
    for (const [resource, effect] of Object.entries(raw)) {
      if (PERMISSION_EFFECTS.has(effect)) rules.push(makeRule(action, resource, effect));
    }
  }
  return rules;
}

function toolsToRules(value) {
  if (!isRecord(value)) return [];
  return Object.entries(value)
    .filter(([, enabled]) => typeof enabled === 'boolean')
    .map(([action, enabled]) => makeRule(normalizePermissionAction(action), '*', enabled ? 'allow' : 'deny'));
}

function isPermissionRule(value) {
  return (
    isRecord(value)
    && typeof value.action === 'string'
    && typeof value.resource === 'string'
    && PERMISSION_EFFECTS.has(value.effect)
  );
}

function normalizePermissionRules(value) {
  if (Array.isArray(value)) return value.filter(isPermissionRule).map((rule) => makeRule(rule.action, rule.resource, rule.effect));
  return permissionMapToRules(value);
}

function effectiveAgentRules(globalRules, agentRules) {
  return [
    ...normalizePermissionRules(globalRules).map((rule) => ({ ...rule, source: 'global' })),
    ...normalizePermissionRules(agentRules).map((rule) => ({ ...rule, source: 'agent' })),
  ];
}

function readGlobalPermissionRules(config) {
  if (!isRecord(config)) return [];
  return [
    ...toolsToRules(config.tools),
    ...permissionMapToRules(config.permission),
    ...normalizePermissionRules(config.permissions),
  ];
}


function parseModelSelection(model, variant) {
  if (isRecord(model)) {
    return parseModelSelection(
      typeof model.providerID === 'string' && typeof (model.modelID ?? model.model) === 'string'
        ? `${model.providerID}/${model.modelID ?? model.model}`
        : undefined,
      model.variant,
    );
  }
  if (typeof model !== 'string') return null;
  const trimmed = model.trim();
  const separator = trimmed.indexOf('/');
  if (separator <= 0) return null;
  const providerID = trimmed.slice(0, separator);
  if (providerID.includes('#')) return null;
  const hash = trimmed.indexOf('#', separator + 1);
  const modelID = trimmed.slice(separator + 1, hash === -1 ? undefined : hash);
  const embedded = hash === -1 ? undefined : trimmed.slice(hash + 1);
  if (!modelID) return null;
  const chosen = embedded !== undefined ? embedded : (typeof variant === 'string' ? variant.trim() : undefined);
  if (chosen !== undefined && (!chosen || chosen.includes('#'))) return { providerID, modelID };
  return chosen ? { providerID, modelID, variant: chosen } : { providerID, modelID };
}

function formatModelSelection(selection) {
  if (typeof selection === 'string') {
    const parsed = parseModelSelection(selection);
    return parsed ? formatModelSelection(parsed) : null;
  }
  if (!isRecord(selection)) return null;
  const providerID = typeof selection.providerID === 'string' ? selection.providerID.trim() : '';
  const modelID = typeof (selection.modelID ?? selection.model) === 'string'
    ? String(selection.modelID ?? selection.model).trim()
    : '';
  if (!providerID || !modelID) return null;
  const variant = typeof selection.variant === 'string' ? selection.variant.trim() : '';
  return variant ? `${providerID}/${modelID}#${variant}` : `${providerID}/${modelID}`;
}


const AGENT_NATIVE_KEYS = new Set([
  'model',
  'request',
  'system',
  'description',
  'mode',
  'hidden',
  'color',
  'steps',
  'disabled',
  'permissions',
]);

const AGENT_REQUEST_BODY_KEYS = ['temperature', 'top_p'];

const AGENT_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;
const AGENT_COLOR_FALLBACK = '#aaaaaa';

function toAgentColor(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return AGENT_COLOR_PATTERN.test(trimmed) ? trimmed : AGENT_COLOR_FALLBACK;
}

function pickDefined(entries) {
  return Object.fromEntries(entries.filter(([, value]) => value !== undefined && value !== null));
}

function normalizeRequest(value, legacy) {
  const headers = isRecord(value?.headers) ? { ...value.headers } : undefined;
  const fromNative = isRecord(value?.body) ? { ...value.body } : {};
  const fromLegacy = isRecord(legacy?.options) ? { ...legacy.options } : {};
  for (const key of AGENT_REQUEST_BODY_KEYS) {
    if (typeof legacy?.[key] === 'number') fromLegacy[key] = legacy[key];
  }
  const body = { ...fromLegacy, ...fromNative };
  const request = pickDefined([
    ['headers', headers && Object.keys(headers).length ? headers : undefined],
    ['body', Object.keys(body).length ? body : undefined],
  ]);
  return Object.keys(request).length ? request : undefined;
}

function toAgentEntity(raw, body) {
  const source = isRecord(raw) ? raw : {};
  const system = typeof body === 'string' && body.length > 0
    ? body
    : (typeof source.system === 'string' ? source.system : (typeof source.prompt === 'string' ? source.prompt : undefined));
  const model = formatModelSelection(
    isRecord(source.model) ? source.model : parseModelSelection(source.model, source.variant),
  );
  const steps = typeof source.steps === 'number'
    ? source.steps
    : (typeof source.maxSteps === 'number' ? source.maxSteps : undefined);
  const disabled = typeof source.disabled === 'boolean'
    ? source.disabled
    : (typeof source.disable === 'boolean' ? source.disable : undefined);
  const permissions = source.permissions !== undefined
    ? normalizePermissionRules(source.permissions)
    : permissionMapToRules(source.permission);
  return pickDefined([
    ['system', system],
    ['description', typeof source.description === 'string' ? source.description : undefined],
    ['model', model],
    ['mode', ['primary', 'subagent', 'all'].includes(source.mode) ? source.mode : undefined],
    ['hidden', typeof source.hidden === 'boolean' ? source.hidden : undefined],
    ['color', toAgentColor(source.color)],
    ['steps', steps],
    ['disabled', disabled],
    ['request', normalizeRequest(source.request, source)],
    ['permissions', source.permissions !== undefined || source.permission !== undefined ? permissions : undefined],
  ]);
}

function fromAgentEntity(entity) {
  const canonical = toAgentEntity(entity);
  const { system, ...fields } = canonical;
  return { fields, system: typeof system === 'string' ? system : '' };
}

function isLegacyAgentFrontmatter(frontmatter) {
  if (!isRecord(frontmatter)) return false;
  return Object.keys(frontmatter).some((key) => key !== 'variant' && !AGENT_NATIVE_KEYS.has(key));
}


function toCommandEntity(raw, body) {
  const source = isRecord(raw) ? raw : {};
  const template = typeof body === 'string' && body.length > 0
    ? body
    : (typeof source.template === 'string' ? source.template : undefined);
  const subagent = typeof source.subagent === 'boolean'
    ? source.subagent
    : (typeof source.subtask === 'boolean' ? source.subtask : undefined);
  return pickDefined([
    ['template', template],
    ['description', typeof source.description === 'string' ? source.description : undefined],
    ['agent', typeof source.agent === 'string' ? source.agent : undefined],
    ['model', formatModelSelection(isRecord(source.model) ? source.model : parseModelSelection(source.model, source.variant))],
    ['subagent', subagent],
  ]);
}

function fromCommandEntity(entity) {
  const canonical = toCommandEntity(entity);
  const { template, ...fields } = canonical;
  return { fields, template: typeof template === 'string' ? template : '' };
}

const COMMAND_NATIVE_KEYS = new Set(['template', 'description', 'agent', 'model', 'subagent']);

function isLegacyCommandFrontmatter(frontmatter) {
  if (!isRecord(frontmatter)) return false;
  return Object.keys(frontmatter).some((key) => !COMMAND_NATIVE_KEYS.has(key));
}


function cleanStringMap(value) {
  if (!isRecord(value)) return undefined;
  const cleaned = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key && entry !== undefined && entry !== null) cleaned[key] = String(entry);
  }
  return Object.keys(cleaned).length ? cleaned : undefined;
}

function positiveInt(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.trunc(value) : undefined;
}

function toMcpTimeout(value) {
  if (isRecord(value)) {
    const timeout = pickDefined([
      ['startup', positiveInt(value.startup)],
      ['catalog', positiveInt(value.catalog)],
      ['execution', positiveInt(value.execution)],
    ]);
    return Object.keys(timeout).length ? timeout : undefined;
  }
  const flat = positiveInt(value);
  return flat === undefined ? undefined : { catalog: flat, execution: flat };
}

const MCP_PROTOCOLS = new Set(['legacy', 'auto', '2026-07-28']);

function toMcpProtocol(value) {
  return MCP_PROTOCOLS.has(value) ? value : undefined;
}

function toMcpOAuth(value) {
  if (value === false) return false;
  if (!isRecord(value)) return undefined;
  const oauth = pickDefined([
    ['client_id', trimmedString(value.client_id ?? value.clientId)],
    ['client_secret', trimmedString(value.client_secret ?? value.clientSecret)],
    ['scope', trimmedString(value.scope)],
    ['callback_port', positiveInt(value.callback_port ?? value.callbackPort)],
    ['redirect_uri', trimmedString(value.redirect_uri ?? value.redirectUri)],
    ['auth_server_metadata_url', trimmedString(value.auth_server_metadata_url)],
  ]);
  return Object.keys(oauth).length ? oauth : undefined;
}

function trimmedString(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function toMcpEntity(raw) {
  const source = isRecord(raw) ? raw : {};
  const type = source.type === 'remote' ? 'remote' : 'local';
  const disabled = typeof source.disabled === 'boolean'
    ? source.disabled
    : (typeof source.enabled === 'boolean' ? !source.enabled : undefined);
  const shared = pickDefined([
    ['disabled', disabled],
    ['codemode', typeof source.codemode === 'boolean' ? source.codemode : undefined],
    ['timeout', toMcpTimeout(source.timeout)],
    ['protocol', toMcpProtocol(source.protocol)],
  ]);
  if (type === 'local') {
    const command = Array.isArray(source.command) && source.command.length > 0
      ? source.command.map(String)
      : undefined;
    return pickDefined([
      ['type', 'local'],
      ['command', command],
      ['cwd', trimmedString(source.cwd)],
      ['environment', cleanStringMap(source.environment)],
      ...Object.entries(shared),
    ]);
  }
  return pickDefined([
    ['type', 'remote'],
    ['url', trimmedString(source.url)],
    ['headers', cleanStringMap(source.headers)],
    ['oauth', toMcpOAuth(source.oauth)],
    ...Object.entries(shared),
  ]);
}

function isMcpServerValue(value) {
  return isRecord(value) && (value.type === 'local' || value.type === 'remote');
}

function readMcpEntry(config, name) {
  const mcp = isRecord(config?.mcp) ? config.mcp : null;
  if (!mcp) return { value: undefined, key: null, legacy: false };
  if (isRecord(mcp.servers) && mcp.servers[name] !== undefined) {
    return { value: mcp.servers[name], key: 'mcp.servers', legacy: false };
  }
  if (name !== 'servers' && name !== 'timeout' && mcp[name] !== undefined) {
    return { value: mcp[name], key: 'mcp', legacy: true };
  }
  return { value: undefined, key: null, legacy: false };
}

function readMcpEntries(config) {
  const mcp = isRecord(config?.mcp) ? config.mcp : {};
  const result = new Map();
  for (const [name, value] of Object.entries(mcp)) {
    if (name === 'servers' || name === 'timeout' || !isMcpServerValue(value)) continue;
    result.set(name, { value, key: 'mcp', legacy: true });
  }
  if (isRecord(mcp.servers)) {
    for (const [name, value] of Object.entries(mcp.servers)) {
      result.set(name, { value, key: 'mcp.servers', legacy: false });
    }
  }
  return result;
}

function readLayeredMcpEntries(configs) {
  const result = new Map();
  for (const config of configs) {
    for (const [name, entry] of readMcpEntries(config)) result.set(name, entry);
  }
  return result;
}

function writeMcpEntry(config, name, value) {
  if (!isRecord(config.mcp)) config.mcp = {};
  if (!isRecord(config.mcp.servers)) config.mcp.servers = {};
  config.mcp.servers[name] = value;
  if (config.mcp[name] !== undefined && name !== 'servers' && name !== 'timeout') delete config.mcp[name];
  return 'mcp.servers';
}

function deleteMcpEntry(config, name) {
  const mcp = isRecord(config?.mcp) ? config.mcp : null;
  if (!mcp) return false;
  let removed = false;
  if (isRecord(mcp.servers) && mcp.servers[name] !== undefined) {
    delete mcp.servers[name];
    removed = true;
    if (Object.keys(mcp.servers).length === 0) delete mcp.servers;
  }
  if (name !== 'servers' && name !== 'timeout' && mcp[name] !== undefined) {
    delete mcp[name];
    removed = true;
  }
  if (Object.keys(mcp).length === 0) delete config.mcp;
  return removed;
}


const AISDK_PREFIX = 'aisdk:';

function toProviderPackage(value) {
  const trimmed = trimmedString(value);
  if (!trimmed) return undefined;
  if (trimmed.startsWith('@opencode/ai/')) return trimmed;
  return trimmed.includes(':') ? trimmed : `${AISDK_PREFIX}${trimmed}`;
}

function toModelVariants(value) {
  if (Array.isArray(value)) {
    return value
      .filter((entry) => isRecord(entry) && trimmedString(entry.id))
      .map((entry) => pickDefined([
        ['id', trimmedString(entry.id)],
        ['settings', isRecord(entry.settings) ? { ...entry.settings } : undefined],
        ['headers', cleanStringMap(entry.headers)],
        ['body', isRecord(entry.body) ? { ...entry.body } : undefined],
      ]));
  }
  if (!isRecord(value)) return undefined;
  return Object.entries(value).map(([id, settings]) => pickDefined([
    ['id', id],
    ['settings', isRecord(settings) ? { ...settings } : undefined],
  ]));
}

function toModelCapabilities(source) {
  const modalities = isRecord(source.modalities) ? source.modalities : {};
  if (isRecord(source.capabilities)) {
    return pickDefined([
      ['tools', typeof source.capabilities.tools === 'boolean' ? source.capabilities.tools : true],
      ['input', Array.isArray(source.capabilities.input) ? source.capabilities.input.map(String) : ['text', 'image']],
      ['output', Array.isArray(source.capabilities.output) ? source.capabilities.output.map(String) : ['text']],
    ]);
  }
  if (typeof source.tool_call !== 'boolean' && !Array.isArray(modalities.input) && !Array.isArray(modalities.output)) {
    return undefined;
  }
  return {
    tools: typeof source.tool_call === 'boolean' ? source.tool_call : true,
    input: Array.isArray(modalities.input) ? modalities.input.map(String) : ['text', 'image'],
    output: Array.isArray(modalities.output) ? modalities.output.map(String) : ['text'],
  };
}

function toModelCost(value) {
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) return undefined;
  const nativeCache = isRecord(value.cache) ? value.cache : {};
  const cache = pickDefined([
    ['read', typeof nativeCache.read === 'number' ? nativeCache.read : value.cache_read],
    ['write', typeof nativeCache.write === 'number' ? nativeCache.write : value.cache_write],
  ]);
  return pickDefined([
    ['tier', isRecord(value.tier) ? { ...value.tier } : undefined],
    ['input', typeof value.input === 'number' ? value.input : undefined],
    ['output', typeof value.output === 'number' ? value.output : undefined],
    ['cache', Object.keys(cache).length ? cache : undefined],
  ]);
}

function toModelCompatibility(source) {
  if (isRecord(source.compatibility)) {
    return Object.keys(source.compatibility).length ? { ...source.compatibility } : undefined;
  }
  const interleaved = source.interleaved;
  if (typeof interleaved === 'string') return interleaved ? { reasoningField: interleaved } : undefined;
  if (isRecord(interleaved) && typeof interleaved.field === 'string') return { reasoningField: interleaved.field };
  return undefined;
}

function toProviderModelEntity(raw) {
  const source = isRecord(raw) ? raw : {};
  const legacyOptions = isRecord(source.options) ? { ...source.options } : undefined;
  const settings = isRecord(source.settings) ? { ...source.settings } : legacyOptions;
  return pickDefined([
    ['modelID', trimmedString(source.modelID ?? source.id)],
    ['name', trimmedString(source.name)],
    ['type', trimmedString(source.type)],
    ['family', trimmedString(source.family)],
    ['compatibility', toModelCompatibility(source)],
    ['package', toProviderPackage(source.package ?? source.provider?.npm)],
    ['settings', source.provider?.api ? { ...(settings ?? {}), baseURL: source.provider.api } : settings],
    ['headers', cleanStringMap(source.headers)],
    ['body', isRecord(source.body) ? { ...source.body } : undefined],
    ['capabilities', toModelCapabilities(source)],
    ['variants', toModelVariants(source.variants)],
    ['cost', toModelCost(source.cost)],
    ['limit', isRecord(source.limit) ? { ...source.limit } : undefined],
    ['disabled', typeof source.disabled === 'boolean' ? source.disabled : (source.status === 'deprecated' ? true : undefined)],
  ]);
}

function toProviderEntity(raw) {
  const source = isRecord(raw) ? raw : {};
  const legacyOptions = isRecord(source.options) ? { ...source.options } : {};
  const { headers: legacyHeaders, body: legacyBody, ...legacySettings } = legacyOptions;
  const settings = { ...legacySettings };
  if (isRecord(source.settings)) Object.assign(settings, source.settings);
  const baseURL = trimmedString(source.settings?.baseURL) ?? trimmedString(source.api) ?? trimmedString(legacySettings.baseURL);
  if (baseURL) settings.baseURL = baseURL;
  const models = isRecord(source.models)
    ? Object.fromEntries(Object.entries(source.models).map(([id, model]) => [id, toProviderModelEntity(model)]))
    : undefined;
  return pickDefined([
    ['canonical', trimmedString(source.canonical)],
    ['name', trimmedString(source.name)],
    ['package', toProviderPackage(source.package ?? source.npm)],
    ['env', Array.isArray(source.env) ? source.env.filter((entry) => typeof entry === 'string' && entry.trim()).map((entry) => entry.trim()) : undefined],
    ['settings', Object.keys(settings).length ? settings : undefined],
    ['headers', cleanStringMap(source.headers ?? legacyHeaders)],
    ['body', isRecord(source.body ?? legacyBody) ? { ...(source.body ?? legacyBody) } : undefined],
    ['models', models],
  ]);
}

function readStoredProviderEntry(configs, providerId) {
  for (const config of configs) {
    const { value } = readSectionEntry(config, 'providers', providerId);
    if (value === undefined) continue;
    const entity = toProviderEntity(value);
    if (entity.settings && 'apiKey' in entity.settings) {
      const { apiKey: _secret, ...settings } = entity.settings;
      if (Object.keys(settings).length) entity.settings = settings;
      else delete entity.settings;
    }
    return entity;
  }
  return null;
}


const PLUGIN_SECTION = { v2: 'plugins', v1: 'plugin' };

function toPluginEntity(raw) {
  if (typeof raw === 'string') {
    const spec = raw.trim();
    return spec ? { package: spec } : null;
  }
  if (Array.isArray(raw)) {
    const spec = typeof raw[0] === 'string' ? raw[0].trim() : '';
    if (!spec) return null;
    return isRecord(raw[1]) && Object.keys(raw[1]).length ? { package: spec, options: { ...raw[1] } } : { package: spec };
  }
  if (isRecord(raw)) {
    const spec = trimmedString(raw.package ?? raw.spec);
    if (!spec) return null;
    return isRecord(raw.options) && Object.keys(raw.options).length
      ? { package: spec, options: { ...raw.options } }
      : { package: spec };
  }
  return null;
}

function fromPluginEntity(entity) {
  const normalized = toPluginEntity(entity);
  if (!normalized) return null;
  return normalized.options ? { package: normalized.package, options: normalized.options } : normalized.package;
}

function readPluginList(config) {
  const legacy = Array.isArray(config?.[PLUGIN_SECTION.v1]) ? config[PLUGIN_SECTION.v1] : [];
  const native = Array.isArray(config?.[PLUGIN_SECTION.v2]) ? config[PLUGIN_SECTION.v2] : [];
  return [
    ...legacy.map((raw) => ({ entry: toPluginEntity(raw), key: PLUGIN_SECTION.v1, legacy: true })),
    ...native.map((raw) => ({ entry: toPluginEntity(raw), key: PLUGIN_SECTION.v2, legacy: false })),
  ].filter((item) => item.entry !== null);
}


function parseWebSearchSelection(value) {
  if (value === null || value === false) return value;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function writeWebSearchSelection(config, selection) {
  const before = JSON.stringify(config.websearch);
  if (selection === null) {
    delete config.websearch;
  } else if (selection === false) {
    config.websearch = false;
  } else {
    config.websearch = { provider: selection };
  }
  return JSON.stringify(config.websearch) !== before;
}


function writeWarmingEnabled(config, enabled) {
  const before = JSON.stringify(config.warming);
  if (!enabled) {
    delete config.warming;
  } else if (typeof config.warming !== 'object' || config.warming === null) {
    config.warming = true;
  }
  return JSON.stringify(config.warming) !== before;
}

function writeWarmingDuration(config, minutes) {
  if (!config.warming) return false;
  const before = JSON.stringify(config.warming);
  const tuned = isRecord(config.warming) ? { ...config.warming } : {};
  delete tuned.duration;
  if (minutes !== 30) tuned.duration = `${minutes} minutes`;
  config.warming = Object.keys(tuned).length > 0 ? tuned : true;
  return JSON.stringify(config.warming) !== before;
}


const tokenCount = z.number().int().min(0).max(10_000_000);
const compactionTokens = tokenCount.nullable().optional();
const compactionPercent = z.string().regex(/^([1-9]\d?(\.\d+)?)%$/u);

const compactionUpdateSchema = z.object({
  auto: z.boolean().optional(),
  buffer: z.union([compactionPercent, tokenCount]).nullable().optional(),
  keepTokens: compactionTokens,
  background: z.boolean().optional(),
}).strict();

const setOrDelete = (owner, key, value) => {
  if (value === null) delete owner[key];
  else owner[key] = value;
};

const nestedRecord = (owner, key) => (isRecord(owner[key]) ? { ...owner[key] } : {});

const assignOrDrop = (owner, key, record) => {
  if (Object.keys(record).length > 0) owner[key] = record;
  else delete owner[key];
};

function writeCompactionSettings(config, update) {
  const before = JSON.stringify([config.compaction, config.experimental]);
  if (update.auto !== undefined || update.buffer !== undefined || update.keepTokens !== undefined) {
    const compaction = nestedRecord(config, 'compaction');
    if (update.auto !== undefined) compaction.auto = update.auto;
    if (update.buffer !== undefined) setOrDelete(compaction, 'buffer', update.buffer);
    if (update.keepTokens !== undefined) {
      const keep = nestedRecord(compaction, 'keep');
      setOrDelete(keep, 'tokens', update.keepTokens);
      assignOrDrop(compaction, 'keep', keep);
    }
    assignOrDrop(config, 'compaction', compaction);
  }
  if (update.background !== undefined) {
    const experimental = nestedRecord(config, 'experimental');
    setOrDelete(experimental, 'background_compaction', update.background);
    assignOrDrop(config, 'experimental', experimental);
  }
  return JSON.stringify([config.compaction, config.experimental]) !== before;
}

function findWebSearchProjectOverride(layers, projectFiles) {
  const userPath = layers?.paths?.userPath ?? null;
  const winner = (projectFiles ?? [])
    .find((file) => file?.path && file.path !== userPath && isRecord(file.config) && Object.hasOwn(file.config, 'websearch'));
  return winner && winner.path !== layers?.paths?.customPath ? winner.path : null;
}


const skillSwitchRequestSchema = z.object({
  id: z.string().min(1).max(200).refine((id) => id.trim() === id && !/[*?/\\\n\r]/.test(id)),
  enabled: z.boolean(),
  scope: z.enum(['user', 'project']),
});

const isSkillDeny = (statement, id) => isRecord(statement)
  && statement.effect === 'deny'
  && ((statement.action === 'skill.use' && statement.resource === id)
    || (statement.action === 'integration.use' && statement.resource === `skill:${id}`));

const isSkillAllow = (statement, id) => isRecord(statement)
  && statement.effect === 'allow'
  && ((statement.action === 'skill.use' && statement.resource === id)
    || (statement.action === 'integration.use' && statement.resource === `skill:${id}`));

const endsWithSkillDeny = (statements, id) => {
  for (let index = statements.length - 1; index >= 0; index -= 1) {
    if (isSkillDeny(statements[index], id)) return true;
    if (isSkillAllow(statements[index], id)) return false;
  }
  return false;
};

function writeSkillDisabled(config, id, disabled) {
  const lists = [
    { owner: config, key: 'policies' },
    ...(isRecord(config.experimental) ? [{ owner: config.experimental, key: 'policies' }] : []),
  ].filter(({ owner, key }) => Array.isArray(owner[key]));

  if (disabled) {
    const statements = [...lists].reverse().flatMap(({ owner, key }) => owner[key]);
    if (endsWithSkillDeny(statements, id)) return false;
    const policies = Array.isArray(config.policies) ? config.policies : [];
    config.policies = [...policies, { action: 'skill.use', resource: id, effect: 'deny' }];
    return true;
  }

  let changed = false;
  for (const { owner, key } of lists) {
    const kept = owner[key].filter((statement) => !isSkillDeny(statement, id));
    if (kept.length === owner[key].length) continue;
    changed = true;
    if (kept.length > 0) owner[key] = kept;
    else delete owner[key];
  }
  if (changed && isRecord(config.experimental) && Object.keys(config.experimental).length === 0) {
    delete config.experimental;
  }
  return changed;
}

export {
  PLUGIN_SECTION,
  isRecord,
  readSectionEntry,
  writeSectionEntry,
  deleteSectionEntry,
  normalizePermissionAction,
  permissionMapToRules,
  normalizePermissionRules,
  effectiveAgentRules,
  readGlobalPermissionRules,
  parseModelSelection,
  formatModelSelection,
  toAgentEntity,
  fromAgentEntity,
  isLegacyAgentFrontmatter,
  toCommandEntity,
  fromCommandEntity,
  isLegacyCommandFrontmatter,
  toMcpEntity,
  readMcpEntry,
  readMcpEntries,
  readLayeredMcpEntries,
  writeMcpEntry,
  deleteMcpEntry,
  toModelVariants,
  toProviderPackage,
  toProviderEntity,
  readStoredProviderEntry,
  toPluginEntity,
  fromPluginEntity,
  readPluginList,
  parseWebSearchSelection,
  writeWebSearchSelection,
  findWebSearchProjectOverride,
  writeWarmingEnabled,
  writeWarmingDuration,
  compactionUpdateSchema,
  writeCompactionSettings,
  skillSwitchRequestSchema,
  writeSkillDisabled,
};
