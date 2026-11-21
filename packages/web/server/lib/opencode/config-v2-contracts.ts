import type { JsonObject } from '../shared/json-values.js';

export type PermissionEffect = 'allow' | 'deny' | 'ask';

export interface PermissionRule {
  action: string;
  resource: string;
  effect: PermissionEffect;
}
export interface EffectivePermissionRule extends PermissionRule {
  source: 'global' | 'agent';
}
export interface ModelSelection {
  providerID: string;
  modelID: string;
  variant?: string;
}
export type AgentMode = 'primary' | 'subagent' | 'all';
export interface AgentRequest {
  headers?: Record<string, ConfigField>;
  body?: Record<string, ConfigField>;
}
export interface AgentEntity {
  system?: string;
  description?: string;
  model?: string;
  mode?: AgentMode;
  hidden?: boolean;
  color?: string;
  steps?: number;
  disabled?: boolean;
  request?: AgentRequest;
  permissions?: PermissionRule[];
}
export interface CommandEntity {
  template?: string;
  description?: string;
  agent?: string;
  model?: string;
  subagent?: boolean;
}
export interface McpTimeout {
  startup?: number;
  catalog?: number;
  execution?: number;
}
export type McpProtocol = 'legacy' | 'auto' | '2026-07-28';
export interface McpOAuth {
  client_id?: string;
  client_secret?: string;
  scope?: string;
  callback_port?: number;
  redirect_uri?: string;
  auth_server_metadata_url?: string;
}
export interface McpEntity {
  type: 'local' | 'remote';
  command?: string[];
  cwd?: string;
  environment?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  oauth?: McpOAuth | false;
  disabled?: boolean;
  codemode?: boolean;
  timeout?: McpTimeout;
  protocol?: McpProtocol;
}
export interface ModelVariant {
  id?: string;
  settings?: Record<string, ConfigField>;
  headers?: Record<string, string>;
  body?: Record<string, ConfigField>;
}
export interface ModelCapabilities { tools?: boolean; input?: string[]; output?: string[] }
interface ModelCost {
  tier?: Record<string, ConfigField>;
  input?: number;
  output?: number;
  cache?: { read?: ConfigField; write?: ConfigField };
}
export interface ProviderModelEntity {
  modelID?: string;
  name?: string;
  type?: string;
  family?: string;
  compatibility?: Record<string, ConfigField>;
  package?: string;
  settings?: Record<string, ConfigField>;
  headers?: Record<string, string>;
  body?: Record<string, ConfigField>;
  capabilities?: ModelCapabilities;
  variants?: ModelVariant[];
  cost?: readonly ConfigField[] | ModelCost;
  limit?: Record<string, ConfigField>;
  disabled?: boolean;
}
export interface ProviderEntity {
  canonical?: string;
  name?: string;
  package?: string;
  env?: string[];
  settings?: Record<string, ConfigField>;
  headers?: Record<string, string>;
  body?: Record<string, ConfigField>;
  models?: Record<string, ProviderModelEntity>;
}
export interface PluginEntity {
  package: string;
  options?: Record<string, ConfigField>;
}
export type JsonPluginEntity = { package: string; options?: JsonObject };
export interface PluginListItem<Entry> { entry: Entry; key: string; legacy: boolean }
export interface SectionLookup {
  value: unknown;
  key: string | null;
  legacy: boolean;
}
export type WebSearchSelection = false | string | null;
export interface WebSearchConfigLayers {
  paths: { userPath: string | null; customPath?: string | null };
}

export type ConfigField = SectionLookup['value'];
export interface ReadableConfig {
  agents?: unknown;
  agent?: unknown;
  commands?: unknown;
  command?: unknown;
  providers?: unknown;
  provider?: unknown;
  mcp?: unknown;
  policies?: unknown;
  experimental?: unknown;
  warming?: unknown;
  websearch?: unknown;
  compaction?: unknown;
}
export type DefinedFields<Fields> = {
  [Key in keyof Fields as null extends Fields[Key] ? never : undefined extends Fields[Key] ? never : Key]: Fields[Key];
} & {
  [Key in keyof Fields as null extends Fields[Key] ? Key : undefined extends Fields[Key] ? Key : never]?: NonNullable<Fields[Key]>;
};
