import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isString } from './validation.js';

const execFileAsync = promisify(execFile);

// glab has no `auth token` command. `config get token --host` reads a token
// stored in glab's config without a network call; `auth status --show-token`
// also covers keyring and environment tokens and prints them on stderr.
const TOKEN_LINE = /^\s*(?:[^\s\w]\s*)?Token(?: found(?: in [^:\n]*)?)?:\s*(\S+)\s*$/m;

// The messages glab prints only when it ran and has no login for the host:
// "<host> has not been authenticated with glab" and, with no login at all,
// "no GitLab instances have been authenticated with glab". Anything else it
// says without a token line cannot decide: a locked keyring reports "could not
// read the token", and a logout that keeps the host reports "No token found".
// Absence of these messages is therefore unknown, never gone.
const NO_GLAB_LOGIN = /authenticated with glab/;

const outputText = (value) => (isString(value) ? value : '');

function readToken(result) {
  if (isString(result)) return result;
  return `${outputText(result?.stdout)}\n${outputText(result?.stderr)}`;
}

async function runGlab(run, args, timeoutMs) {
  try {
    return await run('glab', args, { encoding: 'utf8', timeout: timeoutMs, windowsHide: true });
  } catch (error) {
    // `auth status` exits non-zero when any check fails but may still print the token.
    if (error?.code === 'ENOENT') throw error;
    return { stdout: error?.stdout, stderr: error?.stderr, failed: error };
  }
}

function warnLookupFailure(error) {
  // Only the error code: glab output can contain the token itself.
  const reason = error?.killed ? 'timeout' : isString(error?.code) ? error.code : 'unknown';
  console.warn(`[gitlab] glab credential lookup failed (${reason})`);
}

/**
 * One host-scoped glab lookup, with how much the answer is worth:
 * - `{ token }`: glab produced a token for the host.
 * - `{ gone: true }`: glab ran and has no login for the host.
 * - `{ unknown: true, reason }`: glab could not answer (missing, timed out),
 *   so whether a login exists stays unsettled. Only `gone` may undo the
 *   user's CLI switch; the others must not.
 */
export async function getGlabTokenResult(origin, options = {}) {
  const run = options.execFile ?? execFileAsync;
  const hostname = new URL(origin).host;
  const timeoutMs = options.timeoutMs ?? 5_000;
  try {
    const stored = await runGlab(run, ['config', 'get', 'token', '--host', hostname], timeoutMs);
    const storedToken = stored.failed ? '' : outputText(isString(stored) ? stored : stored.stdout).trim();
    if (storedToken && !/\s/.test(storedToken)) return { token: storedToken };

    const status = await runGlab(run, ['auth', 'status', '--hostname', hostname, '--show-token'], timeoutMs);
    const output = readToken(status);
    const token = TOKEN_LINE.exec(output)?.[1] ?? '';
    if (token && !/^\*+$/.test(token)) return { token };
    // A plain exit means glab answered; only its exact no-login messages say
    // the login is really gone. A timeout or spawn failure says nothing
    // about whether a login exists.
    if (status.failed && !Number.isInteger(status.failed.code)) {
      warnLookupFailure(status.failed);
      return { unknown: true, reason: status.failed.killed ? 'timeout' : 'unknown' };
    }
    if (NO_GLAB_LOGIN.test(output)) return { gone: true };
    // An exit glab ran with but whose output names no known state (a locked
    // keyring, an unrecognized message) leaves the question unsettled.
    return { unknown: true, reason: 'unrecognized' };
  } catch (error) {
    if (error?.code === 'ENOENT') return { unknown: true, reason: 'missing' };
    warnLookupFailure(error);
    return { unknown: true, reason: 'unknown' };
  }
}

/** The token of the glab login for a host, or null when there is none. */
export async function getGlabToken(origin, options = {}) {
  const result = await getGlabTokenResult(origin, options);
  return result.token ?? null;
}
