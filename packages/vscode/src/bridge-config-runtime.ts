import * as vscode from 'vscode';
import * as path from 'path';
import {
  createAgent,
  createCommand,
  deleteAgent,
  deleteCommand,
  getAgentSources,
  getCommandSources,
  updateAgent,
  updateCommand,
  type AgentScope,
  type CommandScope,
  AGENT_SCOPE,
  COMMAND_SCOPE,
  discoverSkills,
  getSkillSources,
  createSkill,
  updateSkill,
  deleteSkill,
  readSkillSupportingFile,
  writeSkillSupportingFile,
  deleteSkillSupportingFile,
  type SkillScope,
  type DiscoveredSkill,
  SKILL_SCOPE,
  listMcpConfigs,
  getMcpConfig,
  createMcpConfig,
  updateMcpConfig,
  deleteMcpConfig,
} from './opencodeConfig';
import {
  getSkillsCatalog,
  scanSkillsRepository as scanSkillsRepositoryFromGit,
  installSkillsFromRepository as installSkillsFromGit,
  type SkillsCatalogSourceConfig,
} from './skillsCatalog';
import type { BridgeContext, BridgeResponse } from './bridge';

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
  clientReloadDelayMs: number;
};

const resolveWorkingDirectory = (ctx: BridgeContext | undefined, directory?: string): string | undefined => (
  (typeof directory === 'string' && directory.trim())
    ? directory.trim()
    : (ctx?.manager?.getWorkingDirectory() || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath)
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

    case 'api:config/agents': {
      const { method, name, body, directory } = (payload || {}) as {
        method?: string;
        name?: string;
        body?: Record<string, unknown>;
        directory?: string;
      };
      const agentName = typeof name === 'string' ? name.trim() : '';
      if (!agentName) {
        return { id, type, success: false, error: 'Agent name is required' };
      }

      const workingDirectory = resolveWorkingDirectory(ctx, directory);
      const normalizedMethod = typeof method === 'string' && method.trim() ? method.trim().toUpperCase() : 'GET';

      if (normalizedMethod === 'GET') {
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
        createAgent(agentName, (body || {}) as Record<string, unknown>, workingDirectory, scope);
        await ctx?.manager?.restart();
        return {
          id,
          type,
          success: true,
          data: {
            success: true,
            requiresReload: true,
            message: `Agent ${agentName} created successfully. Reloading interface…`,
            reloadDelayMs: deps.clientReloadDelayMs,
          },
        };
      }

      if (normalizedMethod === 'PATCH') {
        updateAgent(agentName, (body || {}) as Record<string, unknown>, workingDirectory);
        await ctx?.manager?.restart();
        return {
          id,
          type,
          success: true,
          data: {
            success: true,
            requiresReload: true,
            message: `Agent ${agentName} updated successfully. Reloading interface…`,
            reloadDelayMs: deps.clientReloadDelayMs,
          },
        };
      }

      if (normalizedMethod === 'DELETE') {
        deleteAgent(agentName, workingDirectory);
        await ctx?.manager?.restart();
        return {
          id,
          type,
          success: true,
          data: {
            success: true,
            requiresReload: true,
            message: `Agent ${agentName} deleted successfully. Reloading interface…`,
            reloadDelayMs: deps.clientReloadDelayMs,
          },
        };
      }

      return { id, type, success: false, error: `Unsupported method: ${normalizedMethod}` };
    }

    case 'api:config/commands': {
      const { method, name, body, directory } = (payload || {}) as {
        method?: string;
        name?: string;
        body?: Record<string, unknown>;
        directory?: string;
      };
      const commandName = typeof name === 'string' ? name.trim() : '';
      if (!commandName) {
        return { id, type, success: false, error: 'Command name is required' };
      }

      const workingDirectory = resolveWorkingDirectory(ctx, directory);
      const normalizedMethod = typeof method === 'string' && method.trim() ? method.trim().toUpperCase() : 'GET';

      if (normalizedMethod === 'GET') {
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
        await ctx?.manager?.restart();
        return {
          id,
          type,
          success: true,
          data: {
            success: true,
            requiresReload: true,
            message: `Command ${commandName} created successfully. Reloading interface…`,
            reloadDelayMs: deps.clientReloadDelayMs,
          },
        };
      }

      if (normalizedMethod === 'PATCH') {
        updateCommand(commandName, (body || {}) as Record<string, unknown>, workingDirectory);
        await ctx?.manager?.restart();
        return {
          id,
          type,
          success: true,
          data: {
            success: true,
            requiresReload: true,
            message: `Command ${commandName} updated successfully. Reloading interface…`,
            reloadDelayMs: deps.clientReloadDelayMs,
          },
        };
      }

      if (normalizedMethod === 'DELETE') {
        deleteCommand(commandName, workingDirectory);
        await ctx?.manager?.restart();
        return {
          id,
          type,
          success: true,
          data: {
            success: true,
            requiresReload: true,
            message: `Command ${commandName} deleted successfully. Reloading interface…`,
            reloadDelayMs: deps.clientReloadDelayMs,
          },
        };
      }

      return { id, type, success: false, error: `Unsupported method: ${normalizedMethod}` };
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
        createMcpConfig(mcpName, (body || {}) as Record<string, unknown>, workingDirectory, scope);
        await ctx?.manager?.restart();
        return {
          id,
          type,
          success: true,
          data: {
            success: true,
            requiresReload: true,
            message: `MCP server "${mcpName}" created. Reloading interface…`,
            reloadDelayMs: deps.clientReloadDelayMs,
          },
        };
      }

      if (normalizedMethod === 'PATCH') {
        updateMcpConfig(mcpName, (body || {}) as Record<string, unknown>, workingDirectory);
        await ctx?.manager?.restart();
        return {
          id,
          type,
          success: true,
          data: {
            success: true,
            requiresReload: true,
            message: `MCP server "${mcpName}" updated. Reloading interface…`,
            reloadDelayMs: deps.clientReloadDelayMs,
          },
        };
      }

      if (normalizedMethod === 'DELETE') {
        deleteMcpConfig(mcpName, workingDirectory);
        await ctx?.manager?.restart();
        return {
          id,
          type,
          success: true,
          data: {
            success: true,
            requiresReload: true,
            message: `MCP server "${mcpName}" deleted. Reloading interface…`,
            reloadDelayMs: deps.clientReloadDelayMs,
          },
        };
      }

      return { id, type, success: false, error: `Unsupported method: ${normalizedMethod}` };
    }

    case 'api:config/skills': {
      const { method, name, body } = (payload || {}) as { method?: string; name?: string; body?: Record<string, unknown> };
      const workingDirectory = ctx?.manager?.getWorkingDirectory() || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const normalizedMethod = typeof method === 'string' && method.trim() ? method.trim().toUpperCase() : 'GET';

      if (!name && normalizedMethod === 'GET') {
        const skills = (await deps.fetchOpenCodeSkillsFromApi(ctx, workingDirectory)) || discoverSkills(workingDirectory);
        return { id, type, success: true, data: { skills } };
      }

      const skillName = typeof name === 'string' ? name.trim() : '';
      if (!skillName) {
        return { id, type, success: false, error: 'Skill name is required' };
      }

      if (normalizedMethod === 'GET') {
        const discoveredSkill = ((await deps.fetchOpenCodeSkillsFromApi(ctx, workingDirectory)) || [])
          .find((skill) => skill.name === skillName);
        const sources = getSkillSources(skillName, workingDirectory, discoveredSkill || null);
        return {
          id,
          type,
          success: true,
          data: { name: skillName, sources, scope: sources.md.scope, source: sources.md.source },
        };
      }

      if (normalizedMethod === 'POST') {
        const scopeValue = body?.scope as string | undefined;
        const sourceValue = body?.source as string | undefined;
        const scope: SkillScope | undefined = scopeValue === 'project' ? SKILL_SCOPE.PROJECT : scopeValue === 'user' ? SKILL_SCOPE.USER : undefined;
        const normalizedSource = sourceValue === 'agents' ? 'agents' : 'opencode';
        createSkill(skillName, { ...(body || {}), source: normalizedSource } as Record<string, unknown>, workingDirectory, scope);
        await ctx?.manager?.restart();
        return {
          id,
          type,
          success: true,
          data: {
            success: true,
            requiresReload: true,
            message: `Skill ${skillName} created successfully. Reloading interface…`,
            reloadDelayMs: deps.clientReloadDelayMs,
          },
        };
      }

      if (normalizedMethod === 'PATCH') {
        updateSkill(skillName, (body || {}) as Record<string, unknown>, workingDirectory);
        await ctx?.manager?.restart();
        return {
          id,
          type,
          success: true,
          data: {
            success: true,
            requiresReload: true,
            message: `Skill ${skillName} updated successfully. Reloading interface…`,
            reloadDelayMs: deps.clientReloadDelayMs,
          },
        };
      }

      if (normalizedMethod === 'DELETE') {
        deleteSkill(skillName, workingDirectory);
        await ctx?.manager?.restart();
        return {
          id,
          type,
          success: true,
          data: {
            success: true,
            requiresReload: true,
            message: `Skill ${skillName} deleted successfully. Reloading interface…`,
            reloadDelayMs: deps.clientReloadDelayMs,
          },
        };
      }

      return { id, type, success: false, error: `Unsupported method: ${normalizedMethod}` };
    }

    case 'api:config/skills:catalog': {
      const refresh = Boolean((payload as { refresh?: boolean } | undefined)?.refresh);
      const workingDirectory = ctx?.manager?.getWorkingDirectory() || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      const settings = deps.readSettings(ctx);
      const additionalSources = parseSkillsCatalogSources(settings);
      const installedSkills = (await deps.fetchOpenCodeSkillsFromApi(ctx, workingDirectory)) || undefined;
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
        const requiresReload = installed.length > 0;

        if (requiresReload) {
          await ctx?.manager?.restart();
        }

        return {
          id,
          type,
          success: true,
          data: {
            ok: true,
            installed,
            skipped,
            requiresReload,
            message: requiresReload ? 'Skills installed successfully. Reloading interface…' : 'No skills were installed',
            reloadDelayMs: requiresReload ? deps.clientReloadDelayMs : undefined,
          },
        };
      }

      return { id, type, success: true, data };
    }

    case 'api:config/skills/files': {
      const { method, name, filePath, content } = (payload || {}) as {
        method?: string;
        name?: string;
        filePath?: string;
        content?: string;
      };
      const workingDirectory = ctx?.manager?.getWorkingDirectory() || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

      const skillName = typeof name === 'string' ? name.trim() : '';
      if (!skillName) {
        return { id, type, success: false, error: 'Skill name is required' };
      }

      const relativePath = typeof filePath === 'string' ? filePath.trim() : '';
      if (!relativePath) {
        return { id, type, success: false, error: 'File path is required' };
      }

      const discoveredSkill = ((await deps.fetchOpenCodeSkillsFromApi(ctx, workingDirectory)) || [])
        .find((skill) => skill.name === skillName);
      const sources = getSkillSources(skillName, workingDirectory, discoveredSkill || null);
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
