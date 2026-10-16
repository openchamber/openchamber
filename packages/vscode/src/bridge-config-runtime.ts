import { z } from 'zod';
import { OPENCODE_CONFIG_DIR } from './opencodeConfigPaths';
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import {
  createAgent,
  createCommand,
  createSnippet,
  deleteAgent,
  deleteCommand,
  deleteSnippet,
  getAgentSources,
  getAgentConfig,
  getAgentPermissions,
  listDisabledAgents,
  getCommandSources,
  getCommandConfig,
  getSnippet,
  updateAgent,
  updateCommand,
  updateSnippet,
  type AgentScope,
  type CommandScope,
  AGENT_SCOPE,
  COMMAND_SCOPE,
  discoverSkills,
  mergeDiscoveredSkills,
  getSkillSources,
  createSkill,
  updateSkill,
  deleteSkill,
  deleteSkillAt,
  isDeletableSkillPath,
  renameSkill,
  isManagedSkillPath,
  readSkillSupportingFile,
  writeSkillSupportingFile,
  deleteSkillSupportingFile,
  type SkillScope,
  type DiscoveredSkill,
  SKILL_SCOPE,
  listMcpConfigs,
  listPluginDirFiles,
  listPluginEntries,
  getPluginEntry,
  createPluginEntry,
  updatePluginEntry,
  deletePluginEntry,
  readPluginDirFile,
  writePluginDirFile,
  deletePluginDirFile,
  queryPluginRegistry,
  listSnippets,
  getMcpConfig,
  createMcpConfig,
  updateMcpConfig,
  deleteMcpConfig,
  expandSnippets,
  setWebSearchSelection,
  setWarmingEnabled,
  getWebSearchSource,
  skillPolicyService,
  type SnippetScope,
} from './opencodeConfig';
import {
  handleSkillPolicyWrite,
  renameSkillKeepingSwitches,
  skillIdFromPath,
  type SkillPolicyOpenCodeReader,
} from '../../web/server/lib/opencode/skill-policy.js';
import { isSkillFolderName, readSkillIdSelector, selectSkillById } from '../../web/server/lib/opencode/skill-identity.js';
import { parseWebSearchSelection } from './opencode-config-v2';
import {
  getSkillsCatalog,
  scanSkillsRepository as scanSkillsRepositoryFromGit,
  installSkillsFromRepository as installSkillsFromGit,
  type SkillsCatalogSourceConfig,
} from './skillsCatalog';
import { buildAppliedResponse } from './config-mutation-response';
import type { BridgeContext, BridgeResponse } from './bridge';
import { appendInstalledSources, removeInstalledSources } from '../../web/server/lib/skills-catalog/installed-sources.js';

type BridgeMessageInput = {
  id: string;
  type: string;
  payload?: unknown;
};

type ConfigRuntimeDeps = {
  readSettings: (ctx?: BridgeContext) => Record<string, unknown>;
  persistSettings: (changes: Record<string, unknown>, ctx?: BridgeContext) => Promise<Record<string, unknown>>;
  readMagicPromptOverrides: () => { version: number; overrides: Record<string, string> };
  saveMagicPromptOverride: (id: string, text: string) => Promise<{ version: number; overrides: Record<string, string> }>;
  resetMagicPromptOverride: (id: string) => Promise<{ version: number; overrides: Record<string, string> }>;
  resetAllMagicPromptOverrides: () => Promise<{ version: number; overrides: Record<string, string> }>;
  fetchOpenCodeSkillsFromApi: (ctx: BridgeContext | undefined, workingDirectory?: string) => Promise<DiscoveredSkill[] | null>;
  createOpenCodePolicyReader: (ctx: BridgeContext | undefined) => SkillPolicyOpenCodeReader;
  clientReloadDelayMs: number;
};

const skillPolicyPayloadSchema = z.object({ body: z.json().optional(), directory: z.string().optional() });
const projectScopeSchema = z.object({ scope: z.literal('project') });
// The web route's `?scope=&source=` delete location.
const skillLocationSchema = z.object({
  scope: z.enum(['user', 'project']),
  source: z.enum(['opencode', 'claude', 'agents']),
});

/** A directory the webview names for a skill switch: it must exist and be a directory. */
const resolveSkillPolicyDirectory = (raw: string | undefined) => {
  const trimmed = raw?.trim();
  if (!trimmed) return { directory: null, error: null };
  try {
    const resolved = fs.realpathSync(path.resolve(trimmed));
    return fs.statSync(resolved).isDirectory()
      ? { directory: resolved, error: null }
      : { directory: null, error: 'Specified path is not a directory' };
  } catch {
    return { directory: null, error: 'Directory not found' };
  }
};

const skillIdsOf = (skills: DiscoveredSkill[]) => skills.flatMap((skill) => (skill.id ? [skill.id] : []));

const AGENTS_MD_PATH = path.join(OPENCODE_CONFIG_DIR, 'AGENTS.md');
const MAX_BEHAVIOR_PROMPT_SIZE = 1024 * 1024;

const resolveWorkingDirectory = (ctx: BridgeContext | undefined, directory?: string): string | undefined => (
  (typeof directory === 'string' && directory.trim())
    ? directory.trim()
    : (ctx?.manager?.getWorkingDirectory() || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath)
);

const pluginMutationPayload = (label: string) => buildAppliedResponse(
  `${label}.`,
);

const parseSkillsCatalogSources = (settings: Record<string, unknown>): SkillsCatalogSourceConfig[] => {
  const rawCatalogs = (settings as { skillCatalogs?: unknown }).skillCatalogs;
  if (!Array.isArray(rawCatalogs)) {
    return [];
  }

  return rawCatalogs
    .map((entry) => {
      if (!entry || typeof entry !== 'object') return null;
      const candidate = entry as Record<string, unknown>;
      const id = typeof candidate.id === 'string' ? candidate.id.trim() : '';
      const label = typeof candidate.label === 'string' ? candidate.label.trim() : '';
      const source = typeof candidate.source === 'string' ? candidate.source.trim() : '';
      const subpath = typeof candidate.subpath === 'string' ? candidate.subpath.trim() : '';
      if (!id || !label || !source) return null;
      const normalized: SkillsCatalogSourceConfig = {
        id,
        label,
        description: source,
        source,
        ...(subpath ? { defaultSubpath: subpath } : {}),
      };
      return normalized;
    })
    .filter((value): value is SkillsCatalogSourceConfig => value !== null);
};

const resolveDiscoveredSkills = async (
  deps: ConfigRuntimeDeps,
  ctx: BridgeContext | undefined,
  workingDirectory?: string,
): Promise<DiscoveredSkill[]> => mergeDiscoveredSkills(
  (await deps.fetchOpenCodeSkillsFromApi(ctx, workingDirectory)) || [],
  discoverSkills(workingDirectory),
);

/**
 * Mirror of the web routes' `?id=` selector (`resolveSelectedSkill` in
 * `skill-routes.js`): with an id, exactly that listed skill or an error, never
 * another skill with the same display name; without one, `skill` is null and
 * the caller keeps its display-name lookup.
 */
const resolveSelectedSkill = async (
  deps: ConfigRuntimeDeps,
  ctx: BridgeContext | undefined,
  workingDirectory: string | undefined,
  skillName: string,
  rawSkillId: string | undefined,
) => {
  const { id: skillId, error } = readSkillIdSelector(rawSkillId);
  if (error) return { skill: null, skillId: null, error };
  if (!skillId) return { skill: null, skillId: null, error: null };
  const skill = selectSkillById(await resolveDiscoveredSkills(deps, ctx, workingDirectory), skillId, skillName);
  return skill ? { skill, skillId, error: null } : { skill: null, skillId: null, error: 'Skill not found' };
};

const isEditableSkillFile = (skillPath: string): boolean => path.basename(skillPath) === 'SKILL.md' && fs.existsSync(skillPath);

/** Mirror of the web route's check: a listed skill file or a `SKILL.md` under a managed skill root. */
const isKnownSkillFile = async (
  deps: ConfigRuntimeDeps,
  ctx: BridgeContext | undefined,
  workingDirectory: string | undefined,
  targetPath: string,
): Promise<boolean> => {
  if (path.basename(targetPath) !== 'SKILL.md') return false;
  const listed = (await resolveDiscoveredSkills(deps, ctx, workingDirectory))
    .some((skill) => path.resolve(skill.path) === targetPath);
  return listed || isManagedSkillPath(targetPath, workingDirectory);
};

export async function handleConfigBridgeMessage(
  message: BridgeMessageInput,
  ctx: BridgeContext | undefined,
  deps: ConfigRuntimeDeps,
): Promise<BridgeResponse | null> {
  const { id, type, payload } = message;

  switch (type) {
    case 'api:config/opencode-resolution:get': {
      const debugInfo = ctx?.manager?.getDebugInfo();
      const configuredFromWorkspace = vscode.workspace.getConfiguration('openchamber').get<string>('opencodeBinary');
      const configured = typeof configuredFromWorkspace === 'string' && configuredFromWorkspace.trim().length > 0
        ? configuredFromWorkspace.trim()
        : null;
      const resolved = debugInfo?.cliPath ?? null;
      const source = (() => {
        if (!resolved) return null;
        if (configured && configured === resolved) return 'settings';
        const envBinary = typeof process.env.OPENCODE_BINARY === 'string' ? process.env.OPENCODE_BINARY.trim() : '';
        if (envBinary && envBinary === resolved) return 'env';
        return 'path';
      })();

      return {
        id,
        type,
        success: true,
        data: {
          configured,
          resolved,
          resolvedDir: resolved ? path.dirname(resolved) : null,
          source,
          detectedNow: resolved,
          detectedSourceNow: source,
          shim: null,
          viaWsl: false,
          wslBinary: null,
          wslPath: null,
          wslDistro: null,
          node: process.execPath || null,
          bun: null,
        },
      };
    }

    case 'api:config/settings:get': {
      const settings = deps.readSettings(ctx);
      return { id, type, success: true, data: settings };
    }

    case 'api:config/settings:save': {
      const changes = (payload as Record<string, unknown>) || {};
      const updated = await deps.persistSettings(changes, ctx);
      return { id, type, success: true, data: updated };
    }

    case 'api:behavior/agents-md:get': {
      try {
        const content = await fs.promises.readFile(AGENTS_MD_PATH, 'utf8');
        return { id, type, success: true, data: { content, exists: true, path: AGENTS_MD_PATH } };
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
          return { id, type, success: true, data: { content: '', exists: false, path: AGENTS_MD_PATH } };
        }
        throw error;
      }
    }

    case 'api:behavior/agents-md:save': {
      const request = (payload || {}) as { content?: unknown };
      const content = typeof request.content === 'string' ? request.content : '';
      if (content.length > MAX_BEHAVIOR_PROMPT_SIZE) {
        return { id, type, success: false, error: `Content exceeds maximum size of ${MAX_BEHAVIOR_PROMPT_SIZE} bytes` };
      }
      await fs.promises.mkdir(path.dirname(AGENTS_MD_PATH), { recursive: true });
      await fs.promises.writeFile(AGENTS_MD_PATH, content, 'utf8');
      return {
        id,
        type,
        success: true,
        data: buildAppliedResponse('AGENTS.md saved.'),
      };
    }

    case 'api:magic-prompts:get': {
      return { id, type, success: true, data: deps.readMagicPromptOverrides() };
    }

    case 'api:magic-prompts:save': {
      const request = (payload || {}) as { id?: string; text?: string };
      const promptId = typeof request.id === 'string' ? request.id : '';
      if (!promptId) {
        return { id, type, success: false, error: 'Prompt id is required' };
      }
      if (typeof request.text !== 'string') {
        return { id, type, success: false, error: 'Prompt text is required' };
      }
      const data = await deps.saveMagicPromptOverride(promptId, request.text);
      return { id, type, success: true, data };
    }

    case 'api:magic-prompts:reset': {
      const request = (payload || {}) as { id?: string };
      const promptId = typeof request.id === 'string' ? request.id : '';
      if (!promptId) {
        return { id, type, success: false, error: 'Prompt id is required' };
      }
      const data = await deps.resetMagicPromptOverride(promptId);
      return { id, type, success: true, data };
    }

    case 'api:magic-prompts:reset-all': {
      const data = await deps.resetAllMagicPromptOverrides();
      return { id, type, success: true, data };
    }

    case 'api:config/reload': {
      await ctx?.manager?.restart();
      return { id, type, success: true, data: { restarted: true } };
    }

    case 'api:config/disabled-agents': {
      const { directory } = (payload || {}) as { directory?: string };
      return { id, type, success: true, data: { agents: listDisabledAgents(resolveWorkingDirectory(ctx, directory)) } };
    }

    case 'api:config/agents': {
      const { method, name, body, directory, resource } = (payload || {}) as {
        method?: string;
        name?: string;
        body?: Record<string, unknown>;
        directory?: string;
        /** `config` or `permissions`, mirroring the web sub-routes. */
        resource?: string;
      };
      const agentName = typeof name === 'string' ? name.trim() : '';
      if (!agentName) {
        return { id, type, success: false, error: 'Agent name is required' };
      }

      const workingDirectory = resolveWorkingDirectory(ctx, directory);
      const normalizedMethod = typeof method === 'string' && method.trim() ? method.trim().toUpperCase() : 'GET';

      if (normalizedMethod === 'GET') {
        // Mirrors the web routes: `/config` answers the canonical v2 entity and
        // `/permissions` the effective rule list.
        if (resource === 'config') {
          return { id, type, success: true, data: getAgentConfig(agentName, workingDirectory) };
        }
        if (resource === 'permissions') {
          return { id, type, success: true, data: getAgentPermissions(agentName, workingDirectory) };
        }
        const sources = getAgentSources(agentName, workingDirectory);
        const scope = sources.md.exists
          ? sources.md.scope
          : (sources.json.exists ? sources.json.scope : null);
        return {
          id,
          type,
          success: true,
          data: { name: agentName, sources, scope, isBuiltIn: !sources.md.exists && !sources.json.exists },
        };
      }

      if (normalizedMethod === 'POST') {
        const scopeValue = body?.scope as string | undefined;
        const scope: AgentScope | undefined = scopeValue === 'project' ? AGENT_SCOPE.PROJECT : scopeValue === 'user' ? AGENT_SCOPE.USER : undefined;
        const created = createAgent(agentName, (body || {}) as Record<string, unknown>, workingDirectory, scope);
        return {
          id,
          type,
          success: true,
          data: buildAppliedResponse(`Agent ${agentName} created successfully.`, created),
        };
      }

      if (normalizedMethod === 'PATCH') {
        const updated = updateAgent(agentName, (body || {}) as Record<string, unknown>, workingDirectory);
        return {
          id,
          type,
          success: true,
          data: buildAppliedResponse(`Agent ${agentName} updated successfully.`, updated),
        };
      }

      if (normalizedMethod === 'DELETE') {
        const scopeValue = body?.scope as string | undefined;
        const scope: AgentScope | undefined = scopeValue === 'project' ? AGENT_SCOPE.PROJECT : scopeValue === 'user' ? AGENT_SCOPE.USER : undefined;
        deleteAgent(agentName, workingDirectory, scope);
        return {
          id,
          type,
          success: true,
          data: buildAppliedResponse(`Agent ${agentName} deleted successfully.`),
        };
      }

      return { id, type, success: false, error: `Unsupported method: ${normalizedMethod}` };
    }

    case 'api:config/commands': {
      const { method, name, body, directory, resource } = (payload || {}) as {
        method?: string;
        name?: string;
        body?: Record<string, unknown>;
        directory?: string;
        /** `config`, mirroring the web sub-route. */
        resource?: string;
      };
      const commandName = typeof name === 'string' ? name.trim() : '';
      if (!commandName) {
        return { id, type, success: false, error: 'Command name is required' };
      }

      const workingDirectory = resolveWorkingDirectory(ctx, directory);
      const normalizedMethod = typeof method === 'string' && method.trim() ? method.trim().toUpperCase() : 'GET';

      if (normalizedMethod === 'GET') {
        if (resource === 'config') {
          return { id, type, success: true, data: getCommandConfig(commandName, workingDirectory) };
        }
        const sources = getCommandSources(commandName, workingDirectory);
        const scope = sources.md.exists
          ? sources.md.scope
          : (sources.json.exists ? sources.json.scope : null);
        return {
          id,
          type,
          success: true,
          data: { name: commandName, sources, scope, isBuiltIn: !sources.md.exists && !sources.json.exists },
        };
      }

      if (normalizedMethod === 'POST') {
        const scopeValue = body?.scope as string | undefined;
        const scope: CommandScope | undefined = scopeValue === 'project' ? COMMAND_SCOPE.PROJECT : scopeValue === 'user' ? COMMAND_SCOPE.USER : undefined;
        createCommand(commandName, (body || {}) as Record<string, unknown>, workingDirectory, scope);
        return {
          id,
          type,
          success: true,
          data: buildAppliedResponse(`Command ${commandName} created successfully.`),
        };
      }

      if (normalizedMethod === 'PATCH') {
        updateCommand(commandName, (body || {}) as Record<string, unknown>, workingDirectory);
        return {
          id,
          type,
          success: true,
          data: buildAppliedResponse(`Command ${commandName} updated successfully.`),
        };
      }

      if (normalizedMethod === 'DELETE') {
        deleteCommand(commandName, workingDirectory);
        return {
          id,
          type,
          success: true,
          data: buildAppliedResponse(`Command ${commandName} deleted successfully.`),
        };
      }

      return { id, type, success: false, error: `Unsupported method: ${normalizedMethod}` };
    }

    // GET/PUT /api/config/websearch — see the web routes in
    // packages/web/server/lib/opencode/routes.js.
    case 'api:config/websearch': {
      // SAFETY: every field is checked before use: `method` against a literal,
      // `directory` by resolveWorkingDirectory, `selection` by parseWebSearchSelection.
      const body = (payload || {}) as { method?: string; directory?: string; selection?: unknown };
      if (body.method === 'GET') {
        return { id, type, success: true, data: getWebSearchSource(resolveWorkingDirectory(ctx, body.directory)) };
      }
      const selection = parseWebSearchSelection(body.selection);
      if (selection === undefined) {
        return { id, type, success: false, error: 'selection must be false, null, "random" or a provider id' };
      }
      const result = setWebSearchSelection(selection);
      return { id, type, success: true, data: { success: true, changed: result.changed } };
    }

    // PUT /api/config/warming — see the web route in
    // packages/web/server/lib/opencode/routes.js.
    case 'api:config/warming': {
      const enabled = (payload as { enabled?: unknown } | undefined)?.enabled;
      if (typeof enabled !== 'boolean') {
        return { id, type, success: false, error: 'enabled must be a boolean' };
      }
      const result = setWarmingEnabled(enabled);
      return { id, type, success: true, data: { success: true, changed: result.changed } };
    }

    case 'api:config/mcp': {
      const { method, name, body, directory } = (payload || {}) as {
        method?: string;
        name?: string;
        body?: Record<string, unknown>;
        directory?: string;
      };
      const normalizedMethod = typeof method === 'string' && method.trim() ? method.trim().toUpperCase() : 'GET';
      const mcpName = typeof name === 'string' ? name.trim() : '';
      const workingDirectory = resolveWorkingDirectory(ctx, directory);

      if (normalizedMethod === 'GET' && !mcpName) {
        const configs = listMcpConfigs(workingDirectory);
        return { id, type, success: true, data: configs };
      }

      if (!mcpName) {
        return { id, type, success: false, error: 'MCP server name is required' };
      }

      if (normalizedMethod === 'GET') {
        const config = getMcpConfig(mcpName, workingDirectory);
        if (!config) {
          return { id, type, success: false, error: `MCP server "${mcpName}" not found` };
        }
        return { id, type, success: true, data: config };
      }

      if (normalizedMethod === 'POST') {
        const scope = body?.scope as 'user' | 'project' | undefined;
        const created = createMcpConfig(mcpName, (body || {}) as Record<string, unknown>, workingDirectory, scope);
        return {
          id,
          type,
          success: true,
          data: buildAppliedResponse(`MCP server "${mcpName}" created.`, created),
        };
      }

      if (normalizedMethod === 'PATCH') {
        const updated = updateMcpConfig(mcpName, (body || {}) as Record<string, unknown>, workingDirectory);
        return {
          id,
          type,
          success: true,
          data: buildAppliedResponse(`MCP server "${mcpName}" updated.`, updated),
        };
      }

      if (normalizedMethod === 'DELETE') {
        const deleted = deleteMcpConfig(mcpName, workingDirectory);
        return {
          id,
          type,
          success: true,
          data: buildAppliedResponse(`MCP server "${mcpName}" deleted.`, deleted),
        };
      }

      return { id, type, success: false, error: `Unsupported method: ${normalizedMethod}` };
    }

    case 'api:config/plugins': {
      const { method, target, pluginId, body, directory, specs, refresh } = (payload || {}) as {
        method?: string;
        target?: 'list' | 'registry' | 'entry' | 'file';
        pluginId?: string;
        body?: Record<string, unknown>;
        directory?: string;
        specs?: string[];
        refresh?: boolean;
      };
      const normalizedMethod = typeof method === 'string' && method.trim() ? method.trim().toUpperCase() : 'GET';
      const workingDirectory = resolveWorkingDirectory(ctx, directory);

      if ((target === 'list' || !target) && normalizedMethod === 'GET') {
        return {
          id,
          type,
          success: true,
          data: {
            entries: listPluginEntries(workingDirectory),
            files: listPluginDirFiles(workingDirectory),
          },
        };
      }

      if (target === 'registry' && normalizedMethod === 'GET') {
        const data = await queryPluginRegistry(Array.isArray(specs) ? specs : [], {
          refresh: refresh === true,
          workingDirectory,
        });
        return { id, type, success: true, data };
      }

      if (target === 'entry') {
        if (normalizedMethod === 'GET') {
          if (!pluginId) return { id, type, success: false, error: 'Plugin entry id is required' };
          const entry = getPluginEntry(pluginId, workingDirectory);
          if (!entry) return { id, type, success: false, error: 'Plugin entry not found' };
          return { id, type, success: true, data: entry };
        }
        if (normalizedMethod === 'POST') {
          createPluginEntry(body || {}, workingDirectory);
        } else if (normalizedMethod === 'PATCH') {
          if (!pluginId) return { id, type, success: false, error: 'Plugin entry id is required' };
          updatePluginEntry(pluginId, body || {}, workingDirectory);
        } else if (normalizedMethod === 'DELETE') {
          if (!pluginId) return { id, type, success: false, error: 'Plugin entry id is required' };
          deletePluginEntry(pluginId, workingDirectory);
        } else {
          return { id, type, success: false, error: `Unsupported method: ${normalizedMethod}` };
        }
        return {
          id,
          type,
          success: true,
          data: pluginMutationPayload('Plugin entry changed'),
        };
      }

      if (target === 'file') {
        if (normalizedMethod === 'GET') {
          if (!pluginId) return { id, type, success: false, error: 'Plugin file id is required' };
          const file = readPluginDirFile(pluginId, workingDirectory);
          if (!file) return { id, type, success: false, error: 'Plugin file not found' };
          return { id, type, success: true, data: file };
        }
        if (normalizedMethod === 'POST') {
          writePluginDirFile(body || {}, workingDirectory);
        } else if (normalizedMethod === 'PUT') {
          if (!pluginId) return { id, type, success: false, error: 'Plugin file id is required' };
          const existing = readPluginDirFile(pluginId, workingDirectory);
          if (!existing) return { id, type, success: false, error: 'Plugin file not found' };
          writePluginDirFile({ fileName: existing.fileName, scope: existing.scope, content: body?.content }, workingDirectory, { overwrite: true });
        } else if (normalizedMethod === 'DELETE') {
          if (!pluginId) return { id, type, success: false, error: 'Plugin file id is required' };
          deletePluginDirFile(pluginId, workingDirectory);
        } else {
          return { id, type, success: false, error: `Unsupported method: ${normalizedMethod}` };
        }
        return {
          id,
          type,
          success: true,
          data: pluginMutationPayload('Plugin file changed'),
        };
      }

      return { id, type, success: false, error: 'Unsupported plugin config request' };
    }

    case 'api:config/snippets': {
      const { method, name, body, directory } = (payload || {}) as {
        method?: string;
        name?: string;
        body?: Record<string, unknown>;
        directory?: string;
      };
      const normalizedMethod = typeof method === 'string' && method.trim() ? method.trim().toUpperCase() : 'GET';
      const snippetName = typeof name === 'string' ? name.trim() : '';
      const workingDirectory = resolveWorkingDirectory(ctx, directory);

      if (normalizedMethod === 'GET' && !snippetName) {
        return { id, type, success: true, data: listSnippets(workingDirectory) };
      }

      if (normalizedMethod === 'POST' && !snippetName) {
        return { id, type, success: true, data: { text: expandSnippets(typeof body?.text === 'string' ? body.text : '', workingDirectory) } };
      }

      if (!snippetName) {
        return { id, type, success: false, error: 'Snippet name is required' };
      }

      if (normalizedMethod === 'GET') {
        const snippet = getSnippet(snippetName, workingDirectory);
        if (!snippet) return { id, type, success: false, error: `Snippet "${snippetName}" not found` };
        return { id, type, success: true, data: snippet };
      }

      if (normalizedMethod === 'POST') {
        const scope = body?.scope === 'project' ? 'project' : 'global';
        const snippet = createSnippet(snippetName, (body || {}) as Record<string, unknown>, workingDirectory, scope as SnippetScope);
        return { id, type, success: true, data: { success: true, snippet } };
      }

      if (normalizedMethod === 'PATCH') {
        const snippet = updateSnippet(snippetName, (body || {}) as Record<string, unknown>, workingDirectory);
        return { id, type, success: true, data: { success: true, snippet } };
      }

      if (normalizedMethod === 'DELETE') {
        deleteSnippet(snippetName, workingDirectory);
        return { id, type, success: true, data: { success: true } };
      }

      return { id, type, success: false, error: `Unsupported method: ${normalizedMethod}` };
    }

    case 'api:config/skills': {
      const { method, name, body, directory, skillId, scope, source } = (payload || {}) as {
        method?: string;
        name?: string;
        body?: Record<string, unknown>;
        directory?: string;
        skillId?: string;
        scope?: string;
        source?: string;
      };
      // The directory the webview names (the selected project), as the web
      // route reads it, else the host's working directory.
      const workingDirectory = resolveWorkingDirectory(ctx, directory);
      const normalizedMethod = typeof method === 'string' && method.trim() ? method.trim().toUpperCase() : 'GET';

      if (!name && normalizedMethod === 'GET') {
        // A failed OpenCode list is flagged so the store treats the disk scan as
        // partial instead of caching it as the complete list (#3921).
        const openCodeSkills = await deps.fetchOpenCodeSkillsFromApi(ctx, workingDirectory);
        const skills = mergeDiscoveredSkills(openCodeSkills || [], discoverSkills(workingDirectory));
        // Same `skillPolicy` the web route adds; a failure answers `{ error }`
        // and leaves the list intact.
        const skillPolicy = await skillPolicyService.readState({
          directory: workingDirectory ?? null,
          ids: skillIdsOf(skills),
          openCode: deps.createOpenCodePolicyReader(ctx),
        }).catch((error) => ({ error: error instanceof Error ? error.message : String(error) }));
        return {
          id,
          type,
          success: true,
          data: {
            skillPolicy,
            ...(openCodeSkills === null ? { openCodeSkillsUnavailable: true } : {}),
            skills: skills.map((skill) => ({
              ...skill,
              renamable: Boolean(
                skill.path
                && skill.path !== '<built-in>'
                && isManagedSkillPath(skill.path, workingDirectory)
              ),
            })),
          },
        };
      }

      const skillName = typeof name === 'string' ? name.trim() : '';
      if (!skillName) {
        return { id, type, success: false, error: 'Skill name is required' };
      }

      // Install provenance is keyed by the install folder name, the id. It
      // stays while the disk scan for this directory, the user skill roots
      // and this project, still finds a copy of the id. Other projects are
      // not scanned; the record has no project field.
      const forgetProvenanceOnceGone = (deletedId: string) => {
        if (discoverSkills(workingDirectory).some((skill) => skill.id === deletedId)) return;
        try {
          removeInstalledSources(deletedId);
        } catch (error) {
          console.error('Failed to forget skill install provenance:', error);
        }
      };

      // Mirror of the web route's located delete: `scope` and `source`
      // together narrow it to the folder there, named by the id or, without
      // one, by the display name. It never consults the merged list, so a copy
      // of the id OpenCode lists first elsewhere stays.
      if (normalizedMethod === 'DELETE' && (scope || source)) {
        const location = skillLocationSchema.safeParse({ scope, source });
        if (!location.success) {
          return { id, type, success: false, error: 'scope must be user or project and source opencode, claude or agents' };
        }
        const { id: locatedId, error: idError } = readSkillIdSelector(skillId);
        if (idError) {
          return { id, type, success: false, error: idError };
        }
        const folderName = locatedId ?? skillName;
        if (!isSkillFolderName(folderName)) {
          return { id, type, success: false, error: 'Invalid skill name' };
        }
        deleteSkill(folderName, workingDirectory, location.data);
        forgetProvenanceOnceGone(folderName);
        return {
          id,
          type,
          success: true,
          data: {
            ...buildAppliedResponse(`Skill ${skillName} deleted successfully.`),
            ...(locatedId ? { id: locatedId } : {}),
          },
        };
      }

      // The web routes' `?id=` selector, carried by the webview as `skillId`.
      const selected = await resolveSelectedSkill(deps, ctx, workingDirectory, skillName, skillId);
      if (selected.error) {
        return { id, type, success: false, error: selected.error };
      }

      if (normalizedMethod === 'GET') {
        const discoveredSkill = selected.skill ?? (await resolveDiscoveredSkills(deps, ctx, workingDirectory))
          .find((skill) => skill.name === skillName) ?? null;
        const sources = getSkillSources(skillName, workingDirectory, discoveredSkill, { id: selected.skillId });
        return {
          id,
          type,
          success: true,
          data: {
            name: skillName,
            id: selected.skillId ?? discoveredSkill?.id ?? skillIdFromPath(sources.md.path),
            path: sources.md.path ?? discoveredSkill?.path ?? null,
            sources,
            scope: sources.md.scope,
            source: sources.md.source,
          },
        };
      }

      if (normalizedMethod === 'POST') {
        const scopeValue = body?.scope as string | undefined;
        const sourceValue = body?.source as string | undefined;
        const scope: SkillScope | undefined = scopeValue === 'project' ? SKILL_SCOPE.PROJECT : scopeValue === 'user' ? SKILL_SCOPE.USER : undefined;
        const normalizedSource = sourceValue === 'agents' ? 'agents' : 'opencode';
        createSkill(skillName, { ...(body || {}), source: normalizedSource } as Record<string, unknown>, workingDirectory, scope);
        return {
          id,
          type,
          success: true,
          data: buildAppliedResponse(`Skill ${skillName} created successfully.`),
        };
      }

      if (normalizedMethod === 'PATCH') {
        if (selected.skill && !isEditableSkillFile(selected.skill.path)) {
          return { id, type, success: false, error: `Skill "${skillName}" has no SKILL.md file to edit` };
        }
        if (typeof body?.renameTo === 'string') {
          const newName = body.renameTo.trim();
          // Same as the web route: a skill a switch turned off stays off under
          // its new id. A rename stopped to keep the switch answers its reason.
          let renamed;
          try {
            renamed = await renameSkillKeepingSwitches({
              service: skillPolicyService,
              directory: workingDirectory ?? null,
              listSkillFiles: async (dir) => discoverSkills(dir ?? undefined, { allCopies: true }),
              rename: (beforeMove) => renameSkill(skillName, newName, workingDirectory, { skillPath: selected.skill?.path ?? null, beforeMove }),
            });
          } catch (error) {
            return { id, type, success: false, error: error instanceof Error ? error.message : String(error) };
          }
          const { newPath, switches } = renamed;
          await ctx?.manager?.restart();
          return {
            id,
            type,
            success: true,
            data: {
              success: true,
              name: newName,
              id: skillIdFromPath(newPath),
              path: newPath,
              switches,
              requiresReload: true,
              message: `Skill renamed to ${newName} successfully. Reloading interface…`,
              reloadDelayMs: deps.clientReloadDelayMs,
            },
          };
        }

        // Same target rules as the web route: with `skillId` only the selected
        // file, without it a listed or managed `SKILL.md`, never another path.
        const targetPathInput = z.string().trim().min(1).safeParse(body?.targetPath);
        const requestedTarget = targetPathInput.success ? path.resolve(targetPathInput.data) : null;
        let targetPath = requestedTarget;
        if (selected.skill) {
          if (requestedTarget && requestedTarget !== path.resolve(selected.skill.path)) {
            return { id, type, success: false, error: 'targetPath does not match the selected skill' };
          }
          targetPath = selected.skill.path;
        } else if (requestedTarget && !(await isKnownSkillFile(deps, ctx, workingDirectory, requestedTarget))) {
          return { id, type, success: false, error: 'targetPath is not a known skill file' };
        }
        const updatedPath = updateSkill(skillName, (body || {}) as Record<string, unknown>, workingDirectory, targetPath);
        return {
          id,
          type,
          success: true,
          data: {
            ...buildAppliedResponse(`Skill ${skillName} updated successfully.`),
            id: skillIdFromPath(updatedPath),
            path: updatedPath,
          },
        };
      }

      if (normalizedMethod === 'DELETE' && selected.skill && selected.skillId) {
        // Exactly the selected skill's folder, nested groups included, refused
        // outside a managed root with symlinks followed.
        if (!isDeletableSkillPath(selected.skill.path, workingDirectory)) {
          return { id, type, success: false, error: `Skill "${skillName}" is outside managed skill directories and cannot be deleted` };
        }
        deleteSkillAt(selected.skill.path, workingDirectory);
        const deletedId = selected.skillId;
        forgetProvenanceOnceGone(deletedId);
        return {
          id,
          type,
          success: true,
          data: {
            ...buildAppliedResponse(`Skill ${skillName} deleted successfully.`),
            id: deletedId,
            path: selected.skill.path,
          },
        };
      }

      if (normalizedMethod === 'DELETE') {
        if (!isSkillFolderName(skillName)) {
          return { id, type, success: false, error: 'Invalid skill name' };
        }
        deleteSkill(skillName, workingDirectory);
        try {
          removeInstalledSources(skillName);
        } catch (error) {
          // Provenance only refines the Installed badge; the skill is gone either way.
          console.error('Failed to forget skill install provenance:', error);
        }
        return {
          id,
          type,
          success: true,
          data: buildAppliedResponse(`Skill ${skillName} deleted successfully.`),
        };
      }

      return { id, type, success: false, error: `Unsupported method: ${normalizedMethod}` };
    }

    // PUT /api/config/skill-policy — see the web route in
    // `packages/web/server/lib/opencode/skill-routes.js`. Answers `{ status, body }`.
    case 'api:config/skill-policy': {
      const parsed = skillPolicyPayloadSchema.safeParse(payload ?? {});
      if (!parsed.success) {
        return { id, type, success: true, data: { status: 400, body: { ok: false, error: { code: 'invalid_request', message: 'Malformed skill policy request' } } } };
      }
      const explicit = resolveSkillPolicyDirectory(parsed.data.directory);
      if (explicit.error) {
        return { id, type, success: true, data: { status: 400, body: { ok: false, error: { code: 'invalid_directory', message: explicit.error } } } };
      }
      // The project scope needs the directory named; the global one falls back
      // to the working directory for reading OpenCode's effective state.
      const directory = explicit.directory
        ?? (projectScopeSchema.safeParse(parsed.data.body).success ? null : (resolveWorkingDirectory(ctx) ?? null));
      const data = await handleSkillPolicyWrite({
        service: skillPolicyService,
        body: parsed.data.body,
        directory,
        openCode: deps.createOpenCodePolicyReader(ctx),
        listInstalledSkillIds: async (target) => new Set(skillIdsOf(await resolveDiscoveredSkills(deps, ctx, target ?? undefined))),
      });
      return { id, type, success: true, data };
    }

    case 'api:config/skills:catalog': {
      const refresh = Boolean((payload as { refresh?: boolean } | undefined)?.refresh);
      const workingDirectory = ctx?.manager?.getWorkingDirectory() || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const settings = deps.readSettings(ctx);
      const additionalSources = parseSkillsCatalogSources(settings);
      const installedSkills = await resolveDiscoveredSkills(deps, ctx, workingDirectory);
      const data = await getSkillsCatalog(workingDirectory, refresh, additionalSources, installedSkills);
      return { id, type, success: true, data };
    }

    case 'api:config/skills:scan': {
      const body = (payload || {}) as { source?: string; subpath?: string; gitIdentityId?: string };
      const data = await scanSkillsRepositoryFromGit({
        source: String(body.source || ''),
        subpath: body.subpath,
      });
      return { id, type, success: true, data };
    }

    case 'api:config/skills:install': {
      const body = (payload || {}) as {
        source?: string;
        subpath?: string;
        sourceId?: string;
        scope?: 'user' | 'project';
        targetSource?: 'opencode' | 'agents';
        selections?: Array<{ skillDir: string }>;
        conflictPolicy?: 'prompt' | 'skipAll' | 'overwriteAll';
        conflictDecisions?: Record<string, 'skip' | 'overwrite'>;
      };

      const workingDirectory = ctx?.manager?.getWorkingDirectory() || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

      const data = await installSkillsFromGit({
        source: String(body.source || ''),
        subpath: body.subpath,
        scope: body.scope === 'project' ? 'project' : 'user',
        targetSource: body.targetSource === 'agents' ? 'agents' : 'opencode',
        workingDirectory: body.scope === 'project' ? workingDirectory : undefined,
        selections: Array.isArray(body.selections) ? body.selections : [],
        conflictPolicy: body.conflictPolicy,
        conflictDecisions: body.conflictDecisions,
      });

      if (data.ok) {
        const installed = data.installed || [];
        const skipped = data.skipped || [];
        const installedAny = installed.length > 0;
        const sourceId = z.string().trim().min(1).safeParse(body.sourceId).data;
        if (installedAny && sourceId) {
          try {
            appendInstalledSources(installed.map((entry) => ({ ...entry, sourceId, sourceRef: String(body.source || '') })));
          } catch (error) {
            // Provenance only refines the Installed badge; the install already succeeded.
            console.error('Failed to record skill install provenance:', error);
          }
        }

        return {
          id,
          type,
          success: true,
          data: {
            ok: true,
            installed,
            skipped,
            ...(installedAny
              ? buildAppliedResponse('Skills installed successfully.')
              : {
                requiresReload: false,
                message: 'No skills were installed',
              }),
          },
        };
      }

      return { id, type, success: true, data };
    }

    case 'api:config/skills/files': {
      const { method, name, filePath, content, directory, skillId } = (payload || {}) as {
        method?: string;
        name?: string;
        filePath?: string;
        content?: string;
        directory?: string;
        skillId?: string;
      };
      const workingDirectory = resolveWorkingDirectory(ctx, directory);

      const skillName = typeof name === 'string' ? name.trim() : '';
      if (!skillName) {
        return { id, type, success: false, error: 'Skill name is required' };
      }

      const relativePath = typeof filePath === 'string' ? filePath.trim() : '';
      if (!relativePath) {
        return { id, type, success: false, error: 'File path is required' };
      }

      const selected = await resolveSelectedSkill(deps, ctx, workingDirectory, skillName, skillId);
      if (selected.error) {
        return { id, type, success: false, error: selected.error };
      }
      const discoveredSkill = selected.skill ?? (await resolveDiscoveredSkills(deps, ctx, workingDirectory))
        .find((skill) => skill.name === skillName) ?? null;
      const sources = getSkillSources(skillName, workingDirectory, discoveredSkill, { id: selected.skillId });
      if (!sources.md.dir) {
        return { id, type, success: false, error: `Skill "${skillName}" not found` };
      }

      const skillDir = sources.md.dir;
      const normalizedMethod = typeof method === 'string' && method.trim() ? method.trim().toUpperCase() : 'GET';

      if (normalizedMethod === 'GET') {
        const fileContent = readSkillSupportingFile(skillDir, relativePath);
        if (fileContent === null) {
          return { id, type, success: false, error: `File "${relativePath}" not found in skill "${skillName}"` };
        }
        return { id, type, success: true, data: { content: fileContent } };
      }

      if (normalizedMethod === 'PUT') {
        writeSkillSupportingFile(skillDir, relativePath, content || '');
        return { id, type, success: true, data: { success: true } };
      }

      if (normalizedMethod === 'DELETE') {
        deleteSkillSupportingFile(skillDir, relativePath);
        return { id, type, success: true, data: { success: true } };
      }

      return { id, type, success: false, error: `Unsupported method: ${normalizedMethod}` };
    }

    default:
      return null;
  }
}
