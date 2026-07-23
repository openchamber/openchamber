export type DiscordCommandCategory =
  | 'chat'
  | 'model'
  | 'shell'
  | 'git'
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
 * Discord slash-command reference for Settings.
 * Keep this list in lockstep with `buildSlashCommandDefinitions()` in
 * `packages/web/server/lib/messenger/discord-commands.js`. Text-only messenger
 * commands are intentionally omitted here — they remain available in chat and
 * via `/help all`.
 */
export const DISCORD_COMMANDS: DiscordCommandEntry[] = [
  { name: 'help', descriptionKey: 'settings.integrations.discord.commands.desc.help', category: 'chat', nativeSlash: true },
  { name: 'status', descriptionKey: 'settings.integrations.discord.commands.desc.status', category: 'chat', suggested: true, nativeSlash: true },
  { name: 'abort', descriptionKey: 'settings.integrations.discord.commands.desc.abort', category: 'chat', suggested: true, nativeSlash: true },
  { name: 'new', descriptionKey: 'settings.integrations.discord.commands.desc.new', category: 'chat', nativeSlash: true },
  { name: 'undo', descriptionKey: 'settings.integrations.discord.commands.desc.undo', category: 'chat', nativeSlash: true },
  { name: 'redo', descriptionKey: 'settings.integrations.discord.commands.desc.redo', category: 'chat', nativeSlash: true },
  { name: 'model', descriptionKey: 'settings.integrations.discord.commands.desc.model', category: 'model', suggested: true, nativeSlash: true },
  { name: 'agent', descriptionKey: 'settings.integrations.discord.commands.desc.agent', category: 'model', nativeSlash: true },
  { name: 'verbosity', descriptionKey: 'settings.integrations.discord.commands.desc.verbosity', category: 'model', nativeSlash: true },
  { name: 'yolo', descriptionKey: 'settings.integrations.discord.commands.desc.yolo', category: 'model', suggested: true, nativeSlash: true },
  {
    name: 'permissions',
    descriptionKey: 'settings.integrations.discord.commands.desc.permissions',
    category: 'model',
    nativeSlash: true,
  },
  { name: 'skill', descriptionKey: 'settings.integrations.discord.commands.desc.skill', category: 'model', nativeSlash: true },
  { name: 'login', descriptionKey: 'settings.integrations.discord.commands.desc.login', category: 'model', suggested: true, nativeSlash: true },
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
  { name: 'queue', descriptionKey: 'settings.integrations.discord.commands.desc.queue', category: 'queue', nativeSlash: true },
  { name: 'clear-queue', descriptionKey: 'settings.integrations.discord.commands.desc.clearQueue', category: 'queue', nativeSlash: true },
  { name: 'mention-mode', descriptionKey: 'settings.integrations.discord.commands.desc.mentionMode', category: 'queue', nativeSlash: true },
  { name: 'diff', descriptionKey: 'settings.integrations.discord.commands.desc.diff', category: 'git', suggested: true, nativeSlash: true },
  { name: 'usage', descriptionKey: 'settings.integrations.discord.commands.desc.usage', category: 'chat', suggested: true, nativeSlash: true },
  { name: 'credits', descriptionKey: 'settings.integrations.discord.commands.desc.credits', category: 'chat', nativeSlash: true },
  { name: 'shell', descriptionKey: 'settings.integrations.discord.commands.desc.shell', category: 'shell', example: '/shell command:pwd', nativeSlash: true },
  { name: 'new-worktree', descriptionKey: 'settings.integrations.discord.commands.desc.newWorktree', category: 'git', nativeSlash: true },
  { name: 'merge-worktree', descriptionKey: 'settings.integrations.discord.commands.desc.mergeWorktree', category: 'git', nativeSlash: true },
  { name: 'share', descriptionKey: 'settings.integrations.discord.commands.desc.share', category: 'sharing', nativeSlash: true },
  {
    name: 'schedule',
    descriptionKey: 'settings.integrations.discord.commands.desc.schedule',
    category: 'sharing',
    suggested: true,
    nativeSlash: true,
    example: '/schedule 0 9 * * 1 Weekly standup report',
  },
  { name: 'reload-opencode', descriptionKey: 'settings.integrations.discord.commands.desc.reloadOpencode', category: 'ops', nativeSlash: true },
];

export const DISCORD_COMMAND_CATEGORY_ORDER: DiscordCommandCategory[] = [
  'chat',
  'model',
  'shell',
  'git',
  'queue',
  'ops',
  'sharing',
];
