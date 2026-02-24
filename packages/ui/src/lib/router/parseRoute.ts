import type { MainTab } from '@/stores/useUIStore';
import {
  type RouteState,
  VALID_TABS,
  VALID_SETTINGS_SECTIONS,
  ROUTE_PARAMS,
} from './types';

/**
 * Parse the current URL search parameters into a RouteState.
 * Returns null values for any parameter that is missing or invalid.
 */
export function parseRoute(searchParams?: URLSearchParams): RouteState {
  const params = searchParams ?? getSearchParams();

  return {
    sessionId: parseSessionId(params),
    tab: parseTab(params),
    settingsPath: parseSettingsPath(params),
    diffFile: parseDiffFile(params),
  };
}

/**
 * Safely get URLSearchParams from the current location.
 */
function getSearchParams(): URLSearchParams {
  if (typeof window === 'undefined') {
    return new URLSearchParams();
  }

  try {
    return new URLSearchParams(window.location.search);
  } catch {
    return new URLSearchParams();
  }
}

/**
 * Parse session ID from URL parameters.
 * Returns null if missing or empty.
 */
function parseSessionId(params: URLSearchParams): string | null {
  const value = params.get(ROUTE_PARAMS.SESSION);
  if (!value || value.trim().length === 0) {
    return null;
  }
  return value.trim();
}

/**
 * Parse main tab from URL parameters.
 * Returns null if missing or invalid.
 */
function parseTab(params: URLSearchParams): MainTab | null {
  const value = params.get(ROUTE_PARAMS.TAB);
  if (!value) {
    return null;
  }

  const normalized = value.toLowerCase().trim() as MainTab;
  if (VALID_TABS.includes(normalized)) {
    return normalized;
  }

  return null;
}

/**
 * Parse settings target from URL parameters.
 * Returns null if missing/empty.
 */
function parseSettingsPath(params: URLSearchParams): string | null {
  const value = params.get(ROUTE_PARAMS.SETTINGS);
  if (!value) {
    return null;
  }

  const normalized = value.toLowerCase().trim();

  if (normalized.length === 0) {
    return null;
  }

  // Handle common aliases
  if (normalized === 'openchamber' || normalized === 'general' || normalized === 'preferences') {
    return 'home';
  }

  // Keep legacy section ids as-is (mapping happens at apply time).
  if ((VALID_SETTINGS_SECTIONS as readonly string[]).includes(normalized)) {
    return normalized;
  }

  return normalized;
}

/**
 * Parse diff file path from URL parameters.
 * Returns null if missing or empty.
 */
function parseDiffFile(params: URLSearchParams): string | null {
  const value = params.get(ROUTE_PARAMS.FILE);
  if (!value || value.trim().length === 0) {
    return null;
  }

  // URL decode the file path
  try {
    return decodeURIComponent(value.trim());
  } catch {
    // If decoding fails, return the raw value
    return value.trim();
  }
}

/**
 * Check if the current URL has any route parameters.
 */
export function hasRouteParams(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  try {
    const params = new URLSearchParams(window.location.search);
    return (
      params.has(ROUTE_PARAMS.SESSION) ||
      params.has(ROUTE_PARAMS.TAB) ||
      params.has(ROUTE_PARAMS.SETTINGS) ||
      params.has(ROUTE_PARAMS.FILE)
    );
  } catch {
    return false;
  }
}
