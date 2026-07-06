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
