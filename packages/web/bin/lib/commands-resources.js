import {
  intro as clackIntro,
  outro as clackOutro,
  cancel as clackCancel,
  confirm as clackConfirm,
  isCancel,
  isJsonMode,
  isQuietMode,
  canPrompt,
  printJson,
  logStatus,
} from '../cli-output.js';
import { EXIT_CODE, TunnelCliError } from './cli-errors.js';
import { apiRequest, resolveTargetPort, resolveScopeDirectory } from './cli-api-client.js';
import { truncate } from './cli-format.js';

function requireName(args, options, label) {
  const name = (typeof args[0] === 'string' && args[0].trim()) || (typeof options.name === 'string' && options.name.trim());
  if (name) return name;
  throw new TunnelCliError(`A ${label} name is required.`, EXIT_CODE.USAGE_ERROR);
}

function resolveScope(options, fallback) {
  const raw = typeof options.scope === 'string' ? options.scope.trim().toLowerCase() : '';
  if (!raw) return fallback;
  if (!['global', 'user', 'project'].includes(raw)) {
    throw new TunnelCliError(`Invalid --scope "${raw}". Use one of: global, user, project.`, EXIT_CODE.USAGE_ERROR);
  }
  return raw;
}

async function confirmDestructive(options, message) {
  if (options.force) return;
  if (canPrompt(options)) {
    const confirmed = await clackConfirm({ message });
    if (isCancel(confirmed) || confirmed !== true) {
      clackCancel('Operation cancelled.');
      throw new TunnelCliError('Cancelled.', 130);
    }
    return;
  }
  throw new TunnelCliError('Refusing to delete without confirmation. Re-run with --force (or --yes) to proceed.', EXIT_CODE.USAGE_ERROR);
}

/**
 * Render a list of resources consistently across all output modes.
 *
 * @param {object} params
 * @param {object} params.options CLI options
 * @param {string} params.title Human intro title
 * @param {Array} params.items Resource items
 * @param {string} params.jsonKey Key used in JSON output
 * @param {(item:any)=>string} params.quietLine Compact quiet-mode line
 * @param {(item:any)=>{message:string,detail?:string}} params.humanLine Human log content
 * @param {string} params.emptyMessage Message when no items
 */
function renderList({ options, title, items, jsonKey, quietLine, humanLine, emptyMessage }) {
  const list = Array.isArray(items) ? items : [];
  if (isJsonMode(options)) {
    printJson({ count: list.length, [jsonKey]: list });
    return;
  }
  if (isQuietMode(options)) {
    for (const item of list) {
      process.stdout.write(`${quietLine(item)}\n`);
    }
    return;
  }
  clackIntro(title);
  if (list.length === 0) {
    logStatus('warning', emptyMessage);
    clackOutro('0 items');
    return;
  }
  for (const item of list) {
    const { message, detail } = humanLine(item);
    logStatus('info', message, detail);
  }
  clackOutro(`${list.length} item(s)`);
}

function renderMutation({ options, title, message, detail, payload }) {
  if (isJsonMode(options)) {
    printJson(payload);
    return;
  }
  if (isQuietMode(options)) {
    process.stdout.write(`${message}\n`);
    return;
  }
  clackIntro(title);
  logStatus('success', message, detail);
  clackOutro('done');
}

// ── agents ──────────────────────────────────────────────────────

async function agentCommand(options, action = 'list', args = []) {
  const valid = ['list', 'show', 'create', 'delete'];
  if (!valid.includes(action)) {
    throw new TunnelCliError(`Unknown agent action '${action}'. Valid: ${valid.join(', ')}.`, EXIT_CODE.USAGE_ERROR);
  }
  const port = await resolveTargetPort(options);
  const directory = resolveScopeDirectory(options);

  if (action === 'list') {
    const agents = await apiRequest(port, 'GET', '/api/agent', { query: { directory }, options });
    const list = (Array.isArray(agents) ? agents : []).slice().sort((a, b) => String(a.name).localeCompare(String(b.name)));
    return renderList({
      options,
      title: 'Agents',
      items: list,
      jsonKey: 'agents',
      quietLine: (a) => `${a.name} ${a.mode || 'agent'}${a.native ? ' built-in' : ''}`,
      humanLine: (a) => ({
        message: a.name,
        detail: [a.mode || 'agent', a.native ? 'built-in' : null, truncate(a.description, 70)].filter(Boolean).join(' · '),
      }),
      emptyMessage: 'No agents found',
    });
  }

  if (action === 'show') {
    const name = requireName(args, options, 'agent');
    const info = await apiRequest(port, 'GET', `/api/config/agents/${encodeURIComponent(name)}`, { query: { directory }, options });
    if (isJsonMode(options)) {
      printJson({ agent: info });
      return undefined;
    }
    if (isQuietMode(options)) {
      process.stdout.write(`${info.name} ${info.scope || 'builtin'}${info.isBuiltIn ? ' built-in' : ''}\n`);
      return undefined;
    }
    clackIntro('Agent Details');
    const lines = [`scope: ${info.scope || 'n/a'}`, `built-in: ${info.isBuiltIn ? 'yes' : 'no'}`];
    if (info.sources?.md?.path) lines.push(`markdown: ${info.sources.md.path}`);
    if (info.sources?.json?.path) lines.push(`json: ${info.sources.json.path}`);
    logStatus('info', info.name, lines.join('\n'));
    clackOutro('done');
    return undefined;
  }

  if (action === 'create') {
    const name = requireName(args, options, 'agent');
    const prompt = (typeof options.prompt === 'string' && options.prompt) || args.slice(1).join(' ').trim();
    if (!prompt) {
      throw new TunnelCliError('An agent prompt is required. Provide --prompt <text> or pass it after the name.', EXIT_CODE.USAGE_ERROR);
    }
    const scope = resolveScope(options, 'user');
    const body = { prompt, scope };
    if (typeof options.description === 'string' && options.description.trim()) body.description = options.description.trim();
    if (typeof options.mode === 'string' && options.mode.trim()) body.mode = options.mode.trim();
    if (typeof options.model === 'string' && options.model.trim()) body.model = options.model.trim();
    const result = await apiRequest(port, 'POST', `/api/config/agents/${encodeURIComponent(name)}`, { query: { directory }, body, options });
    return renderMutation({
      options,
      title: 'Create Agent',
      message: `Created agent ${name}`,
      detail: result?.message,
      payload: { created: true, name, scope, result },
    });
  }

  // delete
  const name = requireName(args, options, 'agent');
  await confirmDestructive(options, `Delete agent ${name}?`);
  const scope = resolveScope(options, undefined);
  const result = await apiRequest(port, 'DELETE', `/api/config/agents/${encodeURIComponent(name)}`, {
    query: { directory },
    body: scope ? { scope } : undefined,
    options,
  });
  return renderMutation({
    options,
    title: 'Delete Agent',
    message: `Deleted agent ${name}`,
    detail: result?.message,
    payload: { deleted: true, name, result },
  });
}

// ── commands (slash commands) ───────────────────────────────────

async function commandResourceCommand(options, action = 'list', args = []) {
  const valid = ['list', 'show', 'create', 'delete'];
  if (!valid.includes(action)) {
    throw new TunnelCliError(`Unknown command action '${action}'. Valid: ${valid.join(', ')}.`, EXIT_CODE.USAGE_ERROR);
  }
  const port = await resolveTargetPort(options);
  const directory = resolveScopeDirectory(options);

  if (action === 'list' || action === 'show') {
    const commands = await apiRequest(port, 'GET', '/api/command', { query: { directory }, options });
    const list = Array.isArray(commands) ? commands : [];
    if (action === 'show') {
      const name = requireName(args, options, 'command');
      const found = list.find((cmd) => cmd.name === name);
      if (!found) {
        throw new TunnelCliError(`Command "${name}" not found.`, EXIT_CODE.GENERAL_ERROR);
      }
      if (isJsonMode(options)) {
        printJson({ command: found });
        return undefined;
      }
      if (isQuietMode(options)) {
        process.stdout.write(`${found.name} ${found.source || ''}\n`);
        return undefined;
      }
      clackIntro('Command Details');
      const lines = [];
      if (found.description) lines.push(`description: ${found.description}`);
      if (found.agent) lines.push(`agent: ${found.agent}`);
      if (found.model) lines.push(`model: ${found.model}`);
      if (found.source) lines.push(`source: ${found.source}`);
      if (found.template) lines.push(`template:\n${found.template}`);
      logStatus('info', `/${found.name}`, lines.join('\n'));
      clackOutro('done');
      return undefined;
    }
    const sorted = list.slice().sort((a, b) => String(a.name).localeCompare(String(b.name)));
    return renderList({
      options,
      title: 'Commands',
      items: sorted,
      jsonKey: 'commands',
      quietLine: (c) => `${c.name} ${c.source || ''}`.trim(),
      humanLine: (c) => ({
        message: `/${c.name}`,
        detail: [c.source, truncate(c.description, 70)].filter(Boolean).join(' · '),
      }),
      emptyMessage: 'No commands found',
    });
  }

  if (action === 'create') {
    const name = requireName(args, options, 'command');
    const template = (typeof options.template === 'string' && options.template) || args.slice(1).join(' ').trim();
    if (!template) {
      throw new TunnelCliError('A command template is required. Provide --template <text> or pass it after the name.', EXIT_CODE.USAGE_ERROR);
    }
    const scope = resolveScope(options, 'user');
    const body = { template, scope };
    if (typeof options.description === 'string' && options.description.trim()) body.description = options.description.trim();
    if (typeof options.agent === 'string' && options.agent.trim()) body.agent = options.agent.trim();
    if (typeof options.model === 'string' && options.model.trim()) body.model = options.model.trim();
    const result = await apiRequest(port, 'POST', `/api/config/commands/${encodeURIComponent(name)}`, { query: { directory }, body, options });
    return renderMutation({
      options,
      title: 'Create Command',
      message: `Created command /${name}`,
      detail: result?.message,
      payload: { created: true, name, scope, result },
    });
  }

  const name = requireName(args, options, 'command');
  await confirmDestructive(options, `Delete command /${name}?`);
  const result = await apiRequest(port, 'DELETE', `/api/config/commands/${encodeURIComponent(name)}`, { query: { directory }, options });
  return renderMutation({
    options,
    title: 'Delete Command',
    message: `Deleted command /${name}`,
    detail: result?.message,
    payload: { deleted: true, name, result },
  });
}

// ── skills ──────────────────────────────────────────────────────

async function skillCommand(options, action = 'list', args = []) {
  const valid = ['list', 'show'];
  if (!valid.includes(action)) {
    throw new TunnelCliError(`Unknown skill action '${action}'. Valid: ${valid.join(', ')}.`, EXIT_CODE.USAGE_ERROR);
  }
  const port = await resolveTargetPort(options);
  const directory = resolveScopeDirectory(options);
  const skills = await apiRequest(port, 'GET', '/api/skill', { query: { directory }, options });
  const list = Array.isArray(skills) ? skills : [];

  if (action === 'show') {
    const name = requireName(args, options, 'skill');
    const found = list.find((skill) => skill.name === name);
    if (!found) {
      throw new TunnelCliError(`Skill "${name}" not found.`, EXIT_CODE.GENERAL_ERROR);
    }
    if (isJsonMode(options)) {
      printJson({ skill: found });
      return undefined;
    }
    if (isQuietMode(options)) {
      process.stdout.write(`${found.name} ${found.location || ''}\n`);
      return undefined;
    }
    clackIntro('Skill Details');
    const lines = [];
    if (found.description) lines.push(`description: ${found.description}`);
    if (found.location) lines.push(`location: ${found.location}`);
    logStatus('info', found.name, lines.join('\n'));
    clackOutro('done');
    return undefined;
  }

  const sorted = list.slice().sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return renderList({
    options,
    title: 'Skills',
    items: sorted,
    jsonKey: 'skills',
    quietLine: (s) => `${s.name}`,
    humanLine: (s) => ({ message: s.name, detail: truncate(s.description, 80) }),
    emptyMessage: 'No skills found',
  });
}

// ── MCP servers ─────────────────────────────────────────────────

function describeMcp(entry) {
  if (entry?.type === 'remote') return entry.url || 'remote';
  if (Array.isArray(entry?.command)) return entry.command.join(' ');
  return entry?.type || 'local';
}

async function mcpCommand(options, action = 'list', args = []) {
  const valid = ['list', 'show', 'create', 'delete'];
  if (!valid.includes(action)) {
    throw new TunnelCliError(`Unknown mcp action '${action}'. Valid: ${valid.join(', ')}.`, EXIT_CODE.USAGE_ERROR);
  }
  const port = await resolveTargetPort(options);
  const directory = resolveScopeDirectory(options);

  if (action === 'list') {
    const servers = await apiRequest(port, 'GET', '/api/config/mcp', { query: { directory }, options });
    const list = Array.isArray(servers) ? servers : [];
    return renderList({
      options,
      title: 'MCP Servers',
      items: list,
      jsonKey: 'mcpServers',
      quietLine: (s) => `${s.name} ${s.type || 'local'} ${s.enabled === false ? 'disabled' : 'enabled'}`,
      humanLine: (s) => ({
        message: s.name,
        detail: [s.type || 'local', s.enabled === false ? 'disabled' : 'enabled', s.scope || null, truncate(describeMcp(s), 60)].filter(Boolean).join(' · '),
      }),
      emptyMessage: 'No MCP servers configured',
    });
  }

  if (action === 'show') {
    const name = requireName(args, options, 'mcp');
    const server = await apiRequest(port, 'GET', `/api/config/mcp/${encodeURIComponent(name)}`, { query: { directory }, options });
    if (isJsonMode(options)) {
      printJson({ mcpServer: server });
      return undefined;
    }
    if (isQuietMode(options)) {
      process.stdout.write(`${server.name} ${server.type || 'local'} ${server.enabled === false ? 'disabled' : 'enabled'}\n`);
      return undefined;
    }
    clackIntro('MCP Server Details');
    const lines = [`type: ${server.type || 'local'}`, `enabled: ${server.enabled === false ? 'no' : 'yes'}`];
    if (server.scope) lines.push(`scope: ${server.scope}`);
    if (server.url) lines.push(`url: ${server.url}`);
    if (Array.isArray(server.command)) lines.push(`command: ${server.command.join(' ')}`);
    logStatus('info', server.name, lines.join('\n'));
    clackOutro('done');
    return undefined;
  }

  if (action === 'create') {
    const name = requireName(args, options, 'mcp');
    const scope = resolveScope(options, 'user');
    const url = typeof options.url === 'string' && options.url.trim() ? options.url.trim() : '';
    const commandStr = typeof options.commandStr === 'string' && options.commandStr.trim() ? options.commandStr.trim() : '';
    const body = { scope, enabled: true };
    if (url) {
      body.type = 'remote';
      body.url = url;
    } else if (commandStr) {
      body.type = 'local';
      body.command = commandStr.split(/\s+/).filter(Boolean);
    } else {
      throw new TunnelCliError('Provide --url <url> for a remote server, or --command "<cmd args>" for a local server.', EXIT_CODE.USAGE_ERROR);
    }
    const result = await apiRequest(port, 'POST', `/api/config/mcp/${encodeURIComponent(name)}`, { query: { directory }, body, options });
    return renderMutation({
      options,
      title: 'Create MCP Server',
      message: `Created MCP server ${name}`,
      detail: result?.message,
      payload: { created: true, name, scope, type: body.type, result },
    });
  }

  const name = requireName(args, options, 'mcp');
  await confirmDestructive(options, `Delete MCP server ${name}?`);
  const result = await apiRequest(port, 'DELETE', `/api/config/mcp/${encodeURIComponent(name)}`, { query: { directory }, options });
  return renderMutation({
    options,
    title: 'Delete MCP Server',
    message: `Deleted MCP server ${name}`,
    detail: result?.message,
    payload: { deleted: true, name, result },
  });
}

// ── snippets ────────────────────────────────────────────────────

async function snippetCommand(options, action = 'list', args = []) {
  const valid = ['list', 'show', 'create', 'delete'];
  if (!valid.includes(action)) {
    throw new TunnelCliError(`Unknown snippet action '${action}'. Valid: ${valid.join(', ')}.`, EXIT_CODE.USAGE_ERROR);
  }
  const port = await resolveTargetPort(options);
  const directory = resolveScopeDirectory(options);

  if (action === 'list') {
    const snippets = await apiRequest(port, 'GET', '/api/config/snippets', { query: { directory }, options });
    const list = Array.isArray(snippets) ? snippets : [];
    return renderList({
      options,
      title: 'Snippets',
      items: list,
      jsonKey: 'snippets',
      quietLine: (s) => `${s.name} ${s.source || ''}`.trim(),
      humanLine: (s) => ({
        message: `#${s.name}`,
        detail: [s.source, truncate(s.description || s.content, 70)].filter(Boolean).join(' · '),
      }),
      emptyMessage: 'No snippets found',
    });
  }

  if (action === 'show') {
    const name = requireName(args, options, 'snippet');
    const snippet = await apiRequest(port, 'GET', `/api/config/snippets/${encodeURIComponent(name)}`, { query: { directory }, options });
    if (isJsonMode(options)) {
      printJson({ snippet });
      return undefined;
    }
    if (isQuietMode(options)) {
      process.stdout.write(`${snippet.name}\n`);
      return undefined;
    }
    clackIntro('Snippet Details');
    const lines = [];
    if (snippet.description) lines.push(`description: ${snippet.description}`);
    if (Array.isArray(snippet.aliases) && snippet.aliases.length) lines.push(`aliases: ${snippet.aliases.join(', ')}`);
    if (snippet.source) lines.push(`source: ${snippet.source}`);
    if (snippet.content) lines.push(`content:\n${snippet.content}`);
    logStatus('info', `#${snippet.name}`, lines.join('\n'));
    clackOutro('done');
    return undefined;
  }

  if (action === 'create') {
    const name = requireName(args, options, 'snippet');
    const content = (typeof options.content === 'string' && options.content) || args.slice(1).join(' ').trim();
    if (!content) {
      throw new TunnelCliError('Snippet content is required. Provide --content <text> or pass it after the name.', EXIT_CODE.USAGE_ERROR);
    }
    const scope = resolveScope(options, 'global');
    const body = { content, scope };
    if (typeof options.description === 'string' && options.description.trim()) body.description = options.description.trim();
    const result = await apiRequest(port, 'POST', `/api/config/snippets/${encodeURIComponent(name)}`, { query: { directory }, body, options });
    return renderMutation({
      options,
      title: 'Create Snippet',
      message: `Created snippet #${name}`,
      detail: undefined,
      payload: { created: true, name, scope, snippet: result?.snippet },
    });
  }

  const name = requireName(args, options, 'snippet');
  await confirmDestructive(options, `Delete snippet #${name}?`);
  await apiRequest(port, 'DELETE', `/api/config/snippets/${encodeURIComponent(name)}`, { query: { directory }, options });
  return renderMutation({
    options,
    title: 'Delete Snippet',
    message: `Deleted snippet #${name}`,
    detail: undefined,
    payload: { deleted: true, name },
  });
}

// ── providers / models ──────────────────────────────────────────

async function providerCommand(options, action = 'list', args = []) {
  const valid = ['list', 'models'];
  if (!valid.includes(action)) {
    throw new TunnelCliError(`Unknown provider action '${action}'. Valid: ${valid.join(', ')}.`, EXIT_CODE.USAGE_ERROR);
  }
  const port = await resolveTargetPort(options);
  const directory = resolveScopeDirectory(options);
  const config = await apiRequest(port, 'GET', '/api/config/providers', { query: { directory }, options });
  const providers = Array.isArray(config?.providers) ? config.providers : [];

  if (action === 'models') {
    const providerId = (typeof args[0] === 'string' && args[0].trim()) || (typeof options.provider === 'string' && options.provider.trim());
    const models = [];
    for (const provider of providers) {
      if (providerId && provider.id !== providerId) continue;
      const entries = provider?.models && typeof provider.models === 'object' ? Object.values(provider.models) : [];
      for (const model of entries) {
        models.push({ providerID: provider.id, id: model.id, name: model.name || model.id });
      }
    }
    return renderList({
      options,
      title: providerId ? `Models · ${providerId}` : 'Models',
      items: models,
      jsonKey: 'models',
      quietLine: (m) => `${m.providerID}/${m.id}`,
      humanLine: (m) => ({ message: `${m.providerID}/${m.id}`, detail: m.name }),
      emptyMessage: providerId ? `No models for provider "${providerId}"` : 'No models found',
    });
  }

  const list = providers.slice().sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return renderList({
    options,
    title: 'Providers',
    items: list,
    jsonKey: 'providers',
    quietLine: (p) => `${p.id} models:${p.models ? Object.keys(p.models).length : 0}`,
    humanLine: (p) => ({
      message: p.id,
      detail: [p.name, p.source ? `source: ${p.source}` : null, `${p.models ? Object.keys(p.models).length : 0} models`].filter(Boolean).join(' · '),
    }),
    emptyMessage: 'No providers configured',
  });
}

// ── projects ────────────────────────────────────────────────────

async function projectCommand(options, action = 'list') {
  const valid = ['list'];
  if (!valid.includes(action)) {
    throw new TunnelCliError(`Unknown project action '${action}'. Valid: ${valid.join(', ')}.`, EXIT_CODE.USAGE_ERROR);
  }
  const port = await resolveTargetPort(options);
  const settings = await apiRequest(port, 'GET', '/api/config/settings', { options });
  const projects = Array.isArray(settings?.projects) ? settings.projects : [];
  const activeId = settings?.activeProjectId;
  return renderList({
    options,
    title: 'Projects',
    items: projects,
    jsonKey: 'projects',
    quietLine: (p) => `${p.path}${p.id === activeId ? ' active' : ''}`,
    humanLine: (p) => ({
      message: p.path,
      detail: [p.id === activeId ? 'active' : null, p.id].filter(Boolean).join(' · '),
    }),
    emptyMessage: 'No projects added',
  });
}

// ── config / settings ───────────────────────────────────────────

async function configCommand(options, action = 'get') {
  const valid = ['get'];
  if (!valid.includes(action)) {
    throw new TunnelCliError(`Unknown config action '${action}'. Valid: ${valid.join(', ')}.`, EXIT_CODE.USAGE_ERROR);
  }
  const port = await resolveTargetPort(options);
  const settings = await apiRequest(port, 'GET', '/api/config/settings', { options });

  if (isJsonMode(options)) {
    printJson({ settings });
    return undefined;
  }
  if (isQuietMode(options)) {
    process.stdout.write(`theme ${settings?.themeId || 'n/a'}\n`);
    process.stdout.write(`lastDirectory ${settings?.lastDirectory || 'n/a'}\n`);
    process.stdout.write(`projects ${Array.isArray(settings?.projects) ? settings.projects.length : 0}\n`);
    return undefined;
  }
  clackIntro('OpenChamber Settings');
  const lines = [
    `theme: ${settings?.themeId || 'n/a'}${settings?.themeVariant ? ` (${settings.themeVariant})` : ''}`,
    `use system theme: ${settings?.useSystemTheme ? 'yes' : 'no'}`,
    `last directory: ${settings?.lastDirectory || 'n/a'}`,
    `home directory: ${settings?.homeDirectory || 'n/a'}`,
    `projects: ${Array.isArray(settings?.projects) ? settings.projects.length : 0}`,
  ];
  logStatus('info', 'settings', lines.join('\n'));
  clackOutro('done');
  return undefined;
}

export {
  agentCommand,
  commandResourceCommand,
  skillCommand,
  mcpCommand,
  snippetCommand,
  providerCommand,
  projectCommand,
  configCommand,
};
