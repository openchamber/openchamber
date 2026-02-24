import type { MainTab } from '@/stores/useUIStore';
import { ROUTE_PARAMS } from './types';

/**
 * Application state relevant for URL serialization.
 */
export interface AppRouteState {
  sessionId: string | null;
  tab: MainTab;
  isSettingsOpen: boolean;
  settingsPath: string;
  diffFile: string | null;
}

/**
 * Default tab when none is specified.
 */
const DEFAULT_TAB: MainTab = 'chat';

/**
 * Serialize application state to URL search parameters.
 * Only includes parameters that differ from defaults to keep URLs clean.
 */
export function serializeRoute(state: AppRouteState): URLSearchParams {
  const params = new URLSearchParams();

  // Session ID - always include if present
  if (state.sessionId && state.sessionId.trim().length > 0) {
    params.set(ROUTE_PARAMS.SESSION, state.sessionId);
  }

  // Settings takes precedence - if open, include settings section
  if (state.isSettingsOpen) {
    const settingsPath = state.settingsPath.trim().length > 0 ? state.settingsPath : 'home';
    params.set(ROUTE_PARAMS.SETTINGS, settingsPath);
    // Don't include tab when settings is open (it's a full-screen overlay)
    return params;
  }

  // Tab - only include if not the default
  if (state.tab !== DEFAULT_TAB) {
    params.set(ROUTE_PARAMS.TAB, state.tab);
  }

  // Diff file - only include when on diff tab
  if (state.tab === 'diff' && state.diffFile && state.diffFile.trim().length > 0) {
    params.set(ROUTE_PARAMS.FILE, state.diffFile);
  }

  return params;
}

/**
 * Convert URLSearchParams to a URL string.
 * Returns just the pathname if no params, otherwise pathname + search string.
 */
export function buildURL(params: URLSearchParams, pathname?: string): string {
  const path = pathname ?? (typeof window !== 'undefined' ? window.location.pathname : '/');
  const search = params.toString();

  if (!search) {
    return path;
  }

  return `${path}?${search}`;
}

/**
 * Check if the current URL matches the given route state.
 * Used to avoid unnecessary URL updates.
 */
export function routeMatchesURL(state: AppRouteState): boolean {
  if (typeof window === 'undefined') {
    return true;
  }

  try {
    const currentParams = new URLSearchParams(window.location.search);
    const newParams = serializeRoute(state);

    // Compare sorted param strings for equality
    const currentSorted = [...currentParams.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    const newSorted = [...newParams.entries()].sort((a, b) => a[0].localeCompare(b[0]));

    if (currentSorted.length !== newSorted.length) {
      return false;
    }

    for (let i = 0; i < currentSorted.length; i++) {
      if (currentSorted[i][0] !== newSorted[i][0] || currentSorted[i][1] !== newSorted[i][1]) {
        return false;
      }
    }

    return true;
  } catch {
    return true;
  }
}

/**
 * Update the browser URL using pushState or replaceState.
 * Does nothing if URL already matches or in VS Code context.
 */
export function updateBrowserURL(
  state: AppRouteState,
  options: { replace?: boolean; force?: boolean } = {}
): void {
  if (typeof window === 'undefined') {
    return;
  }

  // Skip URL updates in VS Code webview
  if (isVSCodeContext()) {
    return;
  }

  // Skip if URL already matches (unless forced)
  if (!options.force && routeMatchesURL(state)) {
    return;
  }

  try {
    const params = serializeRoute(state);
    const url = buildURL(params);

    if (options.replace) {
      window.history.replaceState({ ...window.history.state, route: state }, '', url);
    } else {
      window.history.pushState({ route: state }, '', url);
    }
  } catch {
    // Silently fail - URL updates are non-critical
  }
}

/**
 * Check if running in VS Code webview context.
 */
function isVSCodeContext(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  // Check for VS Code config object
  const win = window as { __VSCODE_CONFIG__?: unknown };
  return win.__VSCODE_CONFIG__ !== undefined;
}
