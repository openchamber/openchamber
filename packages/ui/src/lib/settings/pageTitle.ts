import type { I18nKey } from '@/lib/i18n/store';
import type { SettingsPageSlug } from './metadata';

/**
 * The translated title of each Settings page. The page metadata carries an
 * English title for code and search keywords; anything a user reads takes
 * the title from here, so Settings and the command palette name a page alike.
 */
const SETTINGS_PAGE_TITLE_KEYS = {
  home: 'settings.view.home.title',
  general: 'settings.page.general.title',
  projects: 'settings.page.projects.title',
  'remote-instances': 'settings.page.remoteInstances.title',
  providers: 'settings.page.providers.title',
  'web-search': 'settings.page.webSearch.title',
  usage: 'settings.page.usage.title',
  agents: 'settings.page.agents.title',
  behavior: 'settings.page.behavior.title',
  commands: 'settings.page.commands.title',
  mcp: 'settings.page.mcp.title',
  plugins: 'settings.page.plugins.title',
  'skills.installed': 'settings.page.skills.title',
  'skills.catalog': 'settings.page.skillsCatalog.title',
  git: 'settings.page.git.title',
  integrations: 'settings.page.integrations.title',
  extensions: 'settings.page.extensions.title',
  appearance: 'settings.page.appearance.title',
  chat: 'settings.page.chat.title',
  shortcuts: 'settings.page.shortcuts.title',
  sessions: 'settings.page.sessions.title',
  routing: 'settings.page.routing.title',
  'magic-prompts': 'settings.page.magicPrompts.title',
  snippets: 'settings.page.snippets.title',
  notifications: 'settings.page.notifications.title',
  voice: 'settings.page.voice.title',
  tunnel: 'settings.page.tunnel.title',
  'isolated-spaces': 'settings.openchamber.spaces.title',
  about: 'settings.page.about.title',
} satisfies Record<SettingsPageSlug, I18nKey>;

export const settingsPageTitleKey = (slug: SettingsPageSlug): I18nKey => SETTINGS_PAGE_TITLE_KEYS[slug];
