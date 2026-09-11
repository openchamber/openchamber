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
