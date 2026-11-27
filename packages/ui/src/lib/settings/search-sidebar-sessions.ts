import type { SettingsSearchItem } from './search';

export const SIDEBAR_SESSION_SEARCH_ITEMS: readonly SettingsSearchItem[] = [
  {
    id: 'sessions.show-chats',
    page: 'sessions',
    titleKey: 'settings.openchamber.defaults.field.showChats',
    keywords: ['chats', 'sidebar', 'hide', 'show', 'section'],
    isAvailable: (ctx) => !ctx.isVSCode,
  },
  {
    id: 'sessions.show-subagents',
    page: 'sessions',
    titleKey: 'settings.openchamber.defaults.field.showSubagents',
    descriptionKey: 'settings.openchamber.defaults.field.showSubagentsInfo',
    keywords: ['subagent', 'sub-agent', 'sidebar', 'hide', 'show', 'children', 'tree'],
  },
];
