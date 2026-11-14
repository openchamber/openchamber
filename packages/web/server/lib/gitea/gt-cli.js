import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

import yaml from 'yaml';
import { z } from 'zod';

import { isString } from '../shared/guards.js';
import { normalizeGiteaInstance } from './instance.js';

const execFileAsync = promisify(execFile);

// How long a failed `gt config path` keeps gt counted as absent, so a gt
// installed while the server runs is found without asking on every listing.
const MISSING_GT_RETRY_MS = 60_000;

// gt exits 4 for every authentication failure, a locked keyring included.
// Only these messages say it ran and has no token for the instance: no
// account, an account that is not logged in, no active account among several,
// or an account that signs requests with an SSH key.
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
  // Only the reason: gt output can contain the token itself.
  const reason = error?.killed ? 'timeout' : isString(error?.code) || Number.isInteger(error?.code) ? error.code : 'unknown';
  console.warn(`[gitea] gt credential lookup failed (${reason})`);
}

// hosts.yml maps each instance URL to its active `user` and its `users` by
// name; an account that signs with an SSH key has no token to read.
const accountSchema = z.object({ auth_method: z.string().optional() }).passthrough().nullable();
const hostSchema = z.object({
  user: z.string().optional(),
  users: z.record(z.string(), accountSchema).optional(),
}).passthrough().nullable();
const hostsSchema = z.object({ hosts: z.record(z.string(), z.unknown()).nullable().optional() }).passthrough().nullable();
const TOKENLESS_METHODS = new Set(['ssh', 'httpsign']);

/** The instances in gt's hosts.yml whose active account has a token, as Gitea origins. */
function instancesFromHosts(text) {
  const parsed = hostsSchema.safeParse(yaml.parse(text));
  if (!parsed.success || !parsed.data?.hosts) return [];
  const instances = [];
  for (const [url, entry] of Object.entries(parsed.data.hosts)) {
    const host = hostSchema.safeParse(entry);
    const active = host.success ? host.data?.user : undefined;
    if (!active) continue;
    if (TOKENLESS_METHODS.has(host.data.users?.[active]?.auth_method ?? '')) continue;
    // An install under a sub-path cannot be served (`instance.js`).
    try { instances.push(normalizeGiteaInstance(url)); } catch { /* not an origin this provider takes */ }
  }
  return [...new Set(instances)];
}

/**
 * Gitea's `gt` CLI, read without a shell: the token of its login for an
 * instance, and the instances it has a login for. `execFile` and `readFile`
 * are test seams.
 */
export function createGtCli({ execFile: run = execFileAsync, readFile: read = readFile, timeoutMs = 5_000, now = Date.now } = {}) {
  /**
   * One instance-scoped lookup, with how much the answer is worth:
   * - `{ token }`: gt printed a token for the instance.
   * - `{ gone: true }`: gt ran and has no token for the instance.
   * - `{ unknown: true, reason }`: gt could not answer (missing, timed out, a
   *   locked keyring, an unrecognized failure), so whether a login exists stays
   *   unsettled. Only `gone` may undo the user's CLI switch.
   */
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

  // Where gt keeps hosts.yml, as `gt config path` names it: it follows
  // GITEA_CLI_CONFIG_DIR and each platform's configuration directory.
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

  /** Every Gitea origin gt has a token login for; empty when gt is missing or its hosts.yml unreadable. */
  const listInstances = async () => {
    const path = await locateHosts();
    if (!path) return [];
    try {
      return instancesFromHosts(await read(path, 'utf8'));
    } catch {
      // No hosts.yml yet (gt never logged in) or one that does not parse.
      return [];
    }
  };

  return Object.freeze({ tokenResult, listInstances });
}
