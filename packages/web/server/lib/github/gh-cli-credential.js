import { execFileSync } from 'child_process';

const hostKeyFor = (host) => {
  const value = (host ?? '').trim().toLowerCase();
  return value && value !== 'github.com' ? value : 'github.com';
};

function fetchGhCliToken(hostKey) {
  // Pin GH_HOST to the requested host: gh returns a token for its active host,
  // and an ambient GH_HOST in the server env would otherwise leak one host's
  // token into another host's slot. The github.com default covers every
  // github.com caller that does not name a host.
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
  return fetchGhCliToken(hostKeyFor(host));
}
