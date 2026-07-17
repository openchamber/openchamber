export type DiscordCommandCategory =
  | 'chat'
  | 'model'
  | 'shell'
  | 'git'
  | 'queue'
  | 'sharing';

export type DiscordCommandEntry = {
  name: string;
  descriptionKey: string;
  category: DiscordCommandCategory;
  suggested?: boolean;
  example?: string;
};

/** Static Discord slash-command reference mirrored from server-side discord-commands.js */
export const DISCORD_COMMANDS: DiscordCommandEntry[] = [
  { name: 'help', descriptionKey: 'settings.integrations.discord.commands.desc.help', category: 'chat' },
  { name: 'status', descriptionKey: 'settings.integrations.discord.commands.desc.status', category: 'chat', suggested: true },
  { name: 'new', descriptionKey: 'settings.integrations.discord.commands.desc.new', category: 'chat' },
  { name: 'abort', descriptionKey: 'settings.integrations.discord.commands.desc.abort', category: 'chat', suggested: true },
  { name: 'undo', descriptionKey: 'settings.integrations.discord.commands.desc.undo', category: 'chat' },
  { name: 'redo', descriptionKey: 'settings.integrations.discord.commands.desc.redo', category: 'chat' },
  { name: 'compact', descriptionKey: 'settings.integrations.discord.commands.desc.compact', category: 'chat' },
  { name: 'summary', descriptionKey: 'settings.integrations.discord.commands.desc.summary', category: 'chat' },
  {
    name: 'session',
    descriptionKey: 'settings.integrations.discord.commands.desc.session',
    category: 'chat',
    suggested: true,
    example: '/session prompt:Fix the login form validation',
  },
  { name: 'resume', descriptionKey: 'settings.integrations.discord.commands.desc.resume', category: 'chat' },
  { name: 'fork', descriptionKey: 'settings.integrations.discord.commands.desc.fork', category: 'chat' },
  { name: 'sessions', descriptionKey: 'settings.integrations.discord.commands.desc.sessions', category: 'chat' },
  { name: 'model', descriptionKey: 'settings.integrations.discord.commands.desc.model', category: 'model', suggested: true },
  { name: 'agent', descriptionKey: 'settings.integrations.discord.commands.desc.agent', category: 'model' },
  { name: 'verbosity', descriptionKey: 'settings.integrations.discord.commands.desc.verbosity', category: 'model' },
  { name: 'skill', descriptionKey: 'settings.integrations.discord.commands.desc.skill', category: 'model' },
  { name: 'yolo', descriptionKey: 'settings.integrations.discord.commands.desc.yolo', category: 'model', suggested: true },
  {
    name: 'permissions',
    descriptionKey: 'settings.integrations.discord.commands.desc.permissions',
    category: 'model',
  },
  { name: 'shell', descriptionKey: 'settings.integrations.discord.commands.desc.shell', category: 'shell', example: '/shell command:pwd' },
  { name: 'init', descriptionKey: 'settings.integrations.discord.commands.desc.init', category: 'shell' },
  { name: 'review', descriptionKey: 'settings.integrations.discord.commands.desc.review', category: 'shell' },
  { name: 'new-worktree', descriptionKey: 'settings.integrations.discord.commands.desc.newWorktree', category: 'git' },
  { name: 'merge-worktree', descriptionKey: 'settings.integrations.discord.commands.desc.mergeWorktree', category: 'git' },
  { name: 'queue', descriptionKey: 'settings.integrations.discord.commands.desc.queue', category: 'queue' },
  { name: 'clear-queue', descriptionKey: 'settings.integrations.discord.commands.desc.clearQueue', category: 'queue' },
  { name: 'mention-mode', descriptionKey: 'settings.integrations.discord.commands.desc.mentionMode', category: 'queue' },
  { name: 'share', descriptionKey: 'settings.integrations.discord.commands.desc.share', category: 'sharing' },
  { name: 'unshare', descriptionKey: 'settings.integrations.discord.commands.desc.unshare', category: 'sharing' },
  {
    name: 'schedule',
    descriptionKey: 'settings.integrations.discord.commands.desc.schedule',
    category: 'sharing',
    suggested: true,
    example: '/schedule 0 9 * * 1 Weekly standup report',
  },
];

export const DISCORD_COMMAND_CATEGORY_ORDER: DiscordCommandCategory[] = [
  'chat',
  'model',
  'shell',
  'git',
  'queue',
  'sharing',
];
