import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { hasSourceControlErrorCode } from '../source-control/input-guards.js';
import type { ExecFileOptionsWithBufferEncoding } from 'node:child_process';

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_BUFFER = 256 * 1024;
const TRANSPORT_CONFIG_PATTERN = [
  '^(',
  'credential(\\..*)?\\.(helper|usehttppath|username)',
  '|core\\.(sshcommand|askpass)',
  '|url\\..*\\.(insteadof|pushinsteadof)',
  '|http(\\..*)?\\..+',
  '|remote\\..*\\.proxy',
  '|remote\\..*\\.lfsurl',
  '|lfs\\.(url|standalonetransferagent)',
  '|lfs\\.customtransfer\\..*',
  '|filter\\.lfs\\.(clean|smudge|process|required)',
  '|submodule\\..*\\.(url|update)',
  ')$',
].join('');

const digest = (value: Buffer) => crypto.createHash('sha256').update(value).digest('base64url');

export interface TransportRevisionOptions {
  gitBinary?: string;
  execFileImpl?: (file: string, args: string[], options: ExecFileOptionsWithBufferEncoding) => Promise<{ stdout: Buffer }>;
  timeoutMs?: number;
  maxBuffer?: number;
}

const hasExecutionDetails = (value: unknown): value is { code: number; killed?: unknown; signal?: unknown } =>
  hasSourceControlErrorCode(value) && typeof value.code === 'number';

const hasExecutionStderr = (value: unknown): value is { stderr: string | Buffer } =>
  value !== null && typeof value === 'object' && 'stderr' in value
  && (typeof value.stderr === 'string' || Buffer.isBuffer(value.stderr));

export async function readEffectiveGitTransportRevision(directory: string, {
  gitBinary = 'git',
  execFileImpl = execFileAsync,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxBuffer = DEFAULT_MAX_BUFFER,
}: TransportRevisionOptions = {}) {
  const options: ExecFileOptionsWithBufferEncoding & { stdio: string[] } = {
    cwd: directory,
    encoding: null,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: timeoutMs,
    maxBuffer,
    shell: false,
    windowsHide: true,
  };
  try {
    let configOutput;
    try {
      ({ stdout: configOutput } = await execFileImpl(gitBinary, [
      'config', '--includes', '--show-origin', '--show-scope', '--null',
      '--get-regexp', TRANSPORT_CONFIG_PATTERN,
      ], options));
    } catch (error) {
      if (hasExecutionDetails(error) && error.code === 1 && !error.killed && !error.signal) configOutput = Buffer.alloc(0);
      else throw error;
    }
    let checkoutConfigObjects;
    try {
      ({ stdout: checkoutConfigObjects } = await execFileImpl(gitBinary, [
        'ls-tree', '-z', 'HEAD', '--', '.gitmodules', '.lfsconfig', '.gitattributes',
      ], options));
    } catch (error) {
      const stderr = Buffer.from(hasExecutionStderr(error) ? error.stderr : '').toString('utf8');
      if (hasExecutionDetails(error) && error.code === 128 && /not a valid object name HEAD|bad revision 'HEAD'/i.test(stderr)) {
        checkoutConfigObjects = Buffer.alloc(0);
      } else {
        throw error;
      }
    }
    return digest(Buffer.concat([Buffer.from(configOutput), Buffer.from([0]), Buffer.from(checkoutConfigObjects)]));
  } catch {
    throw Object.assign(new Error('Effective Git transport configuration is unavailable'), {
      code: 'STALE_CONFIG',
      status: 409,
    });
  }
}
