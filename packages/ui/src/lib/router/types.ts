import type { SidebarSection } from '@/constants/sidebar';
import type { MainTab } from '@/stores/useUIStore';

/**
 * Represents the current route state derived from URL parameters.
 * All fields are nullable - null means "not specified in URL" (use app defaults).
 */
export interface RouteState {
  /** Session ID to navigate to */
  sessionId: string | null;
  /** Main tab to display (chat, git, diff, terminal, files) */
  tab: MainTab | null;
  /** Settings section - when non-null, settings dialog should be open */
  settingsPath: string | null;
  /** File path for diff view */
  diffFile: string | null;
}

/**
 * Context for router operations - determines what capabilities are available.
 */
export interface RouterContext {
  /** Whether running in VS Code webview (limited URL capabilities) */
  isVSCode: boolean;
  /** Whether URL can be updated (false in VS Code, true elsewhere) */
  canUpdateURL: boolean;
}

/**
 * Valid main tab values for URL routing.
 */
export const VALID_TABS: readonly MainTab[] = ['chat', 'git', 'diff', 'terminal', 'files'] as const;

/**
 * Valid settings section values for URL routing.
 */
export const VALID_SETTINGS_SECTIONS: readonly SidebarSection[] = [
  'settings',
  'agents',
  'commands',
  'skills',
  'providers',
  'usage',
  'git-identities',
] as const;

/**
 * URL parameter names used for routing.
 */
export const ROUTE_PARAMS = {
  SESSION: 'session',
  TAB: 'tab',
  SETTINGS: 'settings',
  FILE: 'file',
} as const;
