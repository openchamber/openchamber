import type { z } from 'zod';

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

export interface AgentEntity {
  system?: string;
  description?: string;
  model?: string;
  mode?: 'primary' | 'subagent' | 'all';
  hidden?: boolean;
  color?: string;
  steps?: number;
  disabled?: boolean;
  request?: { headers?: Record<string, string>; body?: Record<string, unknown> };
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

export interface McpOAuth {
  client_id?: string;
  client_secret?: string;
  scope?: string;
  callback_port?: number;
  redirect_uri?: string;
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
}

export interface ModelCompatibility {
  reasoningField?: string;
  requireReasoning?: boolean;
  maxTokensField?: 'max_completion_tokens' | 'max_tokens';
  requireFinishReason?: boolean;
  requireAssistantAfterTool?: boolean;
  supportsPromptCacheKey?: boolean;
}

export interface ProviderModelEntity {
  modelID?: string;
  name?: string;
  type?: string;
  family?: string;
  compatibility?: ModelCompatibility;
  package?: string;
  settings?: Record<string, unknown>;
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
  capabilities?: { tools: boolean; input: string[]; output: string[] };
  variants?: Array<{ id: string; settings?: Record<string, unknown> }>;
  cost?: unknown;
  limit?: Record<string, number>;
  disabled?: boolean;
}

export interface ProviderEntity {
  canonical?: string;
  name?: string;
  package?: string;
  env?: string[];
  settings?: Record<string, unknown>;
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
  models?: Record<string, ProviderModelEntity>;
}

export interface PluginEntity {
  package: string;
  options?: Record<string, unknown>;
}

export type SectionKind = 'agents' | 'commands' | 'providers';

export interface SectionLookup {
  value: unknown;
  key: string | null;
  legacy: boolean;
}

export const PLUGIN_SECTION: { v2: string; v1: string };

export function isRecord(value: unknown): value is Record<string, unknown>;
export function readSectionEntry(config: unknown, kind: SectionKind, name: string): SectionLookup;
export function writeSectionEntry(
  config: Record<string, unknown>,
  kind: SectionKind,
  name: string,
  value: unknown,
): string;
export function deleteSectionEntry(config: Record<string, unknown>, kind: SectionKind, name: string): boolean;

export function normalizePermissionAction(action: string): string;
export function permissionMapToRules(value: unknown): PermissionRule[];
export function normalizePermissionRules(value: unknown): PermissionRule[];
export function effectiveAgentRules(globalRules: unknown, agentRules: unknown): EffectivePermissionRule[];
export function readGlobalPermissionRules(config: unknown): PermissionRule[];

export function parseModelSelection(model: unknown, variant?: unknown): ModelSelection | null;
export function formatModelSelection(selection: unknown): string | null;

export function toAgentEntity(raw: unknown, body?: string): AgentEntity;
/**
 * What a markdown agent's YAML frontmatter carries: the native v2 agent keys
 * minus `system` (which is the body). Declared as a dictionary as well, because
 * this is a serialization payload handed straight to the YAML writer.
 */
export type AgentFrontmatter = Record<string, unknown> & Omit<AgentEntity, 'system'>;

export function fromAgentEntity(entity: unknown): { fields: AgentFrontmatter; system: string };
export function isLegacyAgentFrontmatter(frontmatter: unknown): boolean;

export function toCommandEntity(raw: unknown, body?: string): CommandEntity;
/** Frontmatter payload for a markdown command: native v2 keys minus `template`. */
export type CommandFrontmatter = Record<string, unknown> & Omit<CommandEntity, 'template'>;

export function fromCommandEntity(entity: unknown): { fields: CommandFrontmatter; template: string };
export function isLegacyCommandFrontmatter(frontmatter: unknown): boolean;

export function toMcpEntity(raw: unknown): McpEntity;
export function readMcpEntry(config: unknown, name: string): SectionLookup;
export function readMcpEntries(config: unknown): Map<string, SectionLookup>;
export function readLayeredMcpEntries(configs: unknown[]): Map<string, SectionLookup>;
export function writeMcpEntry(config: Record<string, unknown>, name: string, value: unknown): string;
export function deleteMcpEntry(config: Record<string, unknown>, name: string): boolean;

export function toProviderPackage(value: unknown): string | undefined;
export function toNpmPackage(value: unknown): string | undefined;
export function toProviderEntity(raw: unknown): ProviderEntity;
export function readStoredProviderEntry(configs: unknown[], providerId: string): ProviderEntity | null;

export function toPluginEntity(raw: unknown): PluginEntity | null;
export function fromPluginEntity(entity: unknown): string | PluginEntity | null;
export function readPluginList(config: unknown): Array<{ entry: PluginEntity; key: string; legacy: boolean }>;

/** `false` (off), a provider id or `"random"`, or `null` (remove the key). */
export type WebSearchSelection = false | string | null;
export function parseWebSearchSelection(value: unknown): WebSearchSelection | undefined;
export function writeWebSearchSelection(config: Record<string, unknown>, selection: WebSearchSelection): boolean;
export function writeWarmingEnabled(config: Record<string, unknown>, enabled: boolean): boolean;
/** OpenCode's `warming` key: on with defaults, or tuned. */
export interface OpenCodeWarmingConfig {
  warming?: boolean | { prompt?: string; interval?: string; duration?: string };
}
export function writeWarmingDuration(config: OpenCodeWarmingConfig, minutes: number): boolean;
/** A compaction settings update: a token count, `null` for OpenCode's default, or omitted to leave it. */
export const compactionUpdateSchema: z.ZodObject<{
  auto: z.ZodOptional<z.ZodBoolean>;
  buffer: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
  keepTokens: z.ZodOptional<z.ZodNullable<z.ZodNumber>>;
  background: z.ZodOptional<z.ZodBoolean>;
}>;
export type CompactionUpdate = z.infer<typeof compactionUpdateSchema>;
/** The keys of an OpenCode config file a compaction update edits. */
export interface OpenCodeCompactionConfig {
  compaction?: { auto?: boolean; buffer?: number; keep?: { tokens?: number } };
  experimental?: { background_compaction?: boolean };
}
export function writeCompactionSettings(config: OpenCodeCompactionConfig, update: CompactionUpdate): boolean;
/** A skill switch request: an OpenCode skill id (no wildcards, no path separators), on or off, and the skill's scope. */
export const skillSwitchRequestSchema: z.ZodObject<{
  id: z.ZodString;
  enabled: z.ZodBoolean;
  scope: z.ZodEnum<{ user: 'user'; project: 'project' }>;
}>;
/** One OpenCode policy statement as a config file holds it. */
export interface OpenCodePolicyStatement {
  action?: string;
  resource?: string;
  effect?: string;
}
/** The keys of an OpenCode config file a skill switch edits. */
export interface OpenCodePolicyConfig {
  policies?: OpenCodePolicyStatement[];
  experimental?: { policies?: OpenCodePolicyStatement[] };
}
/** Adds (`disabled`) or removes the exact `skill:<id>` deny in one config object; returns whether it changed. */
export function writeSkillDisabled(config: OpenCodePolicyConfig, id: string, disabled: boolean): boolean;
export interface WebSearchConfigLayers {
  userConfig: object | null;
  projectConfig: object | null;
  customConfig: object | null;
  paths: { userPath: string | null; projectPath: string | null; customPath?: string | null };
}
export function findWebSearchProjectOverride(
  layers: WebSearchConfigLayers,
  projectFiles: ReadonlyArray<{ path: string; config: object | null }>,
): string | null;
