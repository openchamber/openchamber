const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);
const CLIPBOARD_READ_HOSTNAME = 'localhost';
const CLIPBOARD_WRITE_PERMISSION = 'clipboard-sanitized-write';
const CLIPBOARD_READ_PERMISSION = 'clipboard-read';

const isLocalhostHttpUrl = (url) => {
  try {
    const parsed = new URL(url);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      && parsed.hostname.toLowerCase() === CLIPBOARD_READ_HOSTNAME;
  } catch {
    return false;
  }
};

export const shouldAllowBrowserPanelPermission = ({ permission, requestingUrl, isFocused }) => {
  if (!isFocused) return false;
  if (permission === CLIPBOARD_WRITE_PERMISSION) return true;
  if (permission === CLIPBOARD_READ_PERMISSION) return isLocalhostHttpUrl(requestingUrl);
  return false;
};

export const browserPanelPermissionAuditDetails = ({ permission }) => ({ permission });

export const shouldAllowBrowserPanelCertificateError = ({ url, error }) => {
  if (error !== 'net::ERR_CERT_AUTHORITY_INVALID') return false;

  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && LOOPBACK_HOSTNAMES.has(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
};

const isHttpUrl = (url) => {
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
};

export const browserPanelWindowOpenTarget = ({ url, disposition, hasPostBody }) => {
  if (!isHttpUrl(url)) return 'deny';
  if (disposition === 'new-window') return 'popup';
  if (hasPostBody) return 'in-place';
  if (disposition === 'foreground-tab') return 'tab';
  if (disposition === 'background-tab') return 'background-tab';
  return 'in-place';
};

export const plainChromeUserAgent = (userAgent) => String(userAgent || '')
  .replace(/\s(?:Electron|OpenChamber)\/\S+/gi, '')
  .replace(/\s{2,}/g, ' ')
  .trim();

// external: https://developers.googleblog.com/2020/08/guidance-for-our-effort-to-block-less-secure-browser-and-apps.html Google sign-in rejects an embedded browser that sends another browser's user agent, so its hosts get the Electron token back.
const GOOGLE_SIGN_IN_URLS = ['https://accounts.google.com/*', 'https://accounts.youtube.com/*'];

export const electronUserAgent = (userAgent, electronVersion) => plainChromeUserAgent(userAgent)
  .replace(/\sSafari\//, ` Electron/${electronVersion} Safari/`);

export const applyBrowserPanelUserAgent = (panelSession, electronVersion) => {
  const userAgent = plainChromeUserAgent(panelSession.getUserAgent());
  panelSession.setUserAgent(userAgent);
  const signInUserAgent = electronUserAgent(userAgent, electronVersion);
  panelSession.webRequest.onBeforeSendHeaders({ urls: GOOGLE_SIGN_IN_URLS }, (details, callback) => {
    const requestHeaders = Object.fromEntries(Object.entries(details.requestHeaders)
      .filter(([name]) => name.toLowerCase() !== 'user-agent'));
    callback({ requestHeaders: { ...requestHeaders, 'User-Agent': signInUserAgent } });
  });
};
