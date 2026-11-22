/**
 * Integration actions for the `openchamber` control tool: OpenCode's MCP
 * servers and skills, single tools, and OpenChamber's own agent tools.
 *
 * Dependencies (`createIntegrationActions(deps)`), with the identifier to pass
 * from packages/web/server/index.js:
 * - `readSettingsFromDiskMigrated` — `readSettingsFromDiskMigrated` (module scope).
 * - `persistSettings` — `persistSettings` (module scope). Saving one of the
 *   agent-tool switches rewrites the managed OpenCode config through the
 *   settings runtime's own hook, so nothing else is needed here.
 *
 * Everything else is imported: the MCP, skill and config-file helpers the
 * config routes use, so a change made here is the same change the Settings
 * pages make. OpenCode reads come from `ctx.getClient(directory)`.
 *
 * Parameters: `toolName`, `policy` and `autoInvoke` are declared here; the
 * actions also read `configScope` and `confirm` from CONFIG_PARAMETERS
 * (./config-actions.js) and the shared `name`, `disabled` and `directory`.
 *
 * How things are switched off, and what OpenCode does with it (checked
 * against OpenCode 2.0.26 `packages/core/src`):
 * - MCP server: `disabled` in its config entry (OpenCode does not start it),
 *   then a runtime disconnect/connect. `policy: true` also writes an
 *   `experimental.policies` statement `{ action: 'integration.use', resource:
 *   'mcp:<name>', effect: 'deny' }`, which removes the server even when another
 *   file enables it or it comes from a plugin.
 * - Skill: `autoInvoke` writes the SKILL.md frontmatter (the model only uses it
 *   when asked); `disabled` writes the `integration.use` deny for
 *   `skill:<id>`, where the id is the SKILL.md folder name, and OpenCode drops
 *   the skill entirely.
 * - Single tool: a top-level `permissions` rule `{ action: <tool>, resource:
 *   '*', effect: 'deny' }`. OpenCode appends top-level rules to every agent
 *   and leaves a tool whose last matching rule is a `*` deny out of the
 *   model's tool list (`whollyDisabled` in core/src/tool.ts). An agent's own
 *   `permissions` come later and can allow it again; the result lists them.
 * Authored policy documents are decided as OpenCode decides them: documents
 * reversed (user-global outranks the repository), last matching statement
 * wins. Organization statements from a connected OpenCode Console are not
 * visible here.
 */
import path from 'node:path';

import { asNonEmptyString, isPlainObject, isString } from '../shared/guards.js';
import { readConfigLayers, getConfigForPath, writeConfig } from '../opencode/config-files.js';
import { listMcpConfigs, updateMcpConfig } from '../opencode/mcp.js';
import { discoverSkills, getSkillSources, updateSkill } from '../opencode/skills.js';
import { OpenChamberControlError } from './error.js';

export const INTEGRATION_ACTION_DEFINITIONS = Object.freeze([
  { action: 'mcp.list', title: 'List MCP servers', description: 'List MCP servers from the OpenCode config files and the running OpenCode, with each one\'s enabled flag, connection status and whether a policy blocks it; scope with directory. OpenCode does not report which tools a server offers' },
  { action: 'mcp.toggle', title: 'Turn an MCP server on or off', description: 'Turn MCP server name on or off with disabled: saves its disabled flag in the config file it lives in, then connects or disconnects it. policy true also adds (or, when enabling, removes) an integration.use deny that blocks it whatever other files say, needed for a server that is not in an editable config file' },
  { action: 'skills.list', title: 'List skills', description: 'List skills OpenCode can use and skills found on disk, with id, scope, whether the model may use them on its own (autoInvoke) and whether a policy blocks them; scope with directory' },
  { action: 'skills.toggle', title: 'Turn a skill on or off', description: 'Change skill name (or id): autoInvoke false lets the model use it only when asked, by editing its SKILL.md; disabled true blocks it completely through an integration.use policy in the configScope file (user by default), false removes that block. Give at least one of them' },
  { action: 'tools.list', title: 'List tools and their switches', description: 'List OpenChamber\'s own agent tools with their on/off state, OpenCode\'s built-in tool names, and every tool the OpenCode config turns off; explains how MCP tools are named. No parameters besides directory' },
  { action: 'tools.toggle', title: 'Turn a tool on or off', description: 'Turn toolName on or off with disabled. For openchamber, openchamber_web, openchamber_memory and openchamber_notify this is the OpenChamber setting; for any other tool it is a permission rule in the configScope file (user by default) that takes the tool away from every agent. MCP tools are named <server>_<tool>; wildcards work, so github_* covers a whole server. Turning off the openchamber tool needs confirm' },
]);

export const INTEGRATION_PARAMETERS = {
  toolName: { type: 'string', description: 'Tool for tools.toggle, as the model sees it: shell, webfetch, openchamber_web, or an MCP tool <server>_<tool>; * and ? wildcards' },
  policy: { type: 'boolean', description: 'mcp.toggle: also add (disabling) or remove (enabling) an integration.use policy block for the server' },
  autoInvoke: { type: 'boolean', description: 'skills.toggle: false lets the model use the skill only when asked; true lets it decide on its own' },
};

const INTEGRATION_ACTIONS = INTEGRATION_ACTION_DEFINITIONS.map(({ action }) => action);

/** OpenChamber's managed tools and the setting each one follows (see managed-config-file.js). */
const SYSTEM_TOOLS = Object.freeze([
  { tool: 'openchamber', settingKey: 'agentControlToolEnabled', defaultEnabled: true, description: 'Projects, sessions, scheduled tasks, settings and integrations; this tool' },
  { tool: 'openchamber_web', settingKey: 'agentWebToolEnabled', defaultEnabled: true, description: 'Look at and drive the page in the browser panel' },
  { tool: 'openchamber_memory', settingKey: 'agentMemoryToolEnabled', defaultEnabled: false, description: 'Remember facts across sessions' },
  { tool: 'openchamber_notify', settingKey: 'agentNotifyToolEnabled', defaultEnabled: false, description: 'Send the user a notification' },
]);

/**
 * OpenCode 2.0.26's built-in tool names (core/src/tool/plugin). A static list,
 * not read from the running OpenCode: it has no route that lists tools.
 */
const OPENCODE_BUILTIN_TOOLS = Object.freeze([
  'read', 'write', 'edit', 'patch', 'glob', 'grep', 'shell', 'question', 'skill', 'subagent', 'webfetch', 'websearch',
  'list_mcp_resources', 'read_mcp_resource', 'session_rename', 'session_move', 'execute',
]);

const TOOLS_GAP_NOTE = 'OpenCode 2 has no route that lists tools, so the tools each MCP server offers cannot be read here. An MCP tool is named <server>_<tool>, with anything outside letters, digits, _ and - turned into _; tools.toggle accepts that name or a wildcard such as github_*';

// ---------------------------------------------------------------------------
// Policies and permission rules

/** OpenCode's `Wildcard.match`: `*` is any run, `?` one character, a trailing ` *` also matches nothing. */
export const matchesWildcard = (input, pattern) => {
  let escaped = pattern
    .replaceAll('\\', '/')
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  if (escaped.endsWith(' .*')) escaped = `${escaped.slice(0, -3)}( .*)?`;
  return new RegExp(`^${escaped}$`, 's').test(input.replaceAll('\\', '/'));
};

const isStatement = (value) => isPlainObject(value) && isString(value.action) && isString(value.resource);

const isBoolean = (value) => value === true || value === false;

/** `ManagedPolicy.statements` for authored documents: reversed, so the user-global file decides last. */
export const readPolicyStatements = (entries) => (Array.isArray(entries) ? entries : [])
  .filter((entry) => entry?.type === 'document')
  .reverse()
  .flatMap((entry) => (Array.isArray(entry.info?.experimental?.policies) ? entry.info.experimental.policies : []))
  .filter(isStatement);

export const isIntegrationDenied = (statements, resource) => (
  statements.findLast((statement) => statement.action === 'integration.use' && matchesWildcard(resource, statement.resource))?.effect === 'deny'
);

const readList = (config, kind) => {
  const list = kind === 'policy' ? config?.experimental?.policies : config?.permissions;
  return Array.isArray(list) ? list : [];
};

const withList = (config, kind, list) => {
  const next = structuredClone(config ?? {});
  if (kind === 'permission') {
    if (list.length > 0) next.permissions = list;
    else delete next.permissions;
    return next;
  }
  const experimental = isPlainObject(next.experimental) ? next.experimental : {};
  if (list.length > 0) experimental.policies = list;
  else delete experimental.policies;
  if (Object.keys(experimental).length > 0) next.experimental = experimental;
  else delete next.experimental;
  return next;
};

const sameTarget = (statement, action, resource) => isStatement(statement) && statement.action === action && statement.resource === resource;

const configFileError = (message) => new OpenChamberControlError(`${message}. Fix the file by hand before changing it here`, 409);

const writableLayers = (layers) => [
  { file: layers.paths.userPath, config: layers.userConfig },
  layers.paths.userOverridePath ? { file: layers.paths.userOverridePath, config: layers.userOverrideConfig } : null,
  layers.paths.projectPath ? { file: layers.paths.projectPath, config: layers.projectConfig } : null,
].filter(Boolean);

const resolveWriteScope = (input) => {
  const scope = asNonEmptyString(input.configScope) || 'user';
  if (scope !== 'user' && scope !== 'project') {
    throw new OpenChamberControlError('configScope must be user or project for this action', 400);
  }
  return scope;
};

/** Puts `statement` last in the scope's file, replacing any statement for the same action and resource there. */
const addStatement = (directory, scope, kind, statement) => {
  if (scope === 'project' && !directory) throw new OpenChamberControlError('directory is required for the project config', 400);
  const layers = readConfigLayers(directory);
  const file = scope === 'project' ? layers.paths.projectPath : layers.paths.userPath;
  const failed = layers.layerErrors.find((entry) => entry.path === file);
  if (failed) throw configFileError(failed.message);
  const config = getConfigForPath(layers, file);
  const list = readList(config, kind);
  const last = list.at(-1);
  if (sameTarget(last, statement.action, statement.resource) && last.effect === statement.effect) {
    return { file, changed: false };
  }
  const next = [...list.filter((entry) => !sameTarget(entry, statement.action, statement.resource)), statement];
  writeConfig(withList(config, kind, next), file);
  return { file, changed: true };
};

/** Removes exact deny statements for action/resource from every file OpenChamber writes. */
const removeDenies = (directory, kind, action, resource) => {
  const layers = readConfigLayers(directory);
  const changed = [];
  const skipped = [];
  for (const { file, config } of writableLayers(layers)) {
    const failed = layers.layerErrors.find((entry) => entry.path === file);
    if (failed) {
      skipped.push({ file, reason: failed.message });
      continue;
    }
    const list = readList(config, kind);
    const next = list.filter((entry) => !(sameTarget(entry, action, resource) && entry.effect === 'deny'));
    if (next.length === list.length) continue;
    writeConfig(withList(config, kind, next), file);
    changed.push(file);
  }
  return { changed, skipped };
};

/** Deny statements still in any config file that match, including wildcards and agent rules. */
const remainingDenies = (directory, kind, matches) => {
  const layers = readConfigLayers(directory);
  const files = [
    [layers.paths.userPath, layers.userConfig],
    [layers.paths.userOverridePath, layers.userOverrideConfig],
    [layers.paths.projectPath, layers.projectConfig],
    [layers.paths.customPath, layers.customConfig],
  ].filter(([file]) => file);
  const found = [];
  for (const [file, config] of files) {
    for (const statement of readList(config, kind)) {
      if (isStatement(statement) && statement.effect === 'deny' && matches(statement)) found.push({ file, statement });
    }
    if (kind === 'permission' && isPlainObject(config?.agents)) {
      for (const [agent, agentConfig] of Object.entries(config.agents)) {
        for (const statement of Array.isArray(agentConfig?.permissions) ? agentConfig.permissions : []) {
          if (isStatement(statement) && statement.effect === 'deny' && matches(statement)) found.push({ file, agent, statement });
        }
      }
    }
  }
  return found;
};

const errorMessage = (error) => (error instanceof Error ? error.message : String(error));

// ---------------------------------------------------------------------------

export const createIntegrationActions = (deps) => {
  const { readSettingsFromDiskMigrated, persistSettings } = deps;

  const resolveDirectory = (input, ctx) => asNonEmptyString(input.directory) || asNonEmptyString(ctx?.contextDirectory) || null;

  // A failed read is reported as unknown, never as "nothing is blocked".
  const loadPolicies = async (client) => {
    try {
      return readPolicyStatements(await client.config.get());
    } catch {
      return null;
    }
  };

  const openClient = async (ctx, directory) => {
    try {
      return { client: await ctx.getClient(directory || ''), error: null };
    } catch (error) {
      return { client: null, error: errorMessage(error) };
    }
  };

  const requireDisabled = (input, action) => {
    if (!isBoolean(input.disabled)) throw new OpenChamberControlError(`disabled is required for ${action}`, 400);
    return input.disabled;
  };

  // ---- MCP

  const mcpList = async (input, ctx) => {
    const directory = resolveDirectory(input, ctx);
    let configs = [];
    let configError = null;
    try {
      configs = listMcpConfigs(directory);
    } catch (error) {
      configError = errorMessage(error);
    }
    const { client, error: clientError } = await openClient(ctx, directory);
    let runtime = null;
    let runtimeError = clientError;
    let policies = null;
    if (client) {
      try {
        const response = await client.mcp.list();
        runtime = new Map((Array.isArray(response?.data) ? response.data : []).map((server) => [server.name, server]));
      } catch (error) {
        runtimeError = errorMessage(error);
      }
      policies = await loadPolicies(client);
    }

    const names = [...new Set([...configs.map((entry) => entry.name), ...(runtime ? runtime.keys() : [])])].sort();
    const servers = names.map((name) => {
      const config = configs.find((entry) => entry.name === name) ?? null;
      const live = runtime?.get(name) ?? null;
      const server = {
        name,
        type: config?.type ?? null,
        inConfig: Boolean(config),
        enabled: config ? config.disabled !== true : null,
        configScope: config?.scope ?? null,
        status: runtime ? (live?.status?.status ?? 'not-loaded') : 'unknown',
        policyDenied: policies ? isIntegrationDenied(policies, `mcp:${name}`) : null,
        tools: null,
      };
      if (live?.status?.error) server.error = live.status.error;
      if (live?.integrationID) server.integrationID = live.integrationID;
      return server;
    });
    const result = { directory, servers, toolsNote: TOOLS_GAP_NOTE };
    if (configError) result.configError = configError;
    if (runtimeError) {
      result.runtimeError = runtimeError;
      result.note = 'Connection status could not be read from OpenCode; status is unknown';
    }
    if (client && !policies) result.policiesUnavailable = true;
    return result;
  };

  const mcpToggle = async (input, ctx) => {
    const name = asNonEmptyString(input.name);
    if (!name) throw new OpenChamberControlError('name is required for mcp.toggle', 400);
    const disabled = requireDisabled(input, 'mcp.toggle');
    const usePolicy = input.policy === true;
    const scope = resolveWriteScope(input);
    const directory = resolveDirectory(input, ctx);
    const resource = `mcp:${name}`;

    let configFile = null;
    let inConfig = true;
    try {
      configFile = updateMcpConfig(name, { disabled }, directory).path;
    } catch (error) {
      if (error?.code === 'INVALID_JSONC') throw configFileError(error.message);
      if (errorMessage(error) !== `MCP server "${name}" not found`) throw error;
      inConfig = false;
    }
    if (!inConfig && !usePolicy) {
      throw new OpenChamberControlError(`MCP server "${name}" is not in an editable OpenCode config file. mcp.list shows the configured ones; pass policy true to block or unblock it by policy instead`, 404);
    }

    let policyResult = null;
    if (usePolicy) {
      policyResult = disabled
        ? addStatement(directory, scope, 'policy', { action: 'integration.use', resource, effect: 'deny' })
        : removeDenies(directory, 'policy', 'integration.use', resource);
    }

    // The saved flag is what counts; OpenCode also reloads from the file, so
    // a refused runtime call is reported, not thrown.
    const runtime = { action: disabled ? 'disconnect' : 'connect', ok: false };
    const { client, error: clientError } = await openClient(ctx, directory);
    if (client) {
      try {
        await (disabled ? client.mcp.disconnect({ server: name }) : client.mcp.connect({ server: name }));
        runtime.ok = true;
      } catch (error) {
        runtime.error = errorMessage(error);
      }
    } else {
      runtime.error = clientError;
    }

    const stillDenied = !disabled
      ? remainingDenies(directory, 'policy', (statement) => statement.action === 'integration.use' && matchesWildcard(resource, statement.resource))
      : [];
    const result = { name, disabled, runtime };
    if (configFile) result.configFile = configFile;
    else result.inConfig = false;
    if (policyResult) result.policy = policyResult;
    if (stillDenied.length > 0) {
      result.stillDeniedBy = stillDenied;
      result.note = 'Other integration.use deny statements still match this server, so OpenCode keeps it blocked until they are changed';
    }
    return result;
  };

  // ---- Skills

  const skillIdFromPath = (skillPath) => (
    isString(skillPath) && skillPath.endsWith('SKILL.md') ? path.basename(path.dirname(skillPath)) : null
  );

  const collectSkills = async (directory, ctx) => {
    const { client, error: clientError } = await openClient(ctx, directory);
    let loaded = null;
    let loadError = clientError;
    let policies = null;
    if (client) {
      try {
        const response = await client.skill.list();
        loaded = Array.isArray(response?.data) ? response.data : null;
        if (!loaded) loadError = 'OpenCode answered without a skill list';
      } catch (error) {
        loadError = errorMessage(error);
      }
      policies = await loadPolicies(client);
    }
    const disk = await discoverSkills(directory);

    const skills = [];
    const seen = new Set();
    for (const item of loaded ?? []) {
      const name = asNonEmptyString(item?.name);
      if (!name || seen.has(name)) continue;
      seen.add(name);
      const builtIn = isString(item.path) && item.path.startsWith('/builtin/');
      const local = disk.find((skill) => skill.name === name);
      skills.push({
        id: asNonEmptyString(item.id) || skillIdFromPath(item.path) || name,
        name,
        description: item.description ?? '',
        path: builtIn ? '<built-in>' : item.path,
        scope: local?.scope ?? null,
        source: local?.source ?? (builtIn ? 'opencode' : null),
        builtIn,
        loadedByOpenCode: true,
        autoInvoke: item.autoinvoke !== false,
      });
    }
    // On disk but not in OpenCode's list: blocked by policy, from a source
    // OpenCode does not read, or OpenCode could not be asked.
    for (const skill of disk) {
      if (seen.has(skill.name)) continue;
      seen.add(skill.name);
      const sources = await getSkillSources(skill.name, directory, skill, { includeSupportingFiles: false }).catch(() => null);
      skills.push({
        id: skillIdFromPath(skill.path) || skill.name,
        name: skill.name,
        description: skill.description ?? '',
        path: skill.path,
        scope: skill.scope ?? null,
        source: skill.source ?? null,
        builtIn: false,
        loadedByOpenCode: loaded ? false : null,
        autoInvoke: sources ? sources.md.disableModelInvocation !== true : null,
      });
    }
    for (const skill of skills) {
      skill.policyDenied = policies ? isIntegrationDenied(policies, `skill:${skill.id}`) : null;
    }
    return { skills, loadError, policiesUnavailable: Boolean(client) && !policies };
  };

  const skillsList = async (input, ctx) => {
    const directory = resolveDirectory(input, ctx);
    const { skills, loadError, policiesUnavailable } = await collectSkills(directory, ctx);
    const result = { directory, skills };
    if (loadError) {
      result.openCodeSkillsUnavailable = true;
      result.error = loadError;
      result.note = 'Only the disk scan is shown: built-in skills are missing and loadedByOpenCode is unknown';
    }
    if (policiesUnavailable) result.policiesUnavailable = true;
    return result;
  };

  const skillsToggle = async (input, ctx) => {
    const requested = asNonEmptyString(input.name);
    if (!requested) throw new OpenChamberControlError('name is required for skills.toggle', 400);
    const hasDisabled = isBoolean(input.disabled);
    const hasAutoInvoke = isBoolean(input.autoInvoke);
    if (!hasDisabled && !hasAutoInvoke) throw new OpenChamberControlError('skills.toggle needs disabled or autoInvoke (booleans)', 400);
    const scope = resolveWriteScope(input);
    const directory = resolveDirectory(input, ctx);

    const { skills } = await collectSkills(directory, ctx);
    const skill = skills.find((entry) => entry.name === requested) ?? skills.find((entry) => entry.id === requested) ?? null;
    if (!skill && (hasAutoInvoke || input.disabled === true)) {
      throw new OpenChamberControlError(`Skill not found: ${requested}. skills.list shows the skills here`, 404);
    }
    const id = skill?.id ?? requested;
    const result = { name: skill?.name ?? requested, id };

    if (hasAutoInvoke) {
      if (skill.builtIn) throw new OpenChamberControlError(`${skill.name} is built into OpenCode; its autoInvoke cannot be changed`, 409);
      await updateSkill(skill.name, { disableModelInvocation: !input.autoInvoke }, directory, skill.path);
      result.autoInvoke = input.autoInvoke;
      result.skillFile = skill.path;
    }
    if (hasDisabled) {
      const resource = `skill:${id}`;
      if (input.disabled) {
        result.policy = addStatement(directory, scope, 'policy', { action: 'integration.use', resource, effect: 'deny' });
      } else {
        result.policy = removeDenies(directory, 'policy', 'integration.use', resource);
        const stillDenied = remainingDenies(directory, 'policy', (statement) => statement.action === 'integration.use' && matchesWildcard(resource, statement.resource));
        if (stillDenied.length > 0) {
          result.stillDeniedBy = stillDenied;
          result.note = 'Other integration.use deny statements still match this skill, so OpenCode keeps it blocked until they are changed';
        }
      }
      result.disabled = input.disabled;
    }
    result.note ??= 'OpenCode picks this up within seconds; skills.list shows the result';
    return result;
  };

  // ---- Tools

  const systemToolState = (settings) => SYSTEM_TOOLS
    .filter((entry) => !entry.available || entry.available())
    .map(({ tool, settingKey, defaultEnabled, description }) => ({
      tool,
      settingKey,
      description,
      enabled: isBoolean(settings?.[settingKey]) ? settings[settingKey] : defaultEnabled,
    }));

  const toolsList = async (input, ctx) => {
    const directory = resolveDirectory(input, ctx);
    const settings = await readSettingsFromDiskMigrated();
    let disabledByConfig = null;
    let configError = null;
    try {
      disabledByConfig = remainingDenies(directory, 'permission', (statement) => statement.resource === '*')
        .map(({ file, agent, statement }) => {
          const entry = { tool: statement.action, file };
          if (agent) entry.agent = agent;
          return entry;
        });
    } catch (error) {
      configError = errorMessage(error);
    }
    const result = {
      openchamber: systemToolState(settings),
      openchamberNote: 'These follow OpenChamber settings and exist only while OpenChamber runs the OpenCode server',
      opencodeBuiltin: OPENCODE_BUILTIN_TOOLS,
      opencodeBuiltinNote: 'Built-in names of OpenCode 2.0.26; another OpenCode version may differ. execute is Code Mode, which reaches MCP tools',
      disabledByConfig,
      mcpToolsNote: TOOLS_GAP_NOTE,
    };
    if (configError) result.configError = configError;
    return result;
  };

  const toolsToggle = async (input, ctx) => {
    const toolName = asNonEmptyString(input.toolName);
    if (!toolName) throw new OpenChamberControlError('toolName is required for tools.toggle', 400);
    const disabled = requireDisabled(input, 'tools.toggle');

    const system = SYSTEM_TOOLS.find((entry) => entry.tool === toolName);
    if (system) {
      if (system.available && !system.available()) {
        throw new OpenChamberControlError(`${toolName} is not available in this build`, 409);
      }
      if (disabled && system.settingKey === 'agentControlToolEnabled' && input.confirm !== true) {
        throw new OpenChamberControlError('Turning off the openchamber tool removes this tool, including this action; repeat with confirm true only if the user explicitly asked for it', 400);
      }
      const saved = await persistSettings({ [system.settingKey]: !disabled });
      return {
        tool: toolName,
        settingKey: system.settingKey,
        enabled: isBoolean(saved?.[system.settingKey]) ? saved[system.settingKey] : !disabled,
        note: 'OpenCode picks this up within a few seconds; the tool appears or disappears for new turns',
      };
    }

    if (toolName.length > 200 || !/^[A-Za-z0-9_.:*?-]+$/.test(toolName)) {
      throw new OpenChamberControlError('toolName may hold letters, digits, _ - . : and the wildcards * and ?', 400);
    }
    if (disabled && matchesWildcard('openchamber', toolName) && input.confirm !== true) {
      throw new OpenChamberControlError(`${toolName} also matches the openchamber tool, so it would remove this tool; repeat with confirm true only if the user explicitly asked for it`, 400);
    }
    const scope = resolveWriteScope(input);
    const directory = resolveDirectory(input, ctx);
    const rule = { action: toolName, resource: '*', effect: 'deny' };
    if (disabled) {
      const written = addStatement(directory, scope, 'permission', rule);
      return {
        tool: toolName,
        disabled: true,
        ...written,
        rule,
        note: 'Agents lose this tool from their next step on, once OpenCode reloads its config (a few seconds). An agent whose own permissions allow it again keeps it',
      };
    }
    const removed = removeDenies(directory, 'permission', toolName, '*');
    const stillDenied = remainingDenies(directory, 'permission', (statement) => statement.resource === '*' && matchesWildcard(toolName, statement.action));
    return {
      tool: toolName,
      disabled: false,
      ...removed,
      ...(stillDenied.length > 0
        ? { stillDeniedBy: stillDenied, note: 'Other permission rules still turn this tool off; change them to bring it back' }
        : { note: 'Agents get this tool back once OpenCode reloads its config (a few seconds)' }),
    };
  };

  const execute = async (action, input = {}, ctx = {}) => {
    try {
      switch (action) {
        case 'mcp.list': return await mcpList(input, ctx);
        case 'mcp.toggle': return await mcpToggle(input, ctx);
        case 'skills.list': return await skillsList(input, ctx);
        case 'skills.toggle': return await skillsToggle(input, ctx);
        case 'tools.list': return await toolsList(input, ctx);
        case 'tools.toggle': return await toolsToggle(input, ctx);
        default: throw new OpenChamberControlError(`Unsupported integration action: ${action || 'missing'}`, 400);
      }
    } catch (error) {
      if (error?.code === 'INVALID_JSONC') throw configFileError(error.message);
      throw error;
    }
  };

  return { actions: INTEGRATION_ACTIONS, execute };
};
