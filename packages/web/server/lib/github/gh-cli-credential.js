import { execFile } from 'child_process';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { ghConfigDir } from './gh-config.js';

const execFileAsync = promisify(execFile);

const TOKEN_TTL_MS = 5 * 60_000;
const NO_TOKEN_TTL_MS = 30_000;

const hostKeyFor = (host) => {
  const value = (host ?? '').trim().toLowerCase();
  return value && value !== 'github.com' ? value : 'github.com';
};

const loginKeyFor = (login) => String(login ?? '').trim().toLowerCase();
const loginArgumentFor = (login) => String(login ?? '').trim();

async function ghStateStamp() {
  const directory = ghConfigDir();
  try {
    const info = await stat(join(directory, 'hosts.yml'));
    return `${directory}|${info.mtimeMs}:${info.size}:${info.ino}`;
  } catch {
    return `${directory}|missing`;
  }
}

export const ghConfigStamp = ghStateStamp;

async function fetchGhCliToken(hostKey, login) {
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
    return { token: null, answered: Number.isInteger(error?.code) };
  }
}

const answers = new Map();
const lookups = new Map();

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

export function forgetGhCliToken(host, token) {
  const prefix = `${hostKeyFor(host)}\n`;
  for (const [key, answer] of answers) {
    if (key.startsWith(prefix) && answer.token === token) answers.delete(key);
  }
}
