/**
 * Native Discord application (slash) command registration for the OpenChamber agent bot.
 *
 * Without registering these, typing `/model` in Discord just sends literal text
 * and the interactive wizards (which fire on APPLICATION_COMMAND interactions)
 * never run. We register the core set against the bot's application on every
 * gateway READY so a fresh bot — or a bot that gained a new command after an
 * update — works out of the box with autocomplete suggestions and dropdowns.
 *
 * Broader messenger text commands remain available via plain messages and
 * `/help all`. Keeping the Discord slash surface small preserves room under
 * Discord's 100-command hard limit for optional dynamic OpenCode `-cmd` /
 * `-skill` registration.
 *
 * Registration is guild-scoped when a guildId is known (instant propagation),
 * otherwise global (can take up to an hour to appear). Both are idempotent:
 * Discord upserts by name, so re-registering on each connect is safe.
 */

const STRING_OPTION = 3;
export const DISCORD_APPLICATION_COMMAND_LIMIT = 100;

function clipDescription(value, fallback) {
  const text = String(value ?? '').trim() || fallback;
  return text.slice(0, 100);
}

export function sanitizeDiscordCommandName(name, suffix = '') {
  const suffixText = String(suffix ?? '').trim().toLowerCase();
  const maxBaseLength = Math.max(1, 32 - suffixText.length);
  const base = String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, maxBaseLength)
    .replace(/^[-_]+|[-_]+$/g, '');
  if (!base) return null;
  const full = `${base}${suffixText}`;
  return /^[a-z0-9_-]{1,32}$/.test(full) ? full : null;
}

/**
 * Core Discord slash commands only. Text-prefix commands beyond this set still
 * work through the messenger command pipeline; they are intentionally not
 * registered as native Discord application commands.
 *
 * Wizard-backed commands (`model`, `agent`, `verbosity`, `skill`, `yolo`,
 * `permissions`, `login`) take no options — dropdowns collect everything.
 */
export function buildSlashCommandDefinitions() {
  return [
    { name: 'help', description: 'List Discord slash commands (/help all for every text command)' },
    { name: 'status', description: 'Show the session, project, model and agent for this conversation' },
    { name: 'abort', description: 'Stop the current OpenCode turn' },
    { name: 'new', description: 'Drop the current session and start fresh on the next message' },
    { name: 'undo', description: 'Revert one user message' },
    { name: 'redo', description: 'Step forward through undo' },
    { name: 'model', description: 'Pick the model + thinking effort (this chat, project, or everywhere)' },
    { name: 'agent', description: 'Pick the agent for this conversation (or set a project default)' },
    { name: 'verbosity', description: 'Choose how much OpenChamber agent streams back' },
    { name: 'yolo', description: 'Set tool permission mode: always ask / non-destructive / allow all' },
    { name: 'permissions', description: 'Synonym for /yolo — set tool permission mode' },
    { name: 'skill', description: 'Pick an available skill and hand it to the agent' },
    { name: 'login', description: 'Start OpenCode provider auth (OAuth link or API-key guidance)' },
    {
      name: 'session',
      description: 'Start a new OpenCode session (and thread) with a prompt',
      options: [
        { type: STRING_OPTION, name: 'prompt', description: 'The task description for the AI', required: true },
      ],
    },
    {
      name: 'resume',
      description: 'Resume a previous session in a new thread',
      options: [
        { type: STRING_OPTION, name: 'session', description: 'List number or session id (leave empty to list)', required: false },
      ],
    },
    { name: 'fork', description: 'Branch this session from your last message' },
    {
      name: 'queue',
      description: 'Queue a message to send after the current response finishes',
      options: [
        { type: STRING_OPTION, name: 'message', description: 'The message to queue', required: true },
      ],
    },
    {
      name: 'clear-queue',
      description: 'Clear all queued messages or one queued position',
      options: [
        { type: STRING_OPTION, name: 'position', description: 'Optional queue position to clear', required: false },
      ],
    },
    { name: 'mention-mode', description: 'Toggle mention-only mode for this channel' },
    { name: 'diff', description: 'Show a reviewable git diff for this project/worktree' },
    { name: 'usage', description: 'Show estimated token usage for this session' },
    { name: 'credits', description: 'Alias for /usage — show session usage' },
    {
      name: 'shell',
      description: 'Run a shell command in the project and show its output',
      options: [
        { type: STRING_OPTION, name: 'command', description: 'The shell command to run (e.g. pwd)', required: true },
      ],
    },
    {
      name: 'new-worktree',
      description: 'Create an isolated git worktree and work there in a new thread',
      options: [
        { type: STRING_OPTION, name: 'name', description: 'Worktree name (derived automatically when omitted)', required: false },
      ],
    },
    { name: 'merge-worktree', description: 'Squash-merge this worktree into the default branch' },
    { name: 'share', description: 'Generate a public URL for the current session' },
    {
      name: 'schedule',
      description: 'Schedule a prompt: UTC ISO date or cron — list / delete <id> to manage',
      options: [
        { type: STRING_OPTION, name: 'args', description: '<when> [model=p/m] [agent=name] <prompt> | list | delete <id>', required: false },
      ],
    },
    { name: 'reload-opencode', description: 'Reload/reconnect OpenChamber-managed OpenCode (not an external process kill)' },
  ].map((c) => ({ type: 1, ...c }));
}

export function buildDynamicSlashCommandDefinitions({
  commands = [],
  skills = [],
  existingNames = new Set(),
  remaining = DISCORD_APPLICATION_COMMAND_LIMIT,
} = {}) {
  const defs = [];
  const map = new Map();
  const used = new Set(existingNames);

  const add = ({ source, kind, suffix, description }) => {
    if (defs.length >= remaining) return;
    const originalName = typeof source?.name === 'string' ? source.name.trim() : '';
    if (!originalName) return;
    const name = sanitizeDiscordCommandName(originalName, suffix);
    if (!name || used.has(name)) return;
    used.add(name);
    defs.push({
      type: 1,
      name,
      description: clipDescription(source.description, description),
      ...(kind === 'cmd'
        ? {
            options: [
              { type: STRING_OPTION, name: 'args', description: 'Optional arguments for the OpenCode command', required: false },
            ],
          }
        : {}),
    });
    map.set(name, { kind, name: originalName });
  };

  for (const command of commands) {
    if (command?.source === 'skill') continue;
    add({
      source: command,
      kind: 'cmd',
      suffix: '-cmd',
      description: 'Run this OpenCode command in the current session',
    });
  }
  for (const skill of skills) {
    add({
      source: skill,
      kind: 'skill',
      suffix: '-skill',
      description: 'Hand this skill to OpenChamber agent',
    });
  }

  return { definitions: defs, commandMap: map };
}

export function buildApplicationCommandRegistration({ dynamic = null } = {}) {
  const builtIns = buildSlashCommandDefinitions();
  const existingNames = new Set(builtIns.map((command) => command.name));
  const remaining = Math.max(0, DISCORD_APPLICATION_COMMAND_LIMIT - builtIns.length);
  const includeDynamic = Boolean(dynamic) && dynamic.enabled !== false;
  const dynamicBuilt = includeDynamic
    ? buildDynamicSlashCommandDefinitions({
        commands: dynamic.commands ?? [],
        skills: dynamic.skills ?? [],
        existingNames,
        remaining,
      })
    : { definitions: [], commandMap: new Map() };
  const commands = [...builtIns, ...dynamicBuilt.definitions].slice(0, DISCORD_APPLICATION_COMMAND_LIMIT);
  return { commands, dynamicCommandMap: dynamicBuilt.commandMap };
}

/**
 * Register the OpenChamber agent slash commands against a bot application.
 *
 * @param {object} args
 * @param {(token, method, path, body) => Promise<{ok:boolean,status:number,body:any}>} args.restCall
 * @param {string} args.token        bot token
 * @param {string} args.applicationId  bot application id (equals the bot user id)
 * @param {string|null} [args.guildId]  register guild-scoped when set (instant)
 * @param {object|null} [args.dynamic]  optional `{ enabled, commands, skills }` for -cmd/-skill
 * @returns {Promise<{ ok: boolean, scope: 'guild'|'global', status?: number, error?: string }>}
 */
export async function registerApplicationCommands({ restCall, token, applicationId, guildId = null, dynamic = null }) {
  if (!applicationId) return { ok: false, scope: 'global', error: 'no application id' };
  const { commands, dynamicCommandMap } = buildApplicationCommandRegistration({ dynamic });
  const scope = guildId ? 'guild' : 'global';
  const path = guildId
    ? `/applications/${encodeURIComponent(applicationId)}/guilds/${encodeURIComponent(guildId)}/commands`
    : `/applications/${encodeURIComponent(applicationId)}/commands`;
  try {
    const r = await restCall(token, 'PUT', path, commands);
    if (!r.ok) {
      return {
        ok: false,
        scope,
        status: r.status,
        error: typeof r.body === 'string' ? r.body.slice(0, 300) : `HTTP ${r.status}`,
      };
    }
    return { ok: true, scope, status: r.status, dynamicCommandMap, commandCount: commands.length };
  } catch (err) {
    return { ok: false, scope, error: err?.message ?? 'registration failed' };
  }
}
