import path from 'path';
import { buildAppliedResponse } from './config-mutation-response.js';
import { isString } from '../shared/object-guards.js';
import type { Application, Request, Response } from '../shared/http-contracts.js';
import type { JsonObject, JsonValue } from '../shared/json-values.js';
import type { OpenCodeConfigLayer } from './config-files.js';
import type { createProjectDirectoryRuntime } from '../projects/project-directory-runtime.js';
import type * as agents from './agents.js';
import type * as commands from './commands.js';
import type * as mcp from './mcp.js';

export interface ConfigEntityRouteDependencies<Snippet> extends Pick<ReturnType<typeof createProjectDirectoryRuntime>,
  'resolveProjectDirectory' | 'resolveOptionalProjectDirectory'>,
  Pick<typeof agents, 'getAgentSources' | 'getAgentConfig' | 'getAgentPermissions' | 'listDisabledAgents' | 'createAgent' | 'updateAgent' | 'deleteAgent'>,
  Pick<typeof commands, 'getCommandSources' | 'getCommandConfig' | 'createCommand' | 'updateCommand' | 'deleteCommand'>,
  Pick<typeof mcp, 'listMcpConfigs' | 'getMcpConfig' | 'createMcpConfig' | 'updateMcpConfig' | 'deleteMcpConfig'> {
  listSnippets: (directory: string | null) => Snippet[];
  getSnippet: (name: string, directory: string | null) => Snippet | null;
  createSnippet: (name: string, config: SnippetBody, directory: string | null, scope: string) => Snippet | null;
  updateSnippet: (name: string, updates: SnippetBody, directory: string | null) => Snippet | null;
  deleteSnippet: (name: string, directory: string | null) => void;
  expandSnippets: (text: string, directory: string | null) => string;
  previewSnippet: (content: string, directory: string | null) => string;
}

interface SnippetBody {
  name?: JsonValue;
  scope?: string;
  content?: string | null;
  aliases?: JsonValue[];
  description?: string;
}
const hasBodyFields = (value: unknown): value is Record<string, unknown> => value != null;
const bodyFields = <Value>(value: Value) => hasBodyFields(value) ? value : undefined;
const agentScope = <Value>(value: Value): agents.AgentScope | undefined =>
  value === 'project' ? 'project' : value === 'user' ? 'user' : undefined;
const requiredBodyFields = <Value>(value: Value) => {
  if (hasBodyFields(value)) return value;
  throw new TypeError(`Cannot destructure property 'scope' of 'req.body' as it is ${value}.`);
};
const hasErrorFields = (value: unknown): value is { message?: unknown; stack?: unknown } => value != null;
const optionalErrorFields = <Value>(value: Value) => hasErrorFields(value) ? value : undefined;
const errorFields = <Value>(value: Value, property: 'message' | 'stack' = 'message') => {
  if (hasErrorFields(value)) return value;
  throw new TypeError(`Cannot read properties of ${value} (reading '${property}')`);
};
interface IncludesMethod<Result> {
  (search: string): Result;
}
const isIncludesMethod = (value: unknown): value is IncludesMethod<unknown> => typeof value === 'function';
const messageIncludes = <Value>(value: Value, search: string) => {
  const message = errorFields(value).message;
  if (message == null) return undefined;
  const boxed: { includes?: unknown } = Object(message);
  const includes = boxed.includes;
  if (!isIncludesMethod(includes)) throw new TypeError('error.message?.includes is not a function');
  return Boolean(Function.prototype.call.call(includes, message, search));
};

const isSafeEntityName = (name: string) => (
  name.length > 0
  && !name.includes('\\')
  && !name.includes('\0')
  && !path.isAbsolute(name)
  && name.split('/').every((segment) => segment && segment !== '.' && segment !== '..')
);

export const registerConfigEntityRoutes = <Snippet>(app: Application, dependencies: ConfigEntityRouteDependencies<Snippet>) => {
  const {
    resolveProjectDirectory,
    resolveOptionalProjectDirectory,
    getAgentSources,
    getAgentConfig,
    getAgentPermissions,
    listDisabledAgents,
    createAgent,
    updateAgent,
    deleteAgent,
    getCommandSources,
    getCommandConfig,
    createCommand,
    updateCommand,
    deleteCommand,
    listMcpConfigs,
    getMcpConfig,
    createMcpConfig,
    updateMcpConfig,
    deleteMcpConfig,
    listSnippets,
    getSnippet,
    createSnippet,
    updateSnippet,
    deleteSnippet,
    expandSnippets,
    previewSnippet,
  } = dependencies;

  const completeMcpMutation = async (res: Response, action: 'create' | 'update' | 'delete', name: string, applyChange: () => ReturnType<typeof mcp.createMcpConfig> | ReturnType<typeof mcp.deleteMcpConfig>) => {
    const result = applyChange();
    const past = action === 'delete' ? 'deleted' : `${action}d`;
    return res.json(buildAppliedResponse(
      `MCP server "${name}" ${past}.`,
      result,
    ));
  };

  app.use(['/api/config/agents/:name', '/api/config/commands/:name'], (req: Request<Request['body'], { name: string }>, res, next) => {
    if (!isSafeEntityName(req.params.name)) {
      return res.status(400).json({ error: 'Invalid name' });
    }
    return next();
  });

  app.get('/api/config/disabled-agents', async (req, res) => {
    try {
      const { directory, error } = await resolveProjectDirectory(req);
      if (!directory) {
        return res.status(400).json({ error });
      }
      res.json({ agents: listDisabledAgents(directory) });
    } catch (error) {
      console.error('Failed to list disabled agents:', error);
      res.status(500).json({ error: 'Failed to list disabled agents' });
    }
  });

  app.get<unknown, { name: string }>('/api/config/agents/:name', async (req, res) => {
    try {
      const agentName = req.params.name;
      const { directory, error } = await resolveProjectDirectory(req);
      if (!directory) {
        return res.status(400).json({ error });
      }
      const sources = getAgentSources(agentName, directory);

      const scope = sources.md.exists
        ? sources.md.scope
        : (sources.json.exists ? sources.json.scope : null);

      res.json({
        name: agentName,
        sources: sources,
        scope,
        isBuiltIn: !sources.md.exists && !sources.json.exists
      });
    } catch (error) {
      console.error('Failed to get agent sources:', error);
      res.status(500).json({ error: 'Failed to get agent configuration metadata' });
    }
  });

  app.get<unknown, { name: string }>('/api/config/agents/:name/config', async (req, res) => {
    try {
      const agentName = req.params.name;
      const { directory, error } = await resolveProjectDirectory(req);
      if (!directory) {
        return res.status(400).json({ error });
      }

      const configInfo = getAgentConfig(agentName, directory);
      res.json(configInfo);
    } catch (error) {
      console.error('Failed to get agent config:', error);
      res.status(500).json({ error: 'Failed to get agent configuration' });
    }
  });

  app.get<unknown, { name: string }>('/api/config/agents/:name/permissions', async (req, res) => {
    try {
      const agentName = req.params.name;
      const { directory, error } = await resolveProjectDirectory(req);
      if (!directory) {
        return res.status(400).json({ error });
      }
      res.json(getAgentPermissions(agentName, directory));
    } catch (error) {
      console.error('Failed to get agent permissions:', error);
      res.status(500).json({ error: 'Failed to get agent permissions' });
    }
  });

  app.post<JsonObject | undefined, { name: string }>('/api/config/agents/:name', async (req, res) => {
    try {
      const agentName = req.params.name;
      const { scope, ...config } = requiredBodyFields(req.body);
      const { directory, error } = await resolveProjectDirectory(req);
      if (!directory) {
        return res.status(400).json({ error });
      }

      console.log('[Server] Creating agent:', agentName);
      console.log('[Server] Config received:', JSON.stringify(config, null, 2));
      console.log('[Server] Scope:', scope, 'Working directory:', directory);

      const created = createAgent(agentName, config, directory, agentScope(scope));
      res.json(buildAppliedResponse(
        `Agent ${agentName} created successfully.`,
        created,
      ));
    } catch (error) {
      console.error('Failed to create agent:', error);
      res.status(500).json({ error: errorFields(error).message || 'Failed to create agent' });
    }
  });

  app.patch<JsonValue | undefined, { name: string }>('/api/config/agents/:name', async (req, res) => {
    try {
      const agentName = req.params.name;
      const updates = req.body;
      const { directory, error } = await resolveProjectDirectory(req);
      if (!directory) {
        return res.status(400).json({ error });
      }

      console.log(`[Server] Updating agent: ${agentName}`);
      console.log('[Server] Updates:', JSON.stringify(updates, null, 2));
      console.log('[Server] Working directory:', directory);

      const updated = updateAgent(agentName, updates ?? null, directory);

      console.log(`[Server] Agent ${agentName} updated successfully`);

      res.json(buildAppliedResponse(
        `Agent ${agentName} updated successfully.`,
        updated,
      ));
    } catch (error) {
      console.error('[Server] Failed to update agent:', error);
      console.error('[Server] Error stack:', errorFields(error, 'stack').stack);
      res.status(500).json({ error: errorFields(error).message || 'Failed to update agent' });
    }
  });

  app.delete<unknown, { name: string }>('/api/config/agents/:name', async (req, res) => {
    try {
      const agentName = req.params.name;
      const { directory, error } = await resolveProjectDirectory(req);
      if (!directory) {
        return res.status(400).json({ error });
      }

      const scope = bodyFields(req.body)?.scope;
      deleteAgent(agentName, directory, agentScope(scope));
      res.json(buildAppliedResponse(
        `Agent ${agentName} deleted successfully.`,
      ));
    } catch (error) {
      console.error('Failed to delete agent:', error);
      res.status(500).json({ error: errorFields(error).message || 'Failed to delete agent' });
    }
  });

  app.get('/api/config/mcp', async (req, res) => {
    try {
      const { directory, error } = await resolveOptionalProjectDirectory(req);
      if (error) {
        return res.status(400).json({ error });
      }
      const configs = listMcpConfigs(directory);
      res.json(configs);
    } catch (error) {
      console.error('[API:GET /api/config/mcp] Failed:', error);
      res.status(500).json({ error: errorFields(error).message || 'Failed to list MCP configs' });
    }
  });

  app.get<unknown, { name: string }>('/api/config/mcp/:name', async (req, res) => {
    try {
      const name = req.params.name;
      const { directory, error } = await resolveOptionalProjectDirectory(req);
      if (error) {
        return res.status(400).json({ error });
      }
      const config = getMcpConfig(name, directory);
      if (!config) {
        return res.status(404).json({ error: `MCP server "${name}" not found` });
      }
      res.json(config);
    } catch (error) {
      console.error('[API:GET /api/config/mcp/:name] Failed:', error);
      res.status(500).json({ error: errorFields(error).message || 'Failed to get MCP config' });
    }
  });

  app.post<OpenCodeConfigLayer | undefined, { name: string }>('/api/config/mcp/:name', async (req, res) => {
    try {
      const name = req.params.name;
      const { scope, ...config } = requiredBodyFields(req.body || {});
      const { directory, error } = await resolveOptionalProjectDirectory(req);
      if (error) {
        return res.status(400).json({ error });
      }
      console.log(`[API:POST /api/config/mcp] Creating MCP server: ${name}`);

      await completeMcpMutation(res, 'create', name, () => createMcpConfig(name, config, directory, agentScope(scope)));
    } catch (error) {
      console.error('[API:POST /api/config/mcp/:name] Failed:', error);
      res.status(500).json({ error: errorFields(error).message || 'Failed to create MCP server' });
    }
  });

  app.patch<OpenCodeConfigLayer | null | undefined, { name: string }>('/api/config/mcp/:name', async (req, res) => {
    try {
      const name = req.params.name;
      const updates = req.body;
      const { directory, error } = await resolveOptionalProjectDirectory(req);
      if (error) {
        return res.status(400).json({ error });
      }
      console.log(`[API:PATCH /api/config/mcp] Updating MCP server: ${name}`);

      await completeMcpMutation(res, 'update', name, () => updateMcpConfig(name, updates, directory));
    } catch (error) {
      console.error('[API:PATCH /api/config/mcp/:name] Failed:', error);
      if (optionalErrorFields(error)?.message === `MCP server "${req.params.name}" not found`) {
        return res.status(404).json({ error: errorFields(error).message });
      }
      res.status(500).json({ error: errorFields(error).message || 'Failed to update MCP server' });
    }
  });

  app.delete('/api/config/mcp/:name', async (req: Request<Request['body'], { name: string }>, res) => {
    try {
      const name = req.params.name;
      const { directory, error } = await resolveOptionalProjectDirectory(req);
      if (error) {
        return res.status(400).json({ error });
      }
      console.log(`[API:DELETE /api/config/mcp] Deleting MCP server: ${name}`);

      await completeMcpMutation(res, 'delete', name, () => deleteMcpConfig(name, directory));
    } catch (error) {
      console.error('[API:DELETE /api/config/mcp/:name] Failed:', error);
      res.status(500).json({ error: errorFields(error).message || 'Failed to delete MCP server' });
    }
  });

  app.get<unknown, { name: string }>('/api/config/commands/:name', async (req, res) => {
    try {
      const commandName = req.params.name;
      const { directory, error } = await resolveProjectDirectory(req);
      if (!directory) {
        return res.status(400).json({ error });
      }
      const sources = getCommandSources(commandName, directory);

      const scope = sources.md.exists
        ? sources.md.scope
        : (sources.json.exists ? sources.json.scope : null);

      res.json({
        name: commandName,
        sources: sources,
        scope,
        isBuiltIn: !sources.md.exists && !sources.json.exists
      });
    } catch (error) {
      console.error('Failed to get command sources:', error);
      res.status(500).json({ error: 'Failed to get command configuration metadata' });
    }
  });

  app.get<unknown, { name: string }>('/api/config/commands/:name/config', async (req, res) => {
    try {
      const commandName = req.params.name;
      const { directory, error } = await resolveProjectDirectory(req);
      if (!directory) {
        return res.status(400).json({ error });
      }
      res.json(getCommandConfig(commandName, directory));
    } catch (error) {
      console.error('Failed to get command config:', error);
      res.status(500).json({ error: 'Failed to get command configuration' });
    }
  });

  app.get('/api/config/command-configs', async (req, res) => {
    try {
      const { directory, error } = await resolveProjectDirectory(req);
      if (!directory) {
        return res.status(400).json({ error });
      }
      const names = [req.query.name].flat().filter((name): name is string => isString(name) && name.length > 0);
      if (names.length > 500) {
        return res.status(400).json({ error: 'Too many commands' });
      }
      if (!names.every(isSafeEntityName)) {
        return res.status(400).json({ error: 'Invalid name' });
      }
      const commands = [];
      for (const name of names) {
        try {
          commands.push({ name, entry: getCommandConfig(name, directory) });
        } catch (entryError) {
          console.warn('Failed to get command config:', name, entryError);
        }
      }
      res.json({ commands });
    } catch (error) {
      console.error('Failed to get command configs:', error);
      res.status(500).json({ error: 'Failed to get command configurations' });
    }
  });

  app.post<JsonObject | undefined, { name: string }>('/api/config/commands/:name', async (req, res) => {
    try {
      const commandName = req.params.name;
      const { scope, ...config } = requiredBodyFields(req.body);
      const { directory, error } = await resolveProjectDirectory(req);
      if (!directory) {
        return res.status(400).json({ error });
      }

      console.log('[Server] Creating command:', commandName);
      console.log('[Server] Config received:', JSON.stringify(config, null, 2));
      console.log('[Server] Scope:', scope, 'Working directory:', directory);

      const created = createCommand(commandName, config, directory, agentScope(scope));
      res.json(buildAppliedResponse(
        `Command ${commandName} created successfully.`,
        created,
      ));
    } catch (error) {
      console.error('Failed to create command:', error);
      res.status(500).json({ error: errorFields(error).message || 'Failed to create command' });
    }
  });

  app.patch<JsonObject | null | undefined, { name: string }>('/api/config/commands/:name', async (req, res) => {
    try {
      const commandName = req.params.name;
      const updates = req.body;
      const { directory, error } = await resolveProjectDirectory(req);
      if (!directory) {
        return res.status(400).json({ error });
      }

      console.log(`[Server] Updating command: ${commandName}`);
      console.log('[Server] Updates:', JSON.stringify(updates, null, 2));
      console.log('[Server] Working directory:', directory);

      const updated = updateCommand(commandName, updates, directory);

      console.log(`[Server] Command ${commandName} updated successfully`);

      res.json(buildAppliedResponse(
        `Command ${commandName} updated successfully.`,
        updated,
      ));
    } catch (error) {
      console.error('[Server] Failed to update command:', error);
      console.error('[Server] Error stack:', errorFields(error, 'stack').stack);
      res.status(500).json({ error: errorFields(error).message || 'Failed to update command' });
    }
  });

  app.delete<unknown, { name: string }>('/api/config/commands/:name', async (req, res) => {
    try {
      const commandName = req.params.name;
      const { directory, error } = await resolveProjectDirectory(req);
      if (!directory) {
        return res.status(400).json({ error });
      }

      deleteCommand(commandName, directory);
      res.json(buildAppliedResponse(
        `Command ${commandName} deleted successfully.`,
      ));
    } catch (error) {
      console.error('Failed to delete command:', error);
      res.status(500).json({ error: errorFields(error).message || 'Failed to delete command' });
    }
  });

  app.get('/api/config/snippets', async (req, res) => {
    try {
      const { directory, error } = await resolveOptionalProjectDirectory(req);
      if (error) {
        return res.status(400).json({ error });
      }
      res.json(listSnippets(directory));
    } catch (error) {
      console.error('[API:GET /api/config/snippets] Failed:', error);
      res.status(500).json({ error: errorFields(error).message || 'Failed to list snippets' });
    }
  });

  app.post<{ content?: JsonValue; text?: string } | undefined>('/api/config/snippets/expand', async (req, res) => {
    try {
      const { directory, error } = await resolveOptionalProjectDirectory(req);
      if (error) {
        return res.status(400).json({ error });
      }
      const content = bodyFields(req.body)?.content;
      res.json({ text: content !== undefined ? previewSnippet(String(content), directory) : expandSnippets(bodyFields(req.body)?.text ?? '', directory) });
    } catch (error) {
      console.error('[API:POST /api/config/snippets/expand] Failed:', error);
      res.status(500).json({ error: errorFields(error).message || 'Failed to expand snippets' });
    }
  });

  app.get('/api/config/snippets/:name', async (req: Request<Request['body'], { name: string }>, res) => {
    try {
      const name = req.params.name;
      const { directory, error } = await resolveOptionalProjectDirectory(req);
      if (error) {
        return res.status(400).json({ error });
      }
      const snippet = getSnippet(name, directory);
      if (!snippet) {
        return res.status(404).json({ error: `Snippet "${name}" not found` });
      }
      res.json(snippet);
    } catch (error) {
      console.error('[API:GET /api/config/snippets/:name] Failed:', error);
      if (messageIncludes(error, 'Snippet name')) {
        return res.status(400).json({ error: errorFields(error).message });
      }
      res.status(500).json({ error: errorFields(error).message || 'Failed to get snippet' });
    }
  });

  app.post<SnippetBody | undefined, { name: string }>('/api/config/snippets/:name', async (req, res) => {
    try {
      const name = req.params.name;
      const { directory, error } = await resolveOptionalProjectDirectory(req);
      if (error) {
        return res.status(400).json({ error });
      }
      const snippet = createSnippet(name, req.body || {}, directory, bodyFields(req.body)?.scope || 'global');
      res.json({ success: true, snippet });
    } catch (error) {
      console.error('[API:POST /api/config/snippets/:name] Failed:', error);
      if (messageIncludes(error, 'already exists')) {
        return res.status(409).json({ error: errorFields(error).message });
      }
      if (messageIncludes(error, 'Snippet name') || messageIncludes(error, 'Project directory')) {
        return res.status(400).json({ error: errorFields(error).message });
      }
      res.status(500).json({ error: errorFields(error).message || 'Failed to create snippet' });
    }
  });

  app.patch<SnippetBody | undefined, { name: string }>('/api/config/snippets/:name', async (req, res) => {
    try {
      const name = req.params.name;
      const { directory, error } = await resolveOptionalProjectDirectory(req);
      if (error) {
        return res.status(400).json({ error });
      }
      res.json({ success: true, snippet: updateSnippet(name, req.body || {}, directory) });
    } catch (error) {
      console.error('[API:PATCH /api/config/snippets/:name] Failed:', error);
      if (messageIncludes(error, 'not found')) {
        return res.status(404).json({ error: errorFields(error).message });
      }
      if (messageIncludes(error, 'already exists')) {
        return res.status(409).json({ error: errorFields(error).message });
      }
      if (messageIncludes(error, 'Snippet name') || messageIncludes(error, 'Project directory')) {
        return res.status(400).json({ error: errorFields(error).message });
      }
      res.status(500).json({ error: errorFields(error).message || 'Failed to update snippet' });
    }
  });

  app.delete('/api/config/snippets/:name', async (req: Request<Request['body'], { name: string }>, res) => {
    try {
      const name = req.params.name;
      const { directory, error } = await resolveOptionalProjectDirectory(req);
      if (error) {
        return res.status(400).json({ error });
      }
      deleteSnippet(name, directory);
      res.json({ success: true });
    } catch (error) {
      console.error('[API:DELETE /api/config/snippets/:name] Failed:', error);
      if (messageIncludes(error, 'not found')) {
        return res.status(404).json({ error: errorFields(error).message });
      }
      if (messageIncludes(error, 'Snippet name')) {
        return res.status(400).json({ error: errorFields(error).message });
      }
      res.status(500).json({ error: errorFields(error).message || 'Failed to delete snippet' });
    }
  });
};
