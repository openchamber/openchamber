import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

import yaml from 'yaml';
import { z } from 'zod';

import { isString } from '../shared/guards.js';
import { normalizeGiteaInstance } from './instance.js';

const execFileAsync = promisify(execFile);

const MISSING_GT_RETRY_MS = 60_000;

const NO_GT_LOGIN = /no account for |is not logged in on |no active account on |signs requests with an SSH key and has no token/;
const GT_AUTHENTICATION_EXIT = 4;

const outputText = (value) => (isString(value) ? value : '');

const runGt = (run, args, timeoutMs) => run('gt', [...args, '--no-input'], {
  encoding: 'utf8', timeout: timeoutMs, windowsHide: true,
});

function failureReason(error) {
  if (error?.code === 'ENOENT') return 'missing';
  if (error?.killed) return 'timeout';
  return 'unknown';
}

function warnLookupFailure(error) {
  const reason = error?.killed ? 'timeout' : isString(error?.code) || Number.isInteger(error?.code) ? error.code : 'unknown';
  console.warn(`[gitea] gt credential lookup failed (${reason})`);
}

const accountSchema = z.object({ auth_method: z.string().optional() }).passthrough().nullable();
const hostSchema = z.object({
  user: z.string().optional(),
  users: z.record(z.string(), accountSchema).optional(),
}).passthrough().nullable();
const hostsSchema = z.object({ hosts: z.record(z.string(), z.unknown()).nullable().optional() }).passthrough().nullable();
const TOKENLESS_METHODS = new Set(['ssh', 'httpsign']);

function instancesFromHosts(text) {
  const parsed = hostsSchema.safeParse(yaml.parse(text));
  if (!parsed.success || !parsed.data?.hosts) return [];
  const instances = [];
  for (const [url, entry] of Object.entries(parsed.data.hosts)) {
    const host = hostSchema.safeParse(entry);
    const active = host.success ? host.data?.user : undefined;
    if (!active) continue;
    if (TOKENLESS_METHODS.has(host.data.users?.[active]?.auth_method ?? '')) continue;
    try { instances.push(normalizeGiteaInstance(url)); } catch { /* not an origin this provider takes */ }
  }
  return [...new Set(instances)];
}

export function createGtCli({ execFile: run = execFileAsync, readFile: read = readFile, timeoutMs = 5_000, now = Date.now } = {}) {
  const tokenResult = async (origin) => {
    try {
      const { stdout } = await runGt(run, ['auth', 'token', '--host', origin], timeoutMs);
      const token = outputText(stdout).trim();
      if (token && !/\s/.test(token)) return { token };
      return { unknown: true, reason: 'unrecognized' };
    } catch (error) {
      if (error?.code === GT_AUTHENTICATION_EXIT && NO_GT_LOGIN.test(outputText(error.stderr))) return { gone: true };
      if (error?.code !== 'ENOENT') warnLookupFailure(error);
      return { unknown: true, reason: Number.isInteger(error?.code) ? 'unrecognized' : failureReason(error) };
    }
  };

  let hostsPath = null;
  let missingSince = null;
  const locateHosts = async () => {
    if (hostsPath) return hostsPath;
    if (missingSince !== null && now() - missingSince < MISSING_GT_RETRY_MS) return null;
    try {
      const { stdout } = await runGt(run, ['config', 'path'], timeoutMs);
      const line = outputText(stdout).split(/\r?\n/).find((entry) => entry.startsWith('hosts\t'));
      hostsPath = line ? line.slice('hosts\t'.length).trim() || null : null;
    } catch (error) {
      if (error?.code !== 'ENOENT') warnLookupFailure(error);
    }
    missingSince = hostsPath ? null : now();
    return hostsPath;
  };

  const listInstances = async () => {
    const path = await locateHosts();
    if (!path) return [];
    try {
      return instancesFromHosts(await read(path, 'utf8'));
    } catch {
      return [];
    }
  };

  return Object.freeze({ tokenResult, listInstances });
}
