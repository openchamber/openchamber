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

// gh logins are GitHub handles: case-insensitive, like the host, so the cache key
// folds them. What `--user` receives is the login as it was stored: gh's own
// matching is not documented as case-insensitive, and gh, not this module,
// decides whose token answers. An empty login is gh's active account, which is
// what a call without `--user` answers.
const loginKeyFor = (login) => String(login ?? '').trim().toLowerCase();
const loginArgumentFor = (login) => String(login ?? '').trim();

// gh rewrites hosts.yml on every login, logout, account switch and token
// refresh, so its stat names the gh state an answer was read from. The
// directory is part of the stamp: a test or an operator pointing
// GH_CONFIG_DIR at another gh home must not read the previous one's answers,
// and on Windows a file's inode is not the identity a stat can rely on.
async function ghStateStamp() {
  const directory = ghConfigDir();
  try {
    const info = await stat(join(directory, 'hosts.yml'));
    return `${directory}|${info.mtimeMs}:${info.size}:${info.ino}`;
  } catch {
    return `${directory}|missing`;
  }
}

/** The stamp the reused answers were read from; the login list reuses it too. */
export const ghConfigStamp = ghStateStamp;

async function fetchGhCliToken(hostKey, login) {
  // Pin GH_HOST to the requested host: gh returns a token for its active host,
  // and an ambient GH_HOST in the server env would otherwise leak one host's
  // token into another host's slot. The github.com default covers every
  // github.com caller that does not name a host. `--user` names the login, so a
  // host with several gh accounts answers for the one asked for instead of the
  // active one; without it the answer stays gh's active login, exactly as before.
  const env = { ...process.env };
  env.GH_HOST = hostKey;
  const args = ['auth', 'token'];
  if (login) args.push('--user', login);
  try {
    const { stdout } = await execFileAsync('gh', args, {
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
 * The gh CLI token `login` holds on `host`, or null when gh has none or cannot
 * be asked. Without a login the answer is gh's active account, which is what
 * gh returns with no `--user`. gh's answer is reused per host and login until
 * hosts.yml changes, TOKEN_TTL_MS (NO_TOKEN_TTL_MS for "no token") passes, or
 * GitHub refuses the token; concurrent callers share one gh run.
 * Only an answer gh gave is reused: a failed run is asked again next time.
 */
export async function getGhCliToken(host, login) {
  const hostKey = hostKeyFor(host);
  const key = `${hostKey}\n${loginKeyFor(login)}`;
  const stamp = await ghStateStamp();
  const answer = answers.get(key);
  const ttl = answer?.token === null ? NO_TOKEN_TTL_MS : TOKEN_TTL_MS;
  if (answer && answer.stamp === stamp && Date.now() - answer.at < ttl) return answer.token;
  const running = lookups.get(key);
  if (running && running.stamp === stamp) return running.promise;
  const at = Date.now();
  const promise = fetchGhCliToken(hostKey, loginArgumentFor(login)).then(({ token, answered }) => {
    if (answered) answers.set(key, { stamp, at, token });
    else answers.delete(key);
    return token;
  }).finally(() => {
    if (lookups.get(key)?.promise === promise) lookups.delete(key);
  });
  lookups.set(key, { stamp, promise });
  return promise;
}

/**
 * Forgets the reused answer for `host` when it is `token`, which GitHub just
 * refused. A token belongs to one account, so every login's answer for that
 * host carrying it is dropped; the next read asks gh again.
 */
export function forgetGhCliToken(host, token) {
  const prefix = `${hostKeyFor(host)}\n`;
  for (const [key, answer] of answers) {
    if (key.startsWith(prefix) && answer.token === token) answers.delete(key);
  }
}
