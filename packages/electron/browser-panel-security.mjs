const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

export const shouldAllowBrowserPanelCertificateError = ({ url, error }) => {
  if (error !== 'net::ERR_CERT_AUTHORITY_INVALID') return false;

  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && LOOPBACK_HOSTNAMES.has(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
};
