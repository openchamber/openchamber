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

/**
 * Where a `window.open` from a page of the user's browser panel goes.
 *
 * - `popup`: a scripted popup (`new-window`, usually a sign-in with Google,
 *   GitHub or an SSO provider). It opens as a real window that keeps
 *   `window.opener`, because the sign-in posts its result back to the page that
 *   opened it; loading the popup in place threw that page away and the sign-in
 *   never finished.
 * - `tab` / `background-tab`: a link meant for a new tab (target=_blank, a
 *   modified click) gets a panel tab of its own. A POST form keeps loading in
 *   place, since a new tab could only repeat it as a GET.
 * - `in-place`: everything else http(s) loads in the opening page.
 * - `deny`: anything that is not http(s).
 */
export const browserPanelWindowOpenTarget = ({ url, disposition, hasPostBody }) => {
  if (!isHttpUrl(url)) return 'deny';
  if (disposition === 'new-window') return 'popup';
  if (hasPostBody) return 'in-place';
  if (disposition === 'foreground-tab') return 'tab';
  if (disposition === 'background-tab') return 'background-tab';
  return 'in-place';
};

/**
 * The user agent the browser panel sends: Electron's default minus the app and
 * Electron tokens, so sites see plain Chrome. Some sites refuse or degrade an
 * Electron user agent (sign-in pages in particular).
 */
export const plainChromeUserAgent = (userAgent) => String(userAgent || '')
  .replace(/\s(?:Electron|OpenChamber)\/\S+/gi, '')
  .replace(/\s{2,}/g, ' ')
  .trim();
