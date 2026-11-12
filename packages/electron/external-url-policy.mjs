// Native shell validation is independent of renderer confirmation. Keep the
// exclusions aligned with packages/ui/src/lib/url.ts.
const EXCLUDED_APP_SCHEMES = new Set([
  'mailto', 'tel', 'sms', 'callto', 'cid', 'xmpp', 'irc', 'news', 'nntp', 'feed', 'webcal',
  'javascript', 'data', 'vbscript', 'blob', 'filesystem', 'about',
  'chrome', 'chrome-extension', 'devtools', 'moz-extension', 'ms-browser-extension',
  'file', 'ws', 'wss', 'ftp', 'ftps', 'intent', 'ms-msdt', 'search-ms', 'shell',
  'openchamber', 'openchamber-ui', 'capacitor',
]);

export const parseExternalUrl = (target) => {
  const parsed = new URL(target);
  const scheme = parsed.protocol.slice(0, -1);
  if (scheme === 'http' || scheme === 'https') return parsed;
  if (!/^[a-z][a-z0-9+.-]{1,31}$/.test(scheme) || EXCLUDED_APP_SCHEMES.has(scheme)) {
    throw new Error('URL scheme cannot be opened externally');
  }
  return parsed;
};
