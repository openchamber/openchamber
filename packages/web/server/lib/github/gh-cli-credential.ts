import { execFile } from 'child_process';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { ghConfigDir } from './gh-config.js';
import { hasProperty } from './contracts.js';
import type { ExecFileOptionsWithStringEncoding } from 'node:child_process';

interface GhTokenOptions extends ExecFileOptionsWithStringEncoding {
  stdio: ['pipe', 'pipe', 'pipe'];
}

interface TokenAnswer {
  token: string | null;
  answered: boolean;
}

interface CachedAnswer {
  token: string | null;
  stamp: string;
  at: number;
}

interface RunningLookup {
  stamp: string;
  promise: Promise<string | null>;
}

const execFileAsync = promisify(execFile);

const TOKEN_TTL_MS = 5 * 60_000;
const NO_TOKEN_TTL_MS = 30_000;

const hostKeyFor = (host: string | null | undefined) => {
  const value = (host ?? '').trim().toLowerCase();
  return value && value !== 'github.com' ? value : 'github.com';
};

const loginKeyFor = (login: string | null | undefined) => String(login ?? '').trim().toLowerCase();
const loginArgumentFor = (login: string | null | undefined) => String(login ?? '').trim();

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

async function fetchGhCliToken(hostKey: string, login: string): Promise<TokenAnswer> {
  const env = { ...process.env };
  env.GH_HOST = hostKey;
  const args = ['auth', 'token'];
  if (login) args.push('--user', login);
  try {
    const options: GhTokenOptions = {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 5000,
      windowsHide: true,
      env,
    };
    const { stdout } = await execFileAsync('gh', args, options);
    return { token: stdout.trim() || null, answered: true };
  } catch (error) {
    return { token: null, answered: Number.isInteger(hasProperty(error, 'code') ? error.code : undefined) };
  }
}

const answers = new Map<string, CachedAnswer>();
const lookups = new Map<string, RunningLookup>();

export async function getGhCliToken(host?: string | null, login?: string | null) {
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

export function forgetGhCliToken(host: string | null | undefined, token: string) {
  const prefix = `${hostKeyFor(host)}\n`;
  for (const [key, answer] of answers) {
    if (key.startsWith(prefix) && answer.token === token) answers.delete(key);
  }
}
