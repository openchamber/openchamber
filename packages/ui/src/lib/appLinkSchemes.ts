const BROWSER_HANDLED_SCHEMES: ReadonlySet<string> = new Set([
  'http', 'https', 'mailto', 'tel', 'sms', 'callto', 'cid', 'xmpp', 'irc', 'news', 'nntp', 'feed', 'webcal',
]);

const BLOCKED_APP_LINK_SCHEMES: ReadonlySet<string> = new Set([
  'javascript', 'data', 'vbscript', 'blob', 'filesystem', 'about',
  'chrome', 'chrome-extension', 'devtools', 'moz-extension', 'ms-browser-extension',
  'file',
  'ws', 'wss', 'ftp', 'ftps',
  'intent',
  'ms-msdt', 'search-ms', 'shell',
  'openchamber', 'openchamber-ui', 'capacitor',
]);

const EDITOR_BLOCKED_APP_LINK_SCHEMES: ReadonlySet<string> = new Set(['command', 'vscode', 'vscode-insiders']);

const APP_LINK_SCHEME_RE = /^[a-z][a-z0-9+.-]{1,31}$/;

export type AppLinkSchemeContext = {
  editorUriScheme?: string;
};

export const isAppLinkScheme = (scheme: string, context: AppLinkSchemeContext = {}): boolean => {
  const normalized = scheme.toLowerCase();
  if (!APP_LINK_SCHEME_RE.test(normalized)) return false;
  if (BROWSER_HANDLED_SCHEMES.has(normalized) || BLOCKED_APP_LINK_SCHEMES.has(normalized)) return false;
  if (context.editorUriScheme !== undefined) {
    if (EDITOR_BLOCKED_APP_LINK_SCHEMES.has(normalized) || normalized.startsWith('vscode-')) return false;
    if (normalized === context.editorUriScheme.toLowerCase()) return false;
  }
  return true;
};
