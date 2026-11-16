import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isString } from './validation.js';

const execFileAsync = promisify(execFile);

const TOKEN_LINE = /^\s*(?:[^\s\w]\s*)?Token(?: found(?: in [^:\n]*)?)?:\s*(\S+)\s*$/m;

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
    if (error?.code === 'ENOENT') throw error;
    return { stdout: error?.stdout, stderr: error?.stderr, failed: error };
  }
}

function warnLookupFailure(error) {
  const reason = error?.killed ? 'timeout' : isString(error?.code) ? error.code : 'unknown';
  console.warn(`[gitlab] glab credential lookup failed (${reason})`);
}

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
    if (status.failed && !Number.isInteger(status.failed.code)) {
      warnLookupFailure(status.failed);
      return { unknown: true, reason: status.failed.killed ? 'timeout' : 'unknown' };
    }
    if (NO_GLAB_LOGIN.test(output)) return { gone: true };
    return { unknown: true, reason: 'unrecognized' };
  } catch (error) {
    if (error?.code === 'ENOENT') return { unknown: true, reason: 'missing' };
    warnLookupFailure(error);
    return { unknown: true, reason: 'unknown' };
  }
}

export async function getGlabToken(origin, options = {}) {
  const result = await getGlabTokenResult(origin, options);
  return result.token ?? null;
}
