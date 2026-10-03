import { execFileSync } from 'child_process';

const CACHE_TTL_MS = 30_000;
// Token cache is keyed by host. The default gh token (github.com) and each
// GitHub Enterprise host token must not share one slot: replaying a
// github.com token against a GHE API returns 401, and the reverse is just as
// broken. A single shared slot would silently return the wrong token.
const tokenCache = new Map(); // host key -> { token, at }

function hostKeyFor(host) {
  const value = (host ?? '').trim().toLowerCase();
  return value && value !== 'github.com' ? value : 'github.com';
}

function fetchGhCliToken(hostKey) {
  // Pin GH_HOST to the requested host: gh returns a token for its active host,
  // and an ambient GH_HOST in the server env would otherwise leak one host's
  // token into another host's slot.
  const env = { ...process.env };
  env.GH_HOST = hostKey;
  try {
    const token = execFileSync('gh', ['auth', 'token'], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000,
      windowsHide: true,
      env,
    }).trim();
    return token || null;
  } catch {
    return null;
  }
}

export function getGhCliToken(host) {
  const hostKey = hostKeyFor(host);
  const now = Date.now();
  const cached = tokenCache.get(hostKey);
  if (cached && now - cached.at < CACHE_TTL_MS) {
    return cached.token;
  }
  const token = fetchGhCliToken(hostKey);
  tokenCache.set(hostKey, { token, at: now });
  return token;
}

export function clearGhCliTokenCache() {
  tokenCache.clear();
}
