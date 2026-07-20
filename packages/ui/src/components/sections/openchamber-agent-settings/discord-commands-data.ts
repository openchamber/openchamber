export type DiscordCommandCategory =
  | 'chat'
  | 'project'
  | 'model'
  | 'shell'
  | 'git'
  | 'mcp'
  | 'queue'
  | 'ops'
  | 'sharing';

export type DiscordCommandEntry = {
  name: string;
  descriptionKey: string;
  category: DiscordCommandCategory;
  /** Shown as a suggested native Discord slash command in the palette. */
  suggested?: boolean;
  /** True when also registered as a Discord application (slash) command. */
  nativeSlash?: boolean;
  example?: string;
};

/**
 * Messenger command reference for Settings.
 * `nativeSlash: true` mirrors the slim Discord slash set in
 * `packages/web/server/lib/messenger/discord-commands.js`. Other entries remain
 * available as text / `!` commands via `/help`.
 */
export const DISCORD_COMMANDS: DiscordCommandEntry[] = [
  { name: 'help', descriptionKey: 'settings.integrations.discord.commands.desc.help', category: 'chat', nativeSlash: true },
  { name: 'status', descriptionKey: 'settings.integrations.discord.commands.desc.status', category: 'chat', suggested: true, nativeSlash: true },
  { name: 'new', descriptionKey: 'settings.integrations.discord.commands.desc.new', category: 'chat', nativeSlash: true },
  { name: 'abort', descriptionKey: 'settings.integrations.discord.commands.desc.abort', category: 'chat', suggested: true, nativeSlash: true },
  { name: 'undo', descriptionKey: 'settings.integrations.discord.commands.desc.undo', category: 'chat', nativeSlash: true },
  { name: 'redo', descriptionKey: 'settings.integrations.discord.commands.desc.redo', category: 'chat', nativeSlash: true },
  { name: 'compact', descriptionKey: 'settings.integrations.discord.commands.desc.compact', category: 'chat' },
  { name: 'summary', descriptionKey: 'settings.integrations.discord.commands.desc.summary', category: 'chat' },
  {
    name: 'session',
    descriptionKey: 'settings.integrations.discord.commands.desc.session',
    category: 'chat',
    suggested: true,
    nativeSlash: true,
    example: '/session prompt:Fix the login form validation',
  },
  { name: 'resume', descriptionKey: 'settings.integrations.discord.commands.desc.resume', category: 'chat', nativeSlash: true },
  { name: 'fork', descriptionKey: 'settings.integrations.discord.commands.desc.fork', category: 'chat', nativeSlash: true },
  { name: 'btw', descriptionKey: 'settings.integrations.discord.commands.desc.btw', category: 'chat', suggested: true, nativeSlash: true },
  { name: 'sessions', descriptionKey: 'settings.integrations.discord.commands.desc.sessions', category: 'chat' },
  { name: 'usage', descriptionKey: 'settings.integrations.discord.commands.desc.usage', category: 'chat', suggested: true, nativeSlash: true },
  { name: 'credits', descriptionKey: 'settings.integrations.discord.commands.desc.credits', category: 'chat', nativeSlash: true },
  { name: 'add-project', descriptionKey: 'settings.integrations.discord.commands.desc.addProject', category: 'project', suggested: true },
  { name: 'create-new-project', descriptionKey: 'settings.integrations.discord.commands.desc.createNewProject', category: 'project' },
  { name: 'remove-project', descriptionKey: 'settings.integrations.discord.commands.desc.removeProject', category: 'project' },
  { name: 'model', descriptionKey: 'settings.integrations.discord.commands.desc.model', category: 'model', suggested: true, nativeSlash: true },
  { name: 'agent', descriptionKey: 'settings.integrations.discord.commands.desc.agent', category: 'model', nativeSlash: true },
  { name: 'login', descriptionKey: 'settings.integrations.discord.commands.desc.login', category: 'model', suggested: true, nativeSlash: true },
  { name: 'verbosity', descriptionKey: 'settings.integrations.discord.commands.desc.verbosity', category: 'model', nativeSlash: true },
  { name: 'skill', descriptionKey: 'settings.integrations.discord.commands.desc.skill', category: 'model', nativeSlash: true },
  { name: 'yolo', descriptionKey: 'settings.integrations.discord.commands.desc.yolo', category: 'model', suggested: true, nativeSlash: true },
  {
    name: 'permissions',
    descriptionKey: 'settings.integrations.discord.commands.desc.permissions',
    category: 'model',
    nativeSlash: true,
  },
  { name: 'shell', descriptionKey: 'settings.integrations.discord.commands.desc.shell', category: 'shell', example: '/shell command:pwd', nativeSlash: true },
  { name: 'tunnel', descriptionKey: 'settings.integrations.discord.commands.desc.tunnel', category: 'shell', example: '/tunnel cloudflare quick' },
  { name: 'init', descriptionKey: 'settings.integrations.discord.commands.desc.init', category: 'shell' },
  { name: 'review', descriptionKey: 'settings.integrations.discord.commands.desc.review', category: 'shell' },
  { name: 'diff', descriptionKey: 'settings.integrations.discord.commands.desc.diff', category: 'git', suggested: true, nativeSlash: true },
  { name: 'new-worktree', descriptionKey: 'settings.integrations.discord.commands.desc.newWorktree', category: 'git', nativeSlash: true },
  { name: 'worktrees', descriptionKey: 'settings.integrations.discord.commands.desc.worktrees', category: 'git' },
  { name: 'toggle-worktrees', descriptionKey: 'settings.integrations.discord.commands.desc.toggleWorktrees', category: 'git' },
  { name: 'merge-worktree', descriptionKey: 'settings.integrations.discord.commands.desc.mergeWorktree', category: 'git', nativeSlash: true },
  { name: 'mcp', descriptionKey: 'settings.integrations.discord.commands.desc.mcp', category: 'mcp' },
  { name: 'queue', descriptionKey: 'settings.integrations.discord.commands.desc.queue', category: 'queue', nativeSlash: true },
  { name: 'queue-command', descriptionKey: 'settings.integrations.discord.commands.desc.queueCommand', category: 'queue' },
  { name: 'clear-queue', descriptionKey: 'settings.integrations.discord.commands.desc.clearQueue', category: 'queue', nativeSlash: true },
  { name: 'mention-mode', descriptionKey: 'settings.integrations.discord.commands.desc.mentionMode', category: 'queue', nativeSlash: true },
  { name: 'context-usage', descriptionKey: 'settings.integrations.discord.commands.desc.contextUsage', category: 'ops', suggested: true },
  { name: 'session-id', descriptionKey: 'settings.integrations.discord.commands.desc.sessionId', category: 'ops' },
  { name: 'reload-opencode', descriptionKey: 'settings.integrations.discord.commands.desc.reloadOpencode', category: 'ops', nativeSlash: true },
  { name: 'share', descriptionKey: 'settings.integrations.discord.commands.desc.share', category: 'sharing', nativeSlash: true },
  { name: 'unshare', descriptionKey: 'settings.integrations.discord.commands.desc.unshare', category: 'sharing' },
  {
    name: 'schedule',
    descriptionKey: 'settings.integrations.discord.commands.desc.schedule',
    category: 'sharing',
    suggested: true,
    nativeSlash: true,
    example: '/schedule 0 9 * * 1 Weekly standup report',
  },
];

export const DISCORD_COMMAND_CATEGORY_ORDER: DiscordCommandCategory[] = [
  'chat',
  'project',
  'model',
  'shell',
  'git',
  'mcp',
  'queue',
  'ops',
  'sharing',
];
