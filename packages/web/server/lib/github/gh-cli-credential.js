import { execFile } from 'child_process';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { ghConfigDir } from './gh-config.js';

const execFileAsync = promisify(execFile);

// How long gh's answer is reused while its hosts.yml stays unchanged. The
// hosts.yml check catches gh's own login changes at once; the limit covers a
// token that changed where hosts.yml does not show it. "No token" is kept
// briefly: gh exits non-zero for a locked keyring too, and unlocking it does
// not touch hosts.yml.
const TOKEN_TTL_MS = 5 * 60_000;
const NO_TOKEN_TTL_MS = 30_000;

const hostKeyFor = (host) => {
  const value = (host ?? '').trim().toLowerCase();
  return value && value !== 'github.com' ? value : 'github.com';
};

// gh rewrites hosts.yml on every login, logout, account switch and token
// refresh, so its stat names the gh state an answer was read from.
async function ghStateStamp() {
  try {
    const info = await stat(join(ghConfigDir(), 'hosts.yml'));
    return `${info.mtimeMs}:${info.size}:${info.ino}`;
  } catch {
    return 'missing';
  }
}

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
    return { token: stdout.trim() || null, answered: true };
  } catch (error) {
    // An exit code means gh ran and has no token for the host. A missing gh, a
    // start failure or the timeout leaves the answer unknown.
    return { token: null, answered: Number.isInteger(error?.code) };
  }
}

const answers = new Map();
const lookups = new Map();

/**
 * The gh CLI token for `host`, or null when gh has none or cannot be asked.
 * gh's answer is reused per host until hosts.yml changes, TOKEN_TTL_MS
 * (NO_TOKEN_TTL_MS for "no token") passes, or GitHub refuses the token;
 * concurrent callers share one gh run.
 * Only an answer gh gave is reused: a failed run is asked again next time.
 */
export async function getGhCliToken(host) {
  const hostKey = hostKeyFor(host);
  const stamp = await ghStateStamp();
  const answer = answers.get(hostKey);
  const ttl = answer?.token === null ? NO_TOKEN_TTL_MS : TOKEN_TTL_MS;
  if (answer && answer.stamp === stamp && Date.now() - answer.at < ttl) return answer.token;
  const running = lookups.get(hostKey);
  if (running && running.stamp === stamp) return running.promise;
  const at = Date.now();
  const promise = fetchGhCliToken(hostKey).then(({ token, answered }) => {
    if (answered) answers.set(hostKey, { stamp, at, token });
    else answers.delete(hostKey);
    return token;
  }).finally(() => {
    if (lookups.get(hostKey)?.promise === promise) lookups.delete(hostKey);
  });
  lookups.set(hostKey, { stamp, promise });
  return promise;
}

/** Forgets the reused answer for `host` when it is `token`, which GitHub just refused. */
export function forgetGhCliToken(host, token) {
  const hostKey = hostKeyFor(host);
  if (answers.get(hostKey)?.token === token) answers.delete(hostKey);
}
