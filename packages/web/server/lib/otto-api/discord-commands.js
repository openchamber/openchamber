/**
 * Native Discord application (slash) command registration for the Otto bot.
 *
 * Without registering these, typing `/model` in Discord just sends literal text
 * and the interactive wizards (which fire on APPLICATION_COMMAND interactions)
 * never run. We register the full set against the bot's application on every
 * gateway READY so a fresh bot — or a bot that gained a new command after an
 * update — works out of the box with autocomplete suggestions and dropdowns.
 *
 * Registration is guild-scoped when a guildId is known (instant propagation),
 * otherwise global (can take up to an hour to appear). Both are idempotent:
 * Discord upserts by name, so re-registering on each connect is safe.
 */

const STRING_OPTION = 3;

/**
 * The canonical Otto slash command set. Descriptions are kept ≤ 100 chars
 * (Discord's hard limit). Commands backed by an interactive wizard
 * (`model`, `agent`, `verbosity`, `skill`) take no options — the dropdowns
 * collect everything. The rest map straight onto the text command pipeline.
 */
export function buildSlashCommandDefinitions() {
  return [
    { name: 'help', description: 'List Otto messenger commands' },
    { name: 'status', description: 'Show the session, project, model and agent for this conversation' },
    { name: 'abort', description: 'Stop the current OpenCode turn' },
    { name: 'new', description: 'Drop the current session and start fresh on the next message' },
    { name: 'undo', description: 'Revert one user message' },
    { name: 'redo', description: 'Step forward through undo' },
    { name: 'compact', description: 'Summarise + compact the session history (destructive)' },
    {
      name: 'summary',
      description: 'Write a non-destructive summary of the session',
      options: [
        { type: STRING_OPTION, name: 'topic', description: 'Optional topic to focus the summary on', required: false },
      ],
    },
    { name: 'init', description: 'Run OpenCode init (creates/updates AGENTS.md)' },
    { name: 'review', description: 'Run the OpenCode review workflow' },
    {
      name: 'shell',
      description: 'Run a shell command in the project and show its output',
      options: [
        { type: STRING_OPTION, name: 'command', description: 'The shell command to run (e.g. pwd)', required: true },
      ],
    },
    { name: 'model', description: 'Pick the model + thinking effort (this chat, project, or everywhere)' },
    { name: 'agent', description: 'Pick the agent for this conversation (or set a project default)' },
    { name: 'verbosity', description: 'Choose how much Otto streams back (this chat, project, or everywhere)' },
    { name: 'yolo', description: 'Set tool permission mode: ask / auto-approve edits / auto-approve all' },
    { name: 'skill', description: 'Pick an available skill and hand it to the agent' },
    { name: 'sessions', description: 'List recent OpenCode sessions for this project' },
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
    {
      name: 'fork',
      description: 'Branch the session from an earlier user message',
      options: [
        { type: STRING_OPTION, name: 'message', description: 'List number from /fork (leave empty to list)', required: false },
      ],
    },
    { name: 'share', description: 'Generate a public URL for the current session' },
    { name: 'unshare', description: 'Revoke the public URL for the current session' },
    {
      name: 'queue',
      description: 'Queue a message to send after the current response finishes',
      options: [
        { type: STRING_OPTION, name: 'message', description: 'The message to queue', required: true },
      ],
    },
    { name: 'clear-queue', description: 'Clear all queued messages for this conversation' },
    { name: 'mention-mode', description: 'Toggle mention-only mode for this channel' },
    {
      name: 'new-worktree',
      description: 'Create an isolated git worktree and work there in a new thread',
      options: [
        { type: STRING_OPTION, name: 'name', description: 'Worktree name (derived automatically when omitted)', required: false },
      ],
    },
    { name: 'merge-worktree', description: 'Squash-merge this worktree into the default branch' },
    { name: 'list-worktrees', description: 'List git worktrees for this project with Discord thread links' },
    {
      name: 'open-worktree',
      description: 'Open an existing worktree in its Discord thread',
      options: [
        { type: STRING_OPTION, name: 'branch', description: 'Branch or worktree name', required: true },
      ],
    },
    { name: 'worktree-status', description: 'Show git status for the worktree in this conversation' },
    {
      name: 'schedule',
      description: 'Schedule a prompt: UTC ISO date or cron — list / delete <id> to manage',
      options: [
        { type: STRING_OPTION, name: 'args', description: '<when> [model=p/m] [agent=name] <prompt> | list | delete <id>', required: false },
      ],
    },
  ].map((c) => ({ type: 1, ...c }));
}

/**
 * Register the Otto slash commands against a bot application.
 *
 * @param {object} args
 * @param {(token, method, path, body) => Promise<{ok:boolean,status:number,body:any}>} args.restCall
 * @param {string} args.token        bot token
 * @param {string} args.applicationId  bot application id (equals the bot user id)
 * @param {string|null} [args.guildId]  register guild-scoped when set (instant)
 * @returns {Promise<{ ok: boolean, scope: 'guild'|'global', status?: number, error?: string }>}
 */
export async function registerApplicationCommands({ restCall, token, applicationId, guildId = null }) {
  if (!applicationId) return { ok: false, scope: 'global', error: 'no application id' };
  const commands = buildSlashCommandDefinitions();
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
    return { ok: true, scope, status: r.status };
  } catch (err) {
    return { ok: false, scope, error: err?.message ?? 'registration failed' };
  }
}
