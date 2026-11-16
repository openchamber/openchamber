import {
  type RouteState,
  type RouteTab,
  VALID_TABS,
  VALID_SETTINGS_SECTIONS,
  ROUTE_PARAMS,
} from './types';
import { isLinkIdentifier } from './messageFocus';

export function parseRoute(searchParams?: URLSearchParams): RouteState {
  const params = searchParams ?? getSearchParams();

  return {
    sessionId: parseSessionId(params),
    messageId: parseMessageId(params),
    tab: parseTab(params),
    settingsPath: parseSettingsPath(params),
    diffFile: parseDiffFile(params),
  };
}

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

function parseSessionId(params: URLSearchParams): string | null {
  const value = params.get(ROUTE_PARAMS.SESSION);
  if (!value || value.trim().length === 0) {
    return null;
  }
  return value.trim();
}

function parseMessageId(params: URLSearchParams): string | null {
  const value = params.get(ROUTE_PARAMS.MESSAGE)?.trim() ?? '';
  if (!parseSessionId(params) || !isLinkIdentifier(value)) {
    return null;
  }
  return value;
}

function parseTab(params: URLSearchParams): RouteTab | null {
  const value = params.get(ROUTE_PARAMS.TAB);
  if (!value) {
    return null;
  }

  const normalized = value.toLowerCase().trim() as RouteTab;
  if (VALID_TABS.includes(normalized)) {
    return normalized;
  }

  return null;
}

function parseSettingsPath(params: URLSearchParams): string | null {
  const value = params.get(ROUTE_PARAMS.SETTINGS);
  if (!value) {
    return null;
  }

  const normalized = value.toLowerCase().trim();

  if (normalized.length === 0) {
    return null;
  }

  if (normalized === 'openchamber' || normalized === 'general' || normalized === 'preferences') {
    return 'home';
  }

  if ((VALID_SETTINGS_SECTIONS as readonly string[]).includes(normalized)) {
    return normalized;
  }

  return normalized;
}

function parseDiffFile(params: URLSearchParams): string | null {
  const value = params.get(ROUTE_PARAMS.FILE);
  if (!value || value.trim().length === 0) {
    return null;
  }

  try {
    return decodeURIComponent(value.trim());
  } catch {
    return value.trim();
  }
}

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
