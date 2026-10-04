import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isString } from './validation.js';

const execFileAsync = promisify(execFile);

// glab has no `auth token` command. `config get token --host` reads a token
// stored in glab's config without a network call; `auth status --show-token`
// also covers keyring and environment tokens and prints them on stderr.
const TOKEN_LINE = /^\s*(?:[^\s\w]\s*)?Token(?: found)?:\s*(\S+)\s*$/m;

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

export async function getGlabToken(origin, options = {}) {
  const run = options.execFile ?? execFileAsync;
  const hostname = new URL(origin).host;
  const timeoutMs = options.timeoutMs ?? 5_000;
  try {
    const stored = await runGlab(run, ['config', 'get', 'token', '--host', hostname], timeoutMs);
    const storedToken = stored.failed ? '' : outputText(isString(stored) ? stored : stored.stdout).trim();
    if (storedToken && !/\s/.test(storedToken)) return storedToken;

    const status = await runGlab(run, ['auth', 'status', '--hostname', hostname, '--show-token'], timeoutMs);
    const token = TOKEN_LINE.exec(readToken(status))?.[1] ?? '';
    if (token && !/^\*+$/.test(token)) return token;
    // A plain non-zero exit means glab has no login for this host; a timeout
    // or spawn failure is worth a trace.
    if (status.failed && !Number.isInteger(status.failed.code)) warnLookupFailure(status.failed);
    return null;
  } catch (error) {
    if (error?.code !== 'ENOENT') warnLookupFailure(error);
    return null;
  }
}
