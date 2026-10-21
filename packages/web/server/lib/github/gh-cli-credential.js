import { execFile } from 'child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const hostKeyFor = (host) => {
  const value = (host ?? '').trim().toLowerCase();
  return value && value !== 'github.com' ? value : 'github.com';
};

async function fetchGhCliToken(hostKey) {
  // Pin GH_HOST to the requested host: gh returns a token for its active host,
  // and an ambient GH_HOST in the server env would otherwise leak one host's
  // token into another host's slot. The github.com default covers every
  // github.com caller that does not name a host.
  const env = { ...process.env };
  env.GH_HOST = hostKey;
  try {
    const { stdout } = await execFileAsync('gh', ['auth', 'token'], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000,
      windowsHide: true,
      env,
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export async function getGhCliToken(host) {
  return fetchGhCliToken(hostKeyFor(host));
}
