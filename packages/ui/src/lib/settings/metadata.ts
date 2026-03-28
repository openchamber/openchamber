import type { SidebarSection } from '@/constants/sidebar';

export type SettingsPageSlug =
  | 'home'
  | 'projects'
  | 'remote-instances'
  | 'providers'
  | 'usage'
  | 'agents'
  | 'commands'
  | 'mcp'
  | 'skills.installed'
  | 'skills.catalog'
  | 'git'
  | 'appearance'
  | 'chat'
  | 'shortcuts'
  | 'sessions'
  | 'notifications'
  | 'voice'
  | 'tunnel';

export type SettingsPageGroup =
  | 'appearance'
  | 'projects'
  | 'general'
  | 'opencode'
  | 'git'
  | 'skills'
  | 'usage'
  | 'advanced';

export interface SettingsRuntimeContext {
  isVSCode: boolean;
  isWeb: boolean;
  isDesktop: boolean;
}

export interface SettingsPageMeta {
  slug: SettingsPageSlug;
  title: string;
  titleKey?: string;
  group: SettingsPageGroup;
  kind: 'single' | 'split';
  description?: string;
  keywords?: string[];
  isAvailable?: (ctx: SettingsRuntimeContext) => boolean;
}

export const SETTINGS_GROUP_LABELS: Record<SettingsPageGroup, string> = {
  appearance: 'settings.groups.appearance',
  projects: 'settings.groups.projects',
  general: 'settings.groups.general',
  opencode: 'settings.groups.opencode',
  git: 'settings.groups.git',
  skills: 'settings.groups.skills',
  usage: 'settings.groups.usage',
  advanced: 'settings.groups.advanced',
};

export const SETTINGS_PAGE_METADATA: readonly SettingsPageMeta[] = [
  {
    slug: 'home',
    title: 'settings.title',
    group: 'general',
    kind: 'single',
    description: 'settings.searchAndJump',
    keywords: ['search', 'settings'],
  },
  {
    slug: 'projects',
    title: 'settings.pages.projects',
    group: 'projects',
    kind: 'split',
    keywords: ['project', 'projects', 'worktree', 'worktrees', 'repo', 'repository', 'directory'],
  },
  {
    slug: 'remote-instances',
    title: 'settings.pages.remoteInstances',
    group: 'projects',
    kind: 'split',
    keywords: ['ssh', 'remote', 'instances', 'tunnels', 'forwarding', 'connection'],
    isAvailable: (ctx) => ctx.isDesktop && !ctx.isWeb && !ctx.isVSCode,
  },
  {
    slug: 'providers',
    title: 'settings.pages.providers',
    group: 'opencode',
    kind: 'split',
    keywords: ['provider', 'providers', 'models', 'model', 'api key', 'api keys', 'openai', 'anthropic', 'ollama', 'credentials'],
  },
  {
    slug: 'usage',
    title: 'settings.pages.usage',
    group: 'usage',
    kind: 'split',
    keywords: ['quota', 'billing', 'tokens', 'usage', 'limits'],
  },
  {
    slug: 'agents',
    title: 'settings.pages.agents',
    group: 'opencode',
    kind: 'split',
    keywords: ['agent', 'agents', 'prompts', 'tools', 'permissions'],
  },
  {
    slug: 'commands',
    title: 'settings.pages.commands',
    group: 'opencode',
    kind: 'split',
    keywords: ['command', 'commands', 'slash', 'macros', 'automation'],
  },
  {
    slug: 'mcp',
    title: 'settings.pages.mcp',
    group: 'opencode',
    kind: 'split',
    keywords: ['mcp', 'model context protocol', 'servers', 'tools', 'remote', 'stdio'],
  },
  {
    slug: 'skills.installed',
    title: 'settings.pages.skills',
    group: 'skills',
    kind: 'split',
    keywords: ['skill', 'skills', 'instructions', 'install', 'catalog'],
  },
  {
    slug: 'skills.catalog',
    title: 'settings.pages.skillsCatalog',
    group: 'skills',
    kind: 'single',
    keywords: ['install', 'catalog', 'external', 'repository', 'skills catalog'],
  },
  {
    slug: 'git',
    title: 'settings.pages.git',
    group: 'git',
    kind: 'single',
    keywords: ['git', 'github', 'identity', 'identities', 'ssh', 'profiles', 'credentials', 'keys', 'commit', 'gitmoji', 'oauth', 'prs', 'issues'],
    isAvailable: (ctx) => !ctx.isVSCode,
  },
  {
    slug: 'appearance',
    title: 'settings.pages.appearance',
    group: 'appearance',
    kind: 'single',
    keywords: ['theme', 'font', 'spacing', 'padding', 'corner radius', 'radius', 'input bar', 'terminal', 'pwa', 'install name', 'app shortcuts'],
  },
  {
    slug: 'chat',
    title: 'settings.pages.chat',
    group: 'general',
    kind: 'single',
    keywords: ['tools', 'diff', 'reasoning', 'dotfiles', 'draft', 'queue', 'output'],
  },
  {
    slug: 'shortcuts',
    title: 'settings.pages.shortcuts',
    group: 'general',
    kind: 'single',
    keywords: ['keyboard', 'hotkeys', 'shortcuts', 'bindings'],
    isAvailable: (ctx) => !ctx.isVSCode,
  },
  {
    slug: 'sessions',
    title: 'settings.pages.sessions',
    group: 'general',
    kind: 'single',
    keywords: ['defaults', 'default agent', 'default model', 'retention', 'memory', 'limits', 'zen'],
  },

  { slug: 'notifications', title: 'settings.pages.notifications', group: 'general', kind: 'single', keywords: ['alerts', 'native', 'summary', 'summarization'], },
  { slug: 'voice', title: 'settings.pages.voice', group: 'advanced', kind: 'single', keywords: ['tts', 'speech', 'voice'], isAvailable: (ctx) => !ctx.isVSCode },
  { slug: 'tunnel', title: 'settings.pages.tunnel', group: 'advanced', kind: 'single', keywords: ['tunnel', 'cloudflare', 'qr', 'remote', 'mobile', 'share'], isAvailable: (ctx) => !ctx.isVSCode },
] as const;

export const LEGACY_SIDEBAR_SECTION_TO_SETTINGS_SLUG: Record<SidebarSection, SettingsPageSlug> = {
  sessions: 'sessions',
  agents: 'agents',
  commands: 'commands',
  mcp: 'mcp',
  skills: 'skills.installed',
  providers: 'providers',
  usage: 'usage',
  'git-identities': 'git',
  settings: 'home',
};

export function getSettingsPageMeta(slug: string): SettingsPageMeta | null {
  const normalized = slug.trim().toLowerCase();
  return (SETTINGS_PAGE_METADATA as readonly SettingsPageMeta[]).find((page) => page.slug === normalized) ?? null;
}

export function resolveSettingsSlug(value: string | null | undefined): SettingsPageSlug {
  const normalized = (value ?? '').trim().toLowerCase();
  if (!normalized) {
    return 'home';
  }

  const legacy = (LEGACY_SIDEBAR_SECTION_TO_SETTINGS_SLUG as Record<string, SettingsPageSlug>)[normalized];
  if (legacy) {
    return legacy;
  }

  const direct = getSettingsPageMeta(normalized);
  if (direct) {
    return direct.slug;
  }

  return 'home';
}
