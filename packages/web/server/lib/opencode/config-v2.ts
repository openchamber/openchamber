import { z } from 'zod';
import { isBoolean, isRecord, isString } from '../shared/guards.js';
import type { JsonValue } from '../shared/json-values.js';
import type { OpenCodeConfigLayer } from './config-files.js';
import { toModelModalities } from './model-modalities.js';
import type {
  AgentEntity, AgentMode, AgentRequest, CommandEntity, ConfigField, DefinedFields,
  EffectivePermissionRule, JsonPluginEntity, McpEntity, McpOAuth, McpProtocol, McpTimeout,
  ModelCapabilities, ModelSelection, ModelVariant, PermissionEffect, PermissionRule,
  PluginEntity, PluginListItem, ProviderEntity, ProviderModelEntity, ReadableConfig,
  SectionLookup, WebSearchConfigLayers, WebSearchSelection,
} from './config-v2-contracts.js';
export type { AgentEntity, CommandEntity, EffectivePermissionRule, McpEntity, McpOAuth, McpTimeout, PermissionRule, ProviderEntity, ProviderModelEntity, WebSearchSelection } from './config-v2-contracts.js';
export type SectionKind = keyof typeof SECTIONS;
export type CompactionUpdate = z.infer<typeof compactionUpdateSchema>;
function hasReadableFields<Key extends PropertyKey>(input: unknown): input is { [Field in Key]?: unknown } {
  return input != null;
}
function readConfigField<Key extends PropertyKey>(input: ConfigField, key: Key) {
  return hasReadableFields<Key>(input) ? input[key] : undefined;
}
function recordOrEmpty(input: ConfigField) {
  return isRecord(input) ? input : {};
}
const isNumber = (value: unknown): value is number => typeof value === 'number';
const isList = (value: unknown): value is readonly unknown[] => Array.isArray(value);

const SECTIONS = {
  agents: { v2: 'agents', v1: 'agent' },
  commands: { v2: 'commands', v1: 'command' },
  providers: { v2: 'providers', v1: 'provider' },
} as const;

function sectionKeys(kind: SectionKind) {
  const section = SECTIONS[kind];
  if (!section) throw new Error(`Unknown config section: ${kind}`);
  return section;
}

export function readSectionEntry<Config>(config: Config, kind: SectionKind, name: string): SectionLookup {
  const { v2, v1 } = sectionKeys(kind);
  const native = readConfigField(config, v2);
  if (isRecord(native) && native[name] !== undefined) {
    return { value: native[name], key: v2, legacy: false };
  }
  const legacy = readConfigField(config, v1);
  if (isRecord(legacy) && legacy[name] !== undefined) {
    return { value: legacy[name], key: v1, legacy: true };
  }
  return { value: undefined, key: null, legacy: false };
}

export function writeSectionEntry<Value>(config: ReadableConfig, kind: SectionKind, name: string, value: Value) {
  const { v2, v1 } = sectionKeys(kind);
  const native = isRecord(config[v2]) ? config[v2] : (config[v2] = {});
  native[name] = value;
  const legacy = config[v1];
  if (isRecord(legacy) && legacy[name] !== undefined) {
    delete legacy[name];
    if (Object.keys(legacy).length === 0) delete config[v1];
  }
  return v2;
}

export function deleteSectionEntry(config: ReadableConfig, kind: SectionKind, name: string) {
  const { v2, v1 } = sectionKeys(kind);
  let removed = false;
  for (const key of [v2, v1]) {
    const section = config?.[key];
    if (!isRecord(section) || !Object.hasOwn(section, name) || section[name] === undefined) continue;
    delete section[name];
    removed = true;
    if (Object.keys(section).length === 0) delete config[key];
  }
  return removed;
}
const PERMISSION_EFFECTS: ReadonlySet<unknown> = new Set(['allow', 'deny', 'ask']);
const isPermissionEffect = (value: unknown): value is PermissionEffect => PERMISSION_EFFECTS.has(value);

export function normalizePermissionAction(action: string) {
  if (action === 'write' || action === 'patch') return 'edit';
  if (action === 'task') return 'subagent';
  if (action === 'bash') return 'shell';
  return action;
}

function makeRule(action: string, resource: string, effect: PermissionEffect): PermissionRule {
  return { action: String(action), resource: String(resource), effect };
}

export function permissionMapToRules<Value>(value: Value): PermissionRule[] {
  if (value === undefined || value === null) return [];
  if (isString(value)) {
    return isPermissionEffect(value) ? [makeRule('*', '*', value)] : [];
  }
  if (!isRecord(value)) return [];
  const rules = [];
  for (const [rawAction, raw] of Object.entries(value)) {
    const action = normalizePermissionAction(rawAction);
    if (isString(raw)) {
      if (isPermissionEffect(raw)) rules.push(makeRule(action, '*', raw));
      continue;
    }
    if (!isRecord(raw)) continue;
    for (const [resource, effect] of Object.entries(raw)) {
      if (isPermissionEffect(effect)) rules.push(makeRule(action, resource, effect));
    }
  }
  return rules;
}

function toolsToRules<Value>(value: Value) {
  if (!isRecord(value)) return [];
  return Object.entries(value)
    .filter(([, enabled]) => isBoolean(enabled))
    .map(([action, enabled]) => makeRule(normalizePermissionAction(action), '*', enabled ? 'allow' : 'deny'));
}

function isPermissionRule(value: unknown): value is PermissionRule {
  return (
    isRecord(value)
    && isString(value.action)
    && isString(value.resource)
    && isPermissionEffect(value.effect)
  );
}

export function normalizePermissionRules<Value>(value: Value) {
  if (isList(value)) return value.filter(isPermissionRule).map((rule) => makeRule(rule.action, rule.resource, rule.effect));
  return permissionMapToRules(value);
}

export function effectiveAgentRules<GlobalRules, AgentRules>(globalRules: GlobalRules, agentRules: AgentRules): EffectivePermissionRule[] {
  return [
    ...normalizePermissionRules(globalRules).map((rule): EffectivePermissionRule => ({ ...rule, source: 'global' })),
    ...normalizePermissionRules(agentRules).map((rule): EffectivePermissionRule => ({ ...rule, source: 'agent' })),
  ];
}

export function readGlobalPermissionRules<Config>(config: Config) {
  if (!isRecord(config)) return [];
  return [
    ...toolsToRules(config.tools),
    ...permissionMapToRules(config.permission),
    ...normalizePermissionRules(config.permissions),
  ];
}
export function parseModelSelection<Model, Variant = undefined>(model: Model, variant?: Variant): ModelSelection | null {
  if (isRecord(model)) {
    return parseModelSelection(
      isString(model.providerID) && isString(model.modelID ?? model.model)
        ? `${model.providerID}/${model.modelID ?? model.model}`
        : undefined,
      model.variant,
    );
  }
  if (!isString(model)) return null;
  const trimmed = model.trim();
  const separator = trimmed.indexOf('/');
  if (separator <= 0) return null;
  const providerID = trimmed.slice(0, separator);
  if (providerID.includes('#')) return null;
  const hash = trimmed.indexOf('#', separator + 1);
  const modelID = trimmed.slice(separator + 1, hash === -1 ? undefined : hash);
  const embedded = hash === -1 ? undefined : trimmed.slice(hash + 1);
  if (!modelID) return null;
  const chosen = embedded !== undefined ? embedded : (isString(variant) ? variant.trim() : undefined);
  if (chosen !== undefined && (!chosen || chosen.includes('#'))) return { providerID, modelID };
  return chosen ? { providerID, modelID, variant: chosen } : { providerID, modelID };
}

export function formatModelSelection<Selection>(selection: Selection): string | null {
  if (isString(selection)) {
    const parsed = parseModelSelection(selection);
    return parsed ? formatModelSelection(parsed) : null;
  }
  if (!isRecord(selection)) return null;
  const providerID = isString(selection.providerID) ? selection.providerID.trim() : '';
  const modelID = isString(selection.modelID ?? selection.model)
    ? String(selection.modelID ?? selection.model).trim()
    : '';
  if (!providerID || !modelID) return null;
  const variant = isString(selection.variant) ? selection.variant.trim() : '';
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

const AGENT_REQUEST_BODY_KEYS = ['temperature', 'top_p'] as const;

const AGENT_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;
const AGENT_COLOR_FALLBACK = '#aaaaaa';

function toAgentColor<Value>(value: Value) {
  if (!isString(value)) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return AGENT_COLOR_PATTERN.test(trimmed) ? trimmed : AGENT_COLOR_FALLBACK;
}

function pickDefined<Fields extends object>(fields: Fields): DefinedFields<Fields>;
function pickDefined<Fields extends object>(fields: Fields) {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined && value !== null));
}

interface LegacyAgentOptions { options?: unknown; temperature?: unknown; top_p?: unknown }
function normalizeRequest<Value>(value: Value, legacy: LegacyAgentOptions): AgentRequest | undefined {
  const rawHeaders = readConfigField(value, 'headers');
  const rawBody = readConfigField(value, 'body');
  const headers = isRecord(rawHeaders) ? { ...rawHeaders } : undefined;
  const fromNative = isRecord(rawBody) ? { ...rawBody } : {};
  const fromLegacy = isRecord(legacy?.options) ? { ...legacy.options } : {};
  for (const key of AGENT_REQUEST_BODY_KEYS) {
    if (isNumber(legacy?.[key])) fromLegacy[key] = legacy[key];
  }
  const body = { ...fromLegacy, ...fromNative };
  const request = pickDefined({
    headers: headers && Object.keys(headers).length ? headers : undefined,
    body: Object.keys(body).length ? body : undefined,
  });
  return Object.keys(request).length ? request : undefined;
}

const isAgentMode = (value: unknown): value is AgentMode => value === 'primary' || value === 'subagent' || value === 'all';

export function toAgentEntity<Raw>(raw: Raw, body?: string): AgentEntity {
  const source = recordOrEmpty(raw);
  const system = isString(body) && body.length > 0
    ? body
    : (isString(source.system) ? source.system : (isString(source.prompt) ? source.prompt : undefined));
  const model = formatModelSelection(
    isRecord(source.model) ? source.model : parseModelSelection(source.model, source.variant),
  );
  const steps = isNumber(source.steps)
    ? source.steps
    : (isNumber(source.maxSteps) ? source.maxSteps : undefined);
  const disabled = isBoolean(source.disabled)
    ? source.disabled
    : (isBoolean(source.disable) ? source.disable : undefined);
  const permissions = source.permissions !== undefined
    ? normalizePermissionRules(source.permissions)
    : permissionMapToRules(source.permission);
  return pickDefined({
    system,
    description: isString(source.description) ? source.description : undefined,
    model,
    mode: isAgentMode(source.mode) ? source.mode : undefined,
    hidden: isBoolean(source.hidden) ? source.hidden : undefined,
    color: toAgentColor(source.color),
    steps,
    disabled,
    request: normalizeRequest(source.request, source),
    permissions: source.permissions !== undefined || source.permission !== undefined ? permissions : undefined,
  });
}

export function fromAgentEntity<Entity>(entity: Entity) {
  const canonical = toAgentEntity(entity);
  const { system, ...fields } = canonical;
  return { fields, system: system ?? '' };
}

export function isLegacyAgentFrontmatter<Frontmatter>(frontmatter: Frontmatter) {
  if (!isRecord(frontmatter)) return false;
  return Object.keys(frontmatter).some((key) => key !== 'variant' && !AGENT_NATIVE_KEYS.has(key));
}
export function toCommandEntity<Raw>(raw: Raw, body?: string): CommandEntity {
  const source = recordOrEmpty(raw);
  const template = isString(body) && body.length > 0
    ? body
    : (isString(source.template) ? source.template : undefined);
  const subagent = isBoolean(source.subagent)
    ? source.subagent
    : (isBoolean(source.subtask) ? source.subtask : undefined);
  return pickDefined({
    template,
    description: isString(source.description) ? source.description : undefined,
    agent: isString(source.agent) ? source.agent : undefined,
    model: formatModelSelection(isRecord(source.model) ? source.model : parseModelSelection(source.model, source.variant)),
    subagent,
  });
}

export function fromCommandEntity<Entity>(entity: Entity) {
  const canonical = toCommandEntity(entity);
  const { template, ...fields } = canonical;
  return { fields, template: template ?? '' };
}

const COMMAND_NATIVE_KEYS = new Set(['template', 'description', 'agent', 'model', 'subagent']);

export function isLegacyCommandFrontmatter<Frontmatter>(frontmatter: Frontmatter) {
  if (!isRecord(frontmatter)) return false;
  return Object.keys(frontmatter).some((key) => !COMMAND_NATIVE_KEYS.has(key));
}
function cleanStringMap<Value>(value: Value) {
  if (!isRecord(value)) return undefined;
  const cleaned: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key && entry !== undefined && entry !== null) cleaned[key] = String(entry);
  }
  return Object.keys(cleaned).length ? cleaned : undefined;
}

function positiveInt<Value>(value: Value) {
  return isNumber(value) && Number.isFinite(value) && value > 0 ? Math.trunc(value) : undefined;
}

function toMcpTimeout<Value>(value: Value): McpTimeout | undefined {
  if (isRecord(value)) {
    const timeout = pickDefined({
      startup: positiveInt(value.startup),
      catalog: positiveInt(value.catalog),
      execution: positiveInt(value.execution),
    });
    return Object.keys(timeout).length ? timeout : undefined;
  }
  const flat = positiveInt(value);
  return flat === undefined ? undefined : { catalog: flat, execution: flat };
}

const MCP_PROTOCOLS: ReadonlySet<unknown> = new Set(['legacy', 'auto', '2026-07-28']);
const isMcpProtocol = (value: unknown): value is McpProtocol => MCP_PROTOCOLS.has(value);

function toMcpProtocol<Value>(value: Value) {
  return isMcpProtocol(value) ? value : undefined;
}

function toMcpOAuth<Value>(value: Value): McpOAuth | false | undefined {
  if (value === false) return false;
  if (!isRecord(value)) return undefined;
  const oauth = pickDefined({
    client_id: trimmedString(value.client_id ?? value.clientId),
    client_secret: trimmedString(value.client_secret ?? value.clientSecret),
    scope: trimmedString(value.scope),
    callback_port: positiveInt(value.callback_port ?? value.callbackPort),
    redirect_uri: trimmedString(value.redirect_uri ?? value.redirectUri),
    auth_server_metadata_url: trimmedString(value.auth_server_metadata_url),
  });
  return Object.keys(oauth).length ? oauth : undefined;
}

function trimmedString<Value>(value: Value) {
  if (!isString(value)) return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export function toMcpEntity<Raw>(raw: Raw): McpEntity {
  const source = recordOrEmpty(raw);
  const type = source.type === 'remote' ? 'remote' : 'local';
  const disabled = isBoolean(source.disabled)
    ? source.disabled
    : (isBoolean(source.enabled) ? !source.enabled : undefined);
  const shared = pickDefined({
    disabled,
    codemode: isBoolean(source.codemode) ? source.codemode : undefined,
    timeout: toMcpTimeout(source.timeout),
    protocol: toMcpProtocol(source.protocol),
  });
  if (type === 'local') {
    const command = Array.isArray(source.command) && source.command.length > 0
      ? source.command.map(String)
      : undefined;
    return pickDefined({
      type: 'local' as const,
      command,
      cwd: trimmedString(source.cwd),
      environment: cleanStringMap(source.environment),
      ...shared,
    });
  }
  return pickDefined({
    type: 'remote' as const,
    url: trimmedString(source.url),
    headers: cleanStringMap(source.headers),
    oauth: toMcpOAuth(source.oauth),
    ...shared,
  });
}

function isMcpServerValue<Value>(value: Value) {
  return isRecord(value) && (value.type === 'local' || value.type === 'remote');
}

export function readMcpEntry<Config>(config: Config, name: string): SectionLookup {
  const raw = readConfigField(config, 'mcp');
  const mcp = isRecord(raw) ? raw : null;
  if (!mcp) return { value: undefined, key: null, legacy: false };
  if (isRecord(mcp.servers) && mcp.servers[name] !== undefined) {
    return { value: mcp.servers[name], key: 'mcp.servers', legacy: false };
  }
  if (name !== 'servers' && name !== 'timeout' && mcp[name] !== undefined) {
    return { value: mcp[name], key: 'mcp', legacy: true };
  }
  return { value: undefined, key: null, legacy: false };
}

export function readMcpEntries<Config>(config: Config): Map<string, SectionLookup> {
  const raw = readConfigField(config, 'mcp');
  const mcp = isRecord(raw) ? raw : {};
  const result = new Map<string, SectionLookup>();
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

export function readLayeredMcpEntries<Config>(configs: readonly Config[]) {
  const result = new Map<string, SectionLookup>();
  for (const config of configs) {
    for (const [name, entry] of readMcpEntries(config)) result.set(name, entry);
  }
  return result;
}

export function writeMcpEntry<Value>(config: ReadableConfig, name: string, value: Value) {
  const mcp = isRecord(config.mcp) ? config.mcp : (config.mcp = {});
  const servers = isRecord(mcp.servers) ? mcp.servers : (mcp.servers = {});
  servers[name] = value;
  if (mcp[name] !== undefined && name !== 'servers' && name !== 'timeout') delete mcp[name];
  return 'mcp.servers';
}

export function deleteMcpEntry(config: ReadableConfig, name: string) {
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

export function toProviderPackage<Value>(value: Value) {
  const trimmed = trimmedString(value);
  if (!trimmed) return undefined;
  if (trimmed.startsWith('@opencode/ai/')) return trimmed;
  return trimmed.includes(':') ? trimmed : `${AISDK_PREFIX}${trimmed}`;
}

export function toModelVariants(value: readonly unknown[]): ModelVariant[];
export function toModelVariants<Value>(value: Value): ModelVariant[] | undefined;
export function toModelVariants<Value>(value: Value): ModelVariant[] | undefined {
  if (isList(value)) {
    return value
      .filter((entry): entry is { id?: unknown; settings?: unknown; headers?: unknown; body?: unknown } =>
        isRecord(entry) && Boolean(trimmedString(entry.id)))
      .map((entry) => pickDefined({
          id: trimmedString(entry.id),
          settings: isRecord(entry.settings) ? { ...entry.settings } : undefined,
          headers: cleanStringMap(entry.headers),
          body: isRecord(entry.body) ? { ...entry.body } : undefined,
        }));
  }
  if (!isRecord(value)) return undefined;
  return Object.entries(value).map(([id, settings]) => pickDefined({
    id,
    settings: isRecord(settings) ? { ...settings } : undefined,
  }));
}

function toModelCapabilities(source: { modalities?: unknown; capabilities?: unknown; tool_call?: unknown }): ModelCapabilities | undefined {
  const modalities = isRecord(source.modalities) ? source.modalities : {};
  if (isRecord(source.capabilities)) {
    const capabilities = pickDefined({
      tools: isBoolean(source.capabilities.tools) ? source.capabilities.tools : undefined,
      input: isList(source.capabilities.input) ? toModelModalities(source.capabilities.input) : undefined,
      output: isList(source.capabilities.output) ? toModelModalities(source.capabilities.output) : undefined,
    });
    return Object.keys(capabilities).length ? capabilities : undefined;
  }
  if (!isBoolean(source.tool_call) && !Array.isArray(modalities.input) && !Array.isArray(modalities.output)) {
    return undefined;
  }
  return {
    tools: isBoolean(source.tool_call) ? source.tool_call : true,
    input: isList(modalities.input) ? toModelModalities(modalities.input) : ['text', 'image'],
    output: isList(modalities.output) ? toModelModalities(modalities.output) : ['text'],
  };
}

function toModelCost<Value>(value: Value) {
  if (isList(value)) return value;
  if (!isRecord(value)) return undefined;
  const nativeCache = isRecord(value.cache) ? value.cache : {};
  const cache = pickDefined({
    read: isNumber(nativeCache.read) ? nativeCache.read : value.cache_read,
    write: isNumber(nativeCache.write) ? nativeCache.write : value.cache_write,
  });
  return pickDefined({
    tier: isRecord(value.tier) ? { ...value.tier } : undefined,
    input: isNumber(value.input) ? value.input : undefined,
    output: isNumber(value.output) ? value.output : undefined,
    cache: Object.keys(cache).length ? cache : undefined,
  });
}

function toModelCompatibility(source: { compatibility?: unknown; interleaved?: unknown }) {
  if (isRecord(source.compatibility)) {
    return Object.keys(source.compatibility).length ? { ...source.compatibility } : undefined;
  }
  const interleaved = source.interleaved;
  if (isString(interleaved)) return interleaved ? { reasoningField: interleaved } : undefined;
  if (isRecord(interleaved) && isString(interleaved.field)) return { reasoningField: interleaved.field };
  return undefined;
}

function toProviderModelEntity<Raw>(raw: Raw): ProviderModelEntity {
  const source = recordOrEmpty(raw);
  const legacyOptions = isRecord(source.options) ? { ...source.options } : undefined;
  const settings = isRecord(source.settings) ? { ...source.settings } : legacyOptions;
  return pickDefined({
    modelID: trimmedString(source.modelID ?? source.id),
    name: trimmedString(source.name),
    type: trimmedString(source.type),
    family: trimmedString(source.family),
    compatibility: toModelCompatibility(source),
    package: toProviderPackage(source.package ?? readConfigField(source.provider, 'npm')),
    settings: readConfigField(source.provider, 'api') ? { ...(settings ?? {}), baseURL: readConfigField(source.provider, 'api') } : settings,
    headers: cleanStringMap(source.headers),
    body: isRecord(source.body) ? { ...source.body } : undefined,
    capabilities: toModelCapabilities(source),
    variants: toModelVariants(source.variants),
    cost: toModelCost(source.cost),
    limit: isRecord(source.limit) ? { ...source.limit } : undefined,
    disabled: isBoolean(source.disabled) ? source.disabled : (source.status === 'deprecated' ? true : undefined),
  });
}

export function toProviderEntity<Raw>(raw: Raw): ProviderEntity {
  const source = recordOrEmpty(raw);
  const legacyOptions = isRecord(source.options) ? { ...source.options } : {};
  const { headers: legacyHeaders, body: legacyBody, ...legacySettings } = legacyOptions;
  const settings = { ...legacySettings };
  if (isRecord(source.settings)) Object.assign(settings, source.settings);
  const baseURL = trimmedString(readConfigField(source.settings, 'baseURL')) ?? trimmedString(source.api) ?? trimmedString(legacySettings.baseURL);
  if (baseURL) settings.baseURL = baseURL;
  const models = isRecord(source.models)
    ? Object.fromEntries(Object.entries(source.models).map(([id, model]) => [id, toProviderModelEntity(model)]))
    : undefined;
  const body = source.body ?? legacyBody;
  return pickDefined({
    canonical: trimmedString(source.canonical),
    name: trimmedString(source.name),
    package: toProviderPackage(source.package ?? source.npm),
    env: isList(source.env) ? source.env.filter((entry): entry is string => isString(entry) && Boolean(entry.trim())).map((entry) => entry.trim()) : undefined,
    settings: Object.keys(settings).length ? settings : undefined,
    headers: cleanStringMap(source.headers ?? legacyHeaders),
    body: isRecord(body) ? { ...body } : undefined,
    models,
  });
}

export function readStoredProviderEntry<Config>(configs: readonly Config[], providerId: string) {
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
export const PLUGIN_SECTION = { v2: 'plugins', v1: 'plugin' };

export function toPluginEntity(raw: JsonValue | undefined): JsonPluginEntity | null;
export function toPluginEntity<Raw>(raw: Raw): PluginEntity | null;
export function toPluginEntity<Raw>(raw: Raw): PluginEntity | null {
  if (isString(raw)) {
    const spec = raw.trim();
    return spec ? { package: spec } : null;
  }
  if (isList(raw)) {
    const spec = isString(raw[0]) ? raw[0].trim() : '';
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

export function fromPluginEntity(entity: JsonValue): string | JsonPluginEntity | null;
export function fromPluginEntity<Entity>(entity: Entity): string | PluginEntity | null;
export function fromPluginEntity<Entity>(entity: Entity): string | PluginEntity | null {
  const normalized = toPluginEntity(entity);
  if (!normalized) return null;
  return normalized.options ? { package: normalized.package, options: normalized.options } : normalized.package;
}

export function readPluginList(config: JsonValue): PluginListItem<JsonPluginEntity>[];
export function readPluginList<Config>(config: Config): PluginListItem<PluginEntity>[];
export function readPluginList<Config>(config: Config) {
  const legacyValue = readConfigField(config, PLUGIN_SECTION.v1);
  const nativeValue = readConfigField(config, PLUGIN_SECTION.v2);
  const legacy = isList(legacyValue) ? legacyValue : [];
  const native = isList(nativeValue) ? nativeValue : [];
  return [
    ...legacy.map((raw) => ({ entry: toPluginEntity(raw), key: PLUGIN_SECTION.v1, legacy: true })),
    ...native.map((raw) => ({ entry: toPluginEntity(raw), key: PLUGIN_SECTION.v2, legacy: false })),
  ].filter((item): item is PluginListItem<PluginEntity> => item.entry !== null);
}
export function parseWebSearchSelection<Value>(value: Value): WebSearchSelection | undefined {
  if (value === null) return null;
  if (value === false) return false;
  if (!isString(value)) return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export function writeWebSearchSelection(config: ReadableConfig, selection: WebSearchSelection) {
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
function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null;
}

export function writeWarmingEnabled(config: ReadableConfig, enabled: boolean) {
  const before = JSON.stringify(config.warming);
  if (!enabled) {
    delete config.warming;
  } else if (!isObject(config.warming)) {
    config.warming = true;
  }
  return JSON.stringify(config.warming) !== before;
}

export function writeWarmingDuration(config: ReadableConfig, minutes: number) {
  if (!config.warming) return false;
  const before = JSON.stringify(config.warming);
  const tuned = { ...recordOrEmpty(config.warming) };
  delete tuned.duration;
  if (minutes !== 30) tuned.duration = `${minutes} minutes`;
  config.warming = Object.keys(tuned).length > 0 ? tuned : true;
  return JSON.stringify(config.warming) !== before;
}
const tokenCount = z.number().int().min(0).max(10_000_000);
const compactionTokens = tokenCount.nullable().optional();
const compactionPercent = z.string().regex(/^([1-9]\d?(\.\d+)?)%$/u);

export const compactionUpdateSchema = z.object({
  auto: z.boolean().optional(),
  buffer: z.union([compactionPercent, tokenCount]).nullable().optional(),
  keepTokens: compactionTokens,
  background: z.boolean().optional(),
}).strict();

const setOrDelete = <Key extends string, Value>(owner: { [Field in Key]?: Value }, key: Key, value: Value | null) => {
  if (value === null) delete owner[key];
  else owner[key] = value;
};

const nestedRecord = <Owner, Key extends PropertyKey>(owner: Owner, key: Key) => {
  const value = readConfigField(owner, key);
  return isRecord(value) ? { ...value } : {};
};

const assignOrDrop = <Key extends string, Fields extends object>(owner: { [Field in Key]?: ConfigField }, key: Key, record: Fields) => {
  if (Object.keys(record).length > 0) owner[key] = record;
  else delete owner[key];
};

export function writeCompactionSettings(config: ReadableConfig, update: CompactionUpdate) {
  const before = JSON.stringify([config.compaction, config.experimental]);
  if (update.auto !== undefined || update.buffer !== undefined || update.keepTokens !== undefined || update.background !== undefined) {
    const compaction = nestedRecord(config, 'compaction');
    if (update.auto !== undefined) compaction.auto = update.auto;
    if (update.background !== undefined) compaction.background = update.background;
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

export function writeMcpSkillsEnabled(config: ReadableConfig, enabled: boolean) {
  const experimental = nestedRecord(config, 'experimental');
  if (experimental.mcp_skills === enabled) return false;
  experimental.mcp_skills = enabled;
  config.experimental = experimental;
  return true;
}

export function findWebSearchProjectOverride<Config>(layers: WebSearchConfigLayers, projectFiles: ReadonlyArray<{ path: string; config: Config }>) {
  const userPath = layers?.paths?.userPath ?? null;
  const winner = (projectFiles ?? [])
    .find((file) => file?.path && file.path !== userPath && isRecord(file.config) && Object.hasOwn(file.config, 'websearch'));
  return winner && winner.path !== layers?.paths?.customPath ? winner.path : null;
}
export const skillSwitchRequestSchema = z.object({
  id: z.string().min(1).max(200).refine((id) => id.trim() === id && !/[*?/\\\n\r]/.test(id)),
  enabled: z.boolean(),
  scope: z.enum(['user', 'project']),
});

const isSkillDeny = <Statement>(statement: Statement, id: string) => isRecord(statement)
  && statement.effect === 'deny'
  && ((statement.action === 'skill.use' && statement.resource === id)
    || (statement.action === 'integration.use' && statement.resource === `skill:${id}`));

const isSkillAllow = <Statement>(statement: Statement, id: string) => isRecord(statement)
  && statement.effect === 'allow'
  && ((statement.action === 'skill.use' && statement.resource === id)
    || (statement.action === 'integration.use' && statement.resource === `skill:${id}`));

const endsWithSkillDeny = (statements: readonly unknown[], id: string) => {
  for (let index = statements.length - 1; index >= 0; index -= 1) {
    if (isSkillDeny(statements[index], id)) return true;
    if (isSkillAllow(statements[index], id)) return false;
  }
  return false;
};

export function writeSkillDisabled(config: ReadableConfig | OpenCodeConfigLayer, id: string, disabled: boolean) {
  const lists = [{ owner: config, key: 'policies' } as const];
  const experimental = config.experimental;
  if (isRecord(experimental)) lists.push({ owner: experimental, key: 'policies' });
  const populated = lists.filter(({ owner, key }) => isList(owner[key]));

  if (disabled) {
    const statements = [...populated].reverse().flatMap(({ owner, key }) => owner[key]);
    if (endsWithSkillDeny(statements, id)) return false;
    const policies = Array.isArray(config.policies) ? config.policies : [];
    config.policies = [...policies, { action: 'skill.use', resource: id, effect: 'deny' }];
    return true;
  }

  let changed = false;
  for (const { owner, key } of populated) {
    const statements = owner[key];
    if (!isList(statements)) continue;
    const kept = statements.filter((statement) => !isSkillDeny(statement, id));
    if (kept.length === statements.length) continue;
    changed = true;
    if (kept.length > 0) owner[key] = kept;
    else delete owner[key];
  }
  if (changed && isRecord(config.experimental) && Object.keys(config.experimental).length === 0) {
    delete config.experimental;
  }
  return changed;
}

export { isRecord };
