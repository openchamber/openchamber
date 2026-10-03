/**
 * Canonical OpenCode 2.x config shapes for every OpenChamber entity surface.
 *
 * OpenChamber reads user-authored OpenCode config, so it must accept the v1
 * spellings OpenCode 2 still decodes (section key `agent`, permission maps,
 * `npm`/`api` providers, plugin tuples, ...). Everything OpenChamber WRITES is
 * native v2. These conversions are pure so the web server and the VS Code
 * extension host cannot drift: `packages/vscode/src/opencode-config-v2.ts`
 * re-exports this module.
 *
 * Reference: OpenCode `packages/core/src/config/normalize.ts`,
 * `packages/core/src/v1/config/migrate.ts`, and `services/www` migrate-v1 docs.
 */

// ============== SECTIONS ==============

/**
 * Config section keys per entity. `v2` is what OpenChamber writes; `v1` is the
 * legacy key OpenCode still decodes and OpenChamber still reads.
 */
const SECTIONS = {
  agents: { v2: 'agents', v1: 'agent' },
  commands: { v2: 'commands', v1: 'command' },
  providers: { v2: 'providers', v1: 'provider' },
};

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function sectionKeys(kind) {
  const section = SECTIONS[kind];
  if (!section) throw new Error(`Unknown config section: ${kind}`);
  return section;
}

/**
 * Read one entry from a config object, preferring the v2 section key.
 * Returns the section key the entry was found under so writers can rewrite the
 * same file in place.
 */
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

/**
 * Write an entry in native v2 shape. When the name currently lives under the v1
 * key in this same file, the legacy entry is dropped so the two spellings can
 * never disagree; unrelated v1 siblings are left untouched.
 */
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

/** Remove an entry from both spellings. Returns true when anything was removed. */
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

// ============== PERMISSIONS ==============

const PERMISSION_EFFECTS = new Set(['allow', 'deny', 'ask']);

/**
 * v1 permission/tool keys renamed in v2. Mirrors
 * `ConfigMigrateV1.normalizeAction`, so migrated rules keep matching.
 */
function normalizePermissionAction(action) {
  if (action === 'write' || action === 'patch') return 'edit';
  if (action === 'task') return 'subagent';
  if (action === 'bash') return 'shell';
  return action;
}

function makeRule(action, resource, effect) {
  return { action: String(action), resource: String(resource), effect };
}

/**
 * Translate a v1 `permission` value (`"ask"`, `{edit: "allow"}`, or
 * `{bash: {"git push *": "ask"}}`) into the ordered v2 rule array.
 */
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

/** v1 `tools: {websearch: false}` becomes deny/allow rules, as the normalizer does. */
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

/**
 * Accept either shape and always answer the ordered v2 rule array: v2
 * `permissions` arrays pass through, v1 `permission` maps/strings translate.
 */
function normalizePermissionRules(value) {
  if (Array.isArray(value)) return value.filter(isPermissionRule).map((rule) => makeRule(rule.action, rule.resource, rule.effect));
  return permissionMapToRules(value);
}

/**
 * Rules that apply to an agent, in evaluation order (global first, agent last;
 * last match wins). `source` marks where each rule came from so an editor can
 * show which are inherited.
 */
function effectiveAgentRules(globalRules, agentRules) {
  return [
    ...normalizePermissionRules(globalRules).map((rule) => ({ ...rule, source: 'global' })),
    ...normalizePermissionRules(agentRules).map((rule) => ({ ...rule, source: 'agent' })),
  ];
}

/**
 * Global permission rules of a config object: v1 `tools`, then v1 `permission`,
 * then native `permissions` — the order `normalize.ts` concatenates them in.
 */
function readGlobalPermissionRules(config) {
  if (!isRecord(config)) return [];
  return [
    ...toolsToRules(config.tools),
    ...permissionMapToRules(config.permission),
    ...normalizePermissionRules(config.permissions),
  ];
}

// ============== MODEL SELECTION ==============

/**
 * Split `provider/model#variant` (or a v1 `{model, variant}` pair) into parts.
 * Returns null when the reference is not a valid v2 selection, matching
 * `Model.Ref.parse`.
 */
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

/** Join a selection back into the v2 `provider/model#variant` string. */
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

// ============== AGENTS ==============

/**
 * Frontmatter keys OpenCode 2 treats as native. Any other key in an agent file
 * routes the WHOLE file through the v1 decoder (`config/plugin/agent.ts`), so a
 * writer must never mix native and legacy keys in one file.
 */
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

/**
 * v2 accepts only a six-digit hex color (`schema/src/config/agent.ts`). v1
 * also allowed theme names (`primary`, ...); OpenCode's own migration
 * (`core/src/v1/config/migrate.ts`) turns those into `#aaaaaa`, so a record
 * OpenChamber rewrites stays decodable instead of being skipped.
 */
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

/**
 * Read an agent from either spelling into the canonical API shape.
 * `body` is the markdown body for .md agents; it always wins over a frontmatter
 * `system` key, because OpenCode overrides `system` with the body.
 */
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

/**
 * Native v2 agent fields for persistence. `system` is returned separately
 * because a markdown agent carries it as the body, never as frontmatter.
 */
function fromAgentEntity(entity) {
  const canonical = toAgentEntity(entity);
  const { system, ...fields } = canonical;
  return { fields, system: typeof system === 'string' ? system : '' };
}

/** True when frontmatter uses a v1-only agent key and OpenChamber must rewrite it. */
function isLegacyAgentFrontmatter(frontmatter) {
  if (!isRecord(frontmatter)) return false;
  return Object.keys(frontmatter).some((key) => key !== 'variant' && !AGENT_NATIVE_KEYS.has(key));
}

// ============== COMMANDS ==============

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

// ============== MCP ==============

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

/** v1 `timeout: 30000` becomes `{catalog, execution}`; a v2 object passes through. */
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

/** MCP protocol negotiation, added in OpenCode 2.0.8. Unknown values are dropped. */
function toMcpProtocol(value) {
  return MCP_PROTOCOLS.has(value) ? value : undefined;
}

/** v1 OAuth camelCase becomes v2 snake_case. */
function toMcpOAuth(value) {
  if (value === false) return false;
  if (!isRecord(value)) return undefined;
  const oauth = pickDefined([
    ['client_id', trimmedString(value.client_id ?? value.clientId)],
    ['client_secret', trimmedString(value.client_secret ?? value.clientSecret)],
    ['scope', trimmedString(value.scope)],
    ['callback_port', positiveInt(value.callback_port ?? value.callbackPort)],
    ['redirect_uri', trimmedString(value.redirect_uri ?? value.redirectUri)],
    // OpenCode 2.0.8 addition. OpenChamber has no UI for it; it is carried
    // through so a hand-written value survives an edit made here.
    ['auth_server_metadata_url', trimmedString(value.auth_server_metadata_url)],
  ]);
  return Object.keys(oauth).length ? oauth : undefined;
}

function trimmedString(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Canonical v2 MCP server entry. `type` is required (v2 drops enabled-only v1
 * entries entirely), `enabled` inverts into `disabled`, timeouts split.
 */
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
    // OpenCode 2.0.8 addition, on both local and remote entries. No OpenChamber
    // UI for it yet; carried through so a hand-written value is not dropped.
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

/**
 * MCP servers live at `mcp.servers` in v2 and directly under `mcp` in v1.
 * Anything without a `type` is not a server entry (`mcp.timeout`, and the
 * enabled-only v1 entries v2 drops outright).
 */
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

/**
 * MCP entries across config layers, lowest precedence first. Each layer is
 * normalized on its own before precedence applies: merging the raw objects
 * first would let a v2 `mcp.servers.<name>` in the user file shadow a v1
 * `mcp.<name>` override in the project file.
 */
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

// ============== PROVIDERS ==============

const AISDK_PREFIX = 'aisdk:';

/** v1 `npm: "@ai-sdk/x"` becomes v2 `package: "aisdk:@ai-sdk/x"`. */
function toProviderPackage(value) {
  const trimmed = trimmedString(value);
  if (!trimmed) return undefined;
  return trimmed.includes(':') ? trimmed : `${AISDK_PREFIX}${trimmed}`;
}

/** Strip the `aisdk:` prefix for editors that speak npm package names. */
function toNpmPackage(value) {
  const trimmed = trimmedString(value);
  if (!trimmed) return undefined;
  return trimmed.startsWith(AISDK_PREFIX) ? trimmed.slice(AISDK_PREFIX.length) : trimmed;
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

/**
 * v2 `compatibility` passes through; v1 `interleaved` migrates the way
 * OpenCode does (`core/src/model.ts` `compatibility()`): a string or
 * `{field}` names the reasoning field, a boolean carries nothing.
 */
function toModelCompatibility(source) {
  if (isRecord(source.compatibility)) {
    return Object.keys(source.compatibility).length ? { ...source.compatibility } : undefined;
  }
  const interleaved = source.interleaved;
  if (typeof interleaved === 'string') return interleaved ? { reasoningField: interleaved } : undefined;
  if (isRecord(interleaved) && typeof interleaved.field === 'string') return { reasoningField: interleaved.field };
  return undefined;
}

/** Canonical v2 model entry: `modelID`, `capabilities`, `cache.read/write`, variants array. */
function toProviderModelEntity(raw) {
  const source = isRecord(raw) ? raw : {};
  const legacyOptions = isRecord(source.options) ? { ...source.options } : undefined;
  const settings = isRecord(source.settings) ? { ...source.settings } : legacyOptions;
  return pickDefined([
    ['modelID', trimmedString(source.modelID ?? source.id)],
    ['name', trimmedString(source.name)],
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

/** Canonical v2 provider entry: `package` with `aisdk:`, `settings.baseURL`, split overlays. */
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
    // v2-only: the built-in provider this entry inherits models/defaults from.
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

/**
 * The provider entry an editor should start from: the winning config layer's
 * stored entry (layers passed highest precedence first) in v2 shape, without
 * the literal `settings.apiKey` secret. Returns null when no layer defines it.
 * Unlike the live provider OpenCode serves, this carries `env` and only the
 * reasoning levels the user wrote.
 */
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

// ============== PLUGINS ==============

const PLUGIN_SECTION = { v2: 'plugins', v1: 'plugin' };

/** Accept a v1 string/tuple or a v2 `{package, options}` object. */
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

/**
 * v2 serialization: a bare string when there are no options, otherwise
 * `{package, options}`. Never a tuple.
 */
function fromPluginEntity(entity) {
  const normalized = toPluginEntity(entity);
  if (!normalized) return null;
  return normalized.options ? { package: normalized.package, options: normalized.options } : normalized.package;
}

/** Plugin list of a config object, v1 entries first (the normalizer's order). */
function readPluginList(config) {
  const legacy = Array.isArray(config?.[PLUGIN_SECTION.v1]) ? config[PLUGIN_SECTION.v1] : [];
  const native = Array.isArray(config?.[PLUGIN_SECTION.v2]) ? config[PLUGIN_SECTION.v2] : [];
  return [
    ...legacy.map((raw) => ({ entry: toPluginEntity(raw), key: PLUGIN_SECTION.v1, legacy: true })),
    ...native.map((raw) => ({ entry: toPluginEntity(raw), key: PLUGIN_SECTION.v2, legacy: false })),
  ].filter((item) => item.entry !== null);
}

// ============== WEB SEARCH ==============

/**
 * The `websearch` key: `false` turns search off, `{ provider }` names a
 * provider id or `"random"`. OpenChamber takes the choice flat (`false`, a
 * string, or `null` to remove the key so OpenCode falls back to the answer
 * given in chat, asking only when there is none).
 * Returns `undefined` for anything else.
 */
function parseWebSearchSelection(value) {
  if (value === null || value === false) return value;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

/** Applies a parsed choice to a config object; returns whether it changed. */
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

// ============== SESSION WARMING ==============

/**
 * The `warming` key: `true` keeps idle sessions' prompt cache warm with
 * OpenCode's defaults, an object tunes prompt/interval/duration. Turning it on
 * keeps a hand-tuned object as is; turning it off removes the key (OpenCode's
 * default is off). Returns whether the config changed.
 */
function writeWarmingEnabled(config, enabled) {
  const before = JSON.stringify(config.warming);
  if (!enabled) {
    delete config.warming;
  } else if (typeof config.warming !== 'object' || config.warming === null) {
    config.warming = true;
  }
  return JSON.stringify(config.warming) !== before;
}

const hasWebSearchKey = (config) => config != null && Object.hasOwn(config, 'websearch');

/**
 * The project config path whose `websearch` wins over the file the Settings
 * choice is written to, or `null`. OpenCode merges user < project files (every
 * `opencode.json[c]` and `.opencode/opencode.json[c]` from the directory up to
 * the project root) < `OPENCODE_CONFIG`, so any project file with the key
 * decides unless `OPENCODE_CONFIG` sets it too. `layers` is what
 * `readConfigLayers(directory)` returns; `projectFiles` lists the existing
 * project config files deepest first, as `{ path, config }`.
 */
function findWebSearchProjectOverride(layers, projectFiles) {
  if (hasWebSearchKey(layers?.customConfig)) return null;
  const userPath = layers?.paths?.userPath ?? null;
  for (const file of projectFiles ?? []) {
    if (!file?.path || file.path === userPath) continue;
    if (hasWebSearchKey(file.config)) return file.path;
  }
  return null;
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
  toNpmPackage,
  toProviderEntity,
  readStoredProviderEntry,
  toPluginEntity,
  fromPluginEntity,
  readPluginList,
  parseWebSearchSelection,
  writeWebSearchSelection,
  findWebSearchProjectOverride,
  writeWarmingEnabled,
};
