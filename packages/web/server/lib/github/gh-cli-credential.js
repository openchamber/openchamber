import { execFileSync } from 'child_process';

const CACHE_TTL_MS = 30_000;
let cachedToken = null;
let cachedAt = 0;
let hasCachedToken = false;

function fetchGhCliToken() {
  try {
    const token = execFileSync('gh', ['auth', 'token'], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000,
      windowsHide: true,
    }).trim();
    return token || null;
  } catch {
    return null;
  }
}

export function getGhCliToken() {
  const now = Date.now();
  if (hasCachedToken && now - cachedAt < CACHE_TTL_MS) {
    return cachedToken;
  }
  const token = fetchGhCliToken();
  cachedToken = token;
  cachedAt = now;
  hasCachedToken = true;
  return token;
}

export function clearGhCliTokenCache() {
  cachedToken = null;
  cachedAt = 0;
  hasCachedToken = false;
}
