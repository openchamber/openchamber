import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isString } from './validation.js';

const execFileAsync = promisify(execFile);

export interface GlabFailure {
  code?: unknown;
  killed?: unknown;
  stdout?: unknown;
  stderr?: unknown;
}

export interface GlabProcessOutput {
  stdout?: unknown;
  stderr?: unknown;
}

type GlabCommandOutput = (string | GlabProcessOutput) & { failed?: GlabFailure | null | undefined };

export interface GlabLookupOptions {
  execFile?: ((file: string, args: string[], options: { encoding: 'utf8'; timeout: number; windowsHide: true }) => Promise<GlabCommandOutput>) | undefined;
  timeoutMs?: number | undefined;
}

export type GlabTokenResult =
  | { token: string; unknown?: never; gone?: never; reason?: never }
  | { token?: never; unknown: true; gone?: never; reason: 'missing' | 'timeout' | 'unknown' | 'unrecognized' }
  | { token?: never; unknown?: never; gone: true; reason?: never };

const hasFailureFields = (value: unknown): value is GlabFailure => value != null;

const TOKEN_LINE = /^\s*(?:[^\s\w]\s*)?Token(?: found(?: in [^:\n]*)?)?:\s*(\S+)\s*$/m;

const NO_GLAB_LOGIN = /authenticated with glab/;

function readToken(result: GlabCommandOutput) {
  if (isString(result)) return result;
  const stdout = result?.stdout;
  const stderr = result?.stderr;
  return `${isString(stdout) ? stdout : ''}\n${isString(stderr) ? stderr : ''}`;
}

async function runGlab(run: NonNullable<GlabLookupOptions['execFile']>, args: string[], timeoutMs: number): Promise<GlabCommandOutput> {
  try {
    return await run('glab', args, { encoding: 'utf8', timeout: timeoutMs, windowsHide: true });
  } catch (error) {
    if (!hasFailureFields(error)) return { stdout: undefined, stderr: undefined, failed: error === null ? null : undefined };
    if (error.code === 'ENOENT') throw error;
    return { stdout: error.stdout, stderr: error.stderr, failed: error };
  }
}

function warnLookupFailure(error: GlabFailure | null | undefined) {
  const reason = error?.killed ? 'timeout' : isString(error?.code) ? error.code : 'unknown';
  console.warn(`[gitlab] glab credential lookup failed (${reason})`);
}

export async function getGlabTokenResult(origin: string, options: GlabLookupOptions = {}): Promise<GlabTokenResult> {
  const run = options.execFile ?? execFileAsync;
  const hostname = new URL(origin).host;
  const timeoutMs = options.timeoutMs ?? 5_000;
  try {
    const stored = await runGlab(run, ['config', 'get', 'token', '--host', hostname], timeoutMs);
    let storedToken = '';
    if (!stored.failed) {
      const output = isString(stored) ? stored : stored.stdout;
      storedToken = (isString(output) ? output : '').trim();
    }
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
    if (hasFailureFields(error) && error.code === 'ENOENT') return { unknown: true, reason: 'missing' };
    warnLookupFailure(hasFailureFields(error) ? error : undefined);
    return { unknown: true, reason: 'unknown' };
  }
}

export async function getGlabToken(origin: string, options: GlabLookupOptions = {}) {
  const result = await getGlabTokenResult(origin, options);
  return result.token ?? null;
}
