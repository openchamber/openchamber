import { pushRouteEntry } from './backGuard';
import { ROUTE_PARAMS } from './types';

export interface AppRouteState {
  sessionId: string | null;
  isSettingsOpen: boolean;
  settingsPath: string;
}

function serializeRoute(state: AppRouteState): URLSearchParams {
  const params = new URLSearchParams();

  if (state.sessionId && state.sessionId.trim().length > 0) {
    params.set(ROUTE_PARAMS.SESSION, state.sessionId);
  }

  if (state.isSettingsOpen) {
    const settingsPath = state.settingsPath.trim().length > 0 ? state.settingsPath : 'home';
    params.set(ROUTE_PARAMS.SETTINGS, settingsPath);
    return params;
  }


  return params;
}

function buildURL(params: URLSearchParams, pathname?: string): string {
  const path = pathname ?? (typeof window !== 'undefined' ? window.location.pathname : '/');
  const search = params.toString();

  if (!search) {
    return path;
  }

  return `${path}?${search}`;
}

function routeMatchesURL(state: AppRouteState): boolean {
  if (typeof window === 'undefined') {
    return true;
  }

  try {
    const currentParams = new URLSearchParams(window.location.search);
    const newParams = serializeRoute(state);

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

export function updateBrowserURL(
  state: AppRouteState,
  options: { replace?: boolean; force?: boolean } = {}
): void {
  if (typeof window === 'undefined') {
    return;
  }

  if (isVSCodeContext()) {
    return;
  }

  if (!options.force && routeMatchesURL(state)) {
    return;
  }

  try {
    const params = serializeRoute(state);
    const url = buildURL(params);

    if (options.replace) {
      window.history.replaceState({ ...window.history.state, route: state }, '', url);
    } else {
      pushRouteEntry({ route: state }, url);
    }
  } catch {
    // Silently fail - URL updates are non-critical
  }
}

function isVSCodeContext(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  const win = window as { __VSCODE_CONFIG__?: unknown };
  return win.__VSCODE_CONFIG__ !== undefined;
}
