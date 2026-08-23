import type { SidebarSection } from '@/constants/sidebar';
import type { WorkspaceSurface } from '@/stores/useUIStore';

/**
 * Represents the current route state derived from URL parameters.
 * All fields are nullable - null means "not specified in URL" (use app defaults).
 */
export interface RouteState {
  /** Session ID to navigate to */
  sessionId: string | null;
  /** View selected through the legacy `tab` URL parameter. */
  tab: WorkspaceSurface | null;
  /** Settings section - when non-null, settings dialog should be open */
  settingsPath: string | null;
  /** File path for diff view */
  diffFile: string | null;
}

/**
 * Valid values for the legacy `tab` URL parameter.
 */
export const VALID_TABS: readonly WorkspaceSurface[] = ['chat', 'git', 'diff', 'terminal', 'files', 'diagram'] as const;

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
