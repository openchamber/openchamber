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

const NUL = 0;
const NUL_BYTES = Buffer.from([NUL]);
const COMMAND_SCOPE = Buffer.from('command');
const COMMAND_LINE_ORIGIN = Buffer.from('command line:');
const EXTRA_HEADER_KEY = /^http(\..+)?\.extraheader$/;
const TRACE_HEADER = /^(traceparent|tracestate)[ \t]*:/i;
const normalizedTraceMetadata = (scope: Buffer, origin: Buffer, entry: Buffer) => {
  if (!scope.equals(COMMAND_SCOPE) || !origin.equals(COMMAND_LINE_ORIGIN)) return null;
  const text = entry.toString('utf8');
  const separator = text.indexOf('\n');
  if (separator < 0) return null;
  const key = text.slice(0, separator);
  const header = TRACE_HEADER.exec(text.slice(separator + 1));
  if (!EXTRA_HEADER_KEY.test(key) || !header?.[1]) return null;
  return Buffer.from(`${key}\n${header[1].toLowerCase()}:`);
};
const withNormalizedTraceMetadata = (output: Buffer) => {
  const fields: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < output.length; index += 1) {
    if (output[index] !== NUL) continue;
    fields.push(output.subarray(start, index));
    start = index + 1;
  }
  if (start < output.length) fields.push(output.subarray(start));
  if (fields.length % 3 !== 0) return output;
  const kept: Buffer[] = [];
  for (let index = 0; index < fields.length; index += 3) {
    const scope = fields[index];
    const origin = fields[index + 1];
    const entry = fields[index + 2];
    if (scope === undefined || origin === undefined || entry === undefined) return output;
    kept.push(scope, NUL_BYTES, origin, NUL_BYTES, normalizedTraceMetadata(scope, origin, entry) ?? entry, NUL_BYTES);
  }
  return Buffer.concat(kept);
};

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
    return digest(Buffer.concat([withNormalizedTraceMetadata(configOutput), Buffer.from([0]), Buffer.from(checkoutConfigObjects)]));
  } catch {
    throw Object.assign(new Error('Effective Git transport configuration is unavailable'), {
      code: 'STALE_CONFIG',
      status: 409,
    });
  }
}
