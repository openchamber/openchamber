import type { SidebarSection } from '@/constants/sidebar';

export interface RouteState {
  sessionId: string | null;
  messageId: string | null;
  tab: RouteTab | null;
  settingsPath: string | null;
  diffFile: string | null;
  trackerItem: { url: string; directory: string | null; newTab: boolean } | null;
}

export type RouteTab = 'chat' | 'git' | 'diff' | 'terminal' | 'files';
export const VALID_TABS: readonly RouteTab[] = ['chat', 'git', 'diff', 'terminal', 'files'] as const;

export const VALID_SETTINGS_SECTIONS: readonly SidebarSection[] = [
  'settings',
  'agents',
  'commands',
  'skills',
  'providers',
  'usage',
  'git-identities',
] as const;

export const ROUTE_PARAMS = {
  SESSION: 'session',
  MESSAGE: 'message',
  TAB: 'tab',
  SETTINGS: 'settings',
  FILE: 'file',
  ITEM: 'item',
  ITEM_DIRECTORY: 'itemDir',
  ITEM_TAB: 'itemTab',
} as const;
