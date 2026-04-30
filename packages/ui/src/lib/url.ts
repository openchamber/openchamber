import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';

/**
 * Utility for opening external URLs with Tauri shell support.
 * In desktop runtime, uses tauri.shell.open() for proper system browser handling.
 * Falls back to window.open() for web runtime.
 */

type TauriShell = {
  shell?: {
    open?: (url: string) => Promise<unknown>;
  };
};

const parseUrlSafely = (value: string): URL | null => {
  try {
    return new URL(value);
  } catch {
    return null;
  }
};

export const isExternalHttpUrl = (url: string): boolean => {
  const parsed = parseUrlSafely(url.trim());
  if (!parsed) {
    return false;
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:';
};

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1']);

/**
 * Returns true when the URL is an http(s) URL pointing at a loopback host
 * (localhost, 127.0.0.1, 0.0.0.0, ::1). Used to decide whether to offer an in-app
 * preview pane instead of opening the system browser.
 */
export const isLoopbackHttpUrl = (url: string): boolean => {
  const parsed = parseUrlSafely(url.trim());
  if (!parsed) {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return false;
  }
  return LOOPBACK_HOSTNAMES.has(parsed.hostname.toLowerCase());
};

const LOOPBACK_URL_PATTERN
  // eslint-disable-next-line no-control-regex
  = /\bhttps?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d{2,5})?(?:\/[^\s<>"'`\u0000-\u001f]*)?/gi;

/**
 * Extracts loopback http(s) URLs from a free-text string. Returns unique URLs
 * in order of first appearance. Trailing punctuation that is unlikely to be
 * part of a real URL is stripped.
 */
export const extractLoopbackUrls = (text: string): string[] => {
  if (!text) {
    return [];
  }
  const matches = text.match(LOOPBACK_URL_PATTERN);
  if (!matches || matches.length === 0) {
    return [];
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of matches) {
    const cleaned = raw.replace(/[),.;:!?'"`]+$/g, '');
    if (!cleaned || !isLoopbackHttpUrl(cleaned)) {
      continue;
    }
    if (seen.has(cleaned)) {
      continue;
    }
    seen.add(cleaned);
    out.push(cleaned);
  }
  return out;
};

/**
 * Opens an external URL in the system browser.
 * In Tauri desktop runtime, uses tauri.shell.open() for proper handling.
 * Falls back to window.open() for web runtime.
 *
 * @param url - The URL to open
 * @returns Promise<boolean> - true if the URL was opened successfully
 */
export const openExternalUrl = async (url: string): Promise<boolean> => {
  if (typeof window === 'undefined') {
    return false;
  }

  const target = url.trim();
  if (!target) {
    return false;
  }

  const parsed = parseUrlSafely(target);
  if (!parsed) {
    return false;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return false;
  }

  const normalizedTarget = parsed.toString();

  const runtimeApis = getRegisteredRuntimeAPIs();
  if (runtimeApis?.runtime?.isVSCode && runtimeApis.vscode?.openExternalUrl) {
    try {
      await runtimeApis.vscode.openExternalUrl(normalizedTarget);
      return true;
    } catch {
      return false;
    }
  }

  const tauri = (window as unknown as { __TAURI__?: TauriShell }).__TAURI__;
  if (tauri?.shell?.open) {
    try {
      await tauri.shell.open(normalizedTarget);
      return true;
    } catch {
      // Fall through to window.open
    }
  }

  try {
    window.open(normalizedTarget, '_blank', 'noopener,noreferrer');
    return true;
  } catch {
    return false;
  }
};
