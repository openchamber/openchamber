import type { Theme } from '@/types/theme';

export type EmbeddedSessionChatThemeBootstrap = {
  mode: 'light' | 'dark' | 'system';
  lightThemeId: string;
  darkThemeId: string;
  currentTheme: Theme;
};

export type EmbeddedSessionChatURLCacheEntry = {
  signature: string;
  src: string;
};

const buildEmbeddedSessionChatURLSignature = (
  sessionID: string,
  directory: string | null,
  readOnly: boolean,
): string => JSON.stringify({ sessionID, directory: directory || '', readOnly: readOnly === true });

export const buildEmbeddedSessionChatURL = (
  sessionID: string,
  directory: string | null,
  readOnly: boolean,
  theme: EmbeddedSessionChatThemeBootstrap,
): string => {
  if (typeof window === 'undefined') {
    return '';
  }

  const url = new URL(window.location.pathname, window.location.origin);
  url.searchParams.set('ocPanel', 'session-chat');
  url.searchParams.set('surface', 'desktop');
  url.searchParams.set('sessionId', sessionID);
  if (readOnly) {
    url.searchParams.set('readOnly', '1');
  } else {
    url.searchParams.delete('readOnly');
  }
  if (directory && directory.trim().length > 0) {
    url.searchParams.set('directory', directory);
  } else {
    url.searchParams.delete('directory');
  }
  url.searchParams.set('themeMode', theme.mode);
  url.searchParams.set('lightThemeId', theme.lightThemeId);
  url.searchParams.set('darkThemeId', theme.darkThemeId);
  url.searchParams.set('themeVariant', theme.currentTheme.metadata.variant === 'dark' ? 'dark' : 'light');
  url.searchParams.set('currentTheme', JSON.stringify(theme.currentTheme));

  url.hash = '';
  return url.toString();
};

export const getOrCreateEmbeddedSessionChatURL = (
  cache: Map<string, EmbeddedSessionChatURLCacheEntry>,
  tabID: string,
  sessionID: string,
  directory: string | null,
  readOnly: boolean,
  theme: EmbeddedSessionChatThemeBootstrap,
): string => {
  const signature = buildEmbeddedSessionChatURLSignature(sessionID, directory, readOnly);
  const existing = cache.get(tabID);
  if (existing?.signature === signature) {
    return existing.src;
  }

  const src = buildEmbeddedSessionChatURL(sessionID, directory, readOnly, theme);
  cache.set(tabID, { signature, src });
  return src;
};

/**
 * True when the current document is the embedded session-chat iframe
 * (`?ocPanel=session-chat`). Used to distinguish the embedded iframe from
 * the main app so callers can route behavior accordingly (e.g. in-place
 * subtask navigation instead of opening a new side-panel tab, or skipping
 * URL rewrites that would strip the iframe's identity params).
 *
 * Cached on first call (per JS realm): an iframe's embedded-ness is fixed
 * at mount by the parent and cannot change during its lifetime — a parent
 * src swap is a full browser reload, starting a fresh realm.
 */
let embeddedSessionChatCached: boolean | null = null;

export const isEmbeddedSessionChat = (): boolean => {
  if (embeddedSessionChatCached !== null) {
    return embeddedSessionChatCached;
  }
  if (typeof window === 'undefined') {
    embeddedSessionChatCached = false;
    return false;
  }
  try {
    embeddedSessionChatCached =
      new URLSearchParams(window.location.search).get('ocPanel') === 'session-chat';
    return embeddedSessionChatCached;
  } catch {
    embeddedSessionChatCached = false;
    return false;
  }
};

/**
 * Reset the module-level cache. Intended for tests that simulate different
 * JS realms by swapping `window.location` in the same process.
 */
export const resetEmbeddedSessionChatCache = (): void => {
  embeddedSessionChatCached = null;
};

/**
 * The session ID recorded in the embedded iframe's URL
 * (`?ocPanel=session-chat&sessionId=…`), i.e. the session the panel was
 * opened to show. Returns `null` outside the embedded iframe or when the
 * URL is malformed.
 */
export const getEmbeddedSessionChatOriginSessionId = (): string | null => {
  if (!isEmbeddedSessionChat()) {
    return null;
  }
  try {
    const sid = new URLSearchParams(window.location.search).get('sessionId');
    return sid && sid.trim().length > 0 ? sid.trim() : null;
  } catch {
    return null;
  }
};

export const installEmbeddedSessionChatComposerFocusListener = (focus: () => void): (() => void) => {
  if (typeof window === 'undefined' || !isEmbeddedSessionChat()) return () => {};
  const listener = (event: MessageEvent) => {
    if (event.source === window.parent && event.data?.type === 'openchamber:focus-chat-composer') focus();
  };
  window.addEventListener('message', listener);
  return () => window.removeEventListener('message', listener);
};

export const focusEmbeddedSessionChatComposer = (sessionID: string): boolean => {
  if (typeof document === 'undefined' || !sessionID) return false;
  for (const iframe of document.querySelectorAll<HTMLIFrameElement>('iframe[src]')) {
    try {
      const url = new URL(iframe.src, window.location.href);
      if (url.searchParams.get('ocPanel') !== 'session-chat' || url.searchParams.get('sessionId') !== sessionID) continue;
      iframe.contentWindow?.postMessage({ type: 'openchamber:focus-chat-composer' }, url.origin);
      return true;
    } catch {
      // Ignore unrelated iframes with invalid sources.
    }
  }
  return false;
};
