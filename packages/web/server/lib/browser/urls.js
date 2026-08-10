const MAX_URL_LENGTH = 4096;

const PRIVATE_HOST_PATTERNS = [
  /^localhost$/i,
  /\.localhost$/i,
  /\.local$/i,
  /\.internal$/i,
  /\.test$/i,
  /^127(?:\.\d{1,3}){3}$/,
  /^0\.0\.0\.0$/,
  /^10(?:\.\d{1,3}){3}$/,
  /^192\.168(?:\.\d{1,3}){2}$/,
  /^172\.(1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}$/,
  /^\[::1?\]$/,
];

export const isPrivateBrowserHost = (hostname) => {
  const host = String(hostname || '');
  return PRIVATE_HOST_PATTERNS.some((pattern) => pattern.test(host));
};

// Normalizes an agent- or user-entered target into a safe navigable URL.
// Only web schemes are navigable: file://, chrome://, javascript:, data: and
// friends are rejected here rather than filtered in the UI.
export const normalizeBrowserUrl = (rawUrl) => {
  const raw = typeof rawUrl === 'string' ? rawUrl.trim() : '';
  if (!raw) return { ok: false, error: 'url is required' };
  if (raw.length > MAX_URL_LENGTH) return { ok: false, error: 'url is too long' };
  if (raw === 'about:blank') return { ok: true, url: 'about:blank' };

  let candidate = raw;
  // Only an explicit authority scheme (`scheme://`) is treated as pre-formed.
  // A bare `host:port` (e.g. `localhost:3000`) must not be mistaken for a scheme.
  const hasAuthorityScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(candidate);
  if (!hasAuthorityScheme) {
    // ":3000" and "localhost:3000/path" style shorthands resolve against the
    // machine that runs the OpenChamber server, where local dev servers live.
    if (/^:\d+(\/|$)/.test(candidate)) {
      candidate = `http://127.0.0.1${candidate.startsWith(':') ? candidate : `:${candidate}`}`;
    } else {
      const hostPart = candidate.split(/[/?#]/, 1)[0]?.split(':', 1)[0] || '';
      candidate = `${isPrivateBrowserHost(hostPart) ? 'http' : 'https'}://${candidate}`;
    }
  }

  let parsed = null;
  try {
    parsed = new URL(candidate);
  } catch {
    return { ok: false, error: 'url is not a valid web address' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, error: `Only http and https URLs can be opened (got ${parsed.protocol.replace(/:$/, '')})` };
  }
  if (!parsed.hostname) {
    return { ok: false, error: 'url must include a host' };
  }
  return { ok: true, url: parsed.toString(), isPrivateHost: isPrivateBrowserHost(parsed.hostname) };
};
