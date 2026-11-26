import type { SettingsSearchItem } from './search';

export const CHAT_ACTIVITY_SEARCH_ITEMS: readonly SettingsSearchItem[] = [
  {
    id: 'chat.tool-file-icons',
    page: 'chat',
    titleKey: 'settings.openchamber.visual.field.showToolFileIcons',
    keywords: ['tools', 'files', 'icons'],
  },
  {
    id: 'chat.keep-earlier-replies',
    page: 'chat',
    titleKey: 'settings.openchamber.visual.field.keepEarlierReplies',
    descriptionKey: 'settings.openchamber.visual.field.keepEarlierRepliesInfo',
    keywords: ['replies', 'background', 'fold', 'collapse', 'subagents'],
  },
  {
    id: 'chat.changed-files',
    page: 'chat',
    titleKey: 'settings.openchamber.visual.field.showTurnChangedFiles',
    keywords: ['changed files', 'turns'],
  },
];
