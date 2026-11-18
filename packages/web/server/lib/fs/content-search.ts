
import { StringDecoder } from 'node:string_decoder';
import type nodePath from 'node:path';
import type { spawn as nodeSpawn, ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';

import { isRecord, isString } from '../shared/guards.js';

interface RipgrepText {
  text?: unknown;
  bytes?: unknown;
}

interface RipgrepEvent {
  type?: unknown;
  data?: unknown;
}

interface RipgrepMatchData {
  path?: unknown;
  lines?: unknown;
  submatches?: unknown;
  line_number?: unknown;
}

interface RipgrepSubmatch {
  start: number;
  end: number;
}

interface RipgrepMatch {
  pathBytes: Buffer;
  lineBytes: Buffer;
  line: number;
  submatches: RipgrepSubmatch[];
}

export interface ContentMatch {
  path: string;
  relativePath: string;
  line: number;
  column: number;
  text: string;
  ranges: [number, number][];
  cutStart: boolean;
}

export type ContentSearchResult =
  | { status: 'ok'; matches: ContentMatch[]; stopped: 'limit' | 'deadline' | null }
  | { status: 'unavailable' }
  | { status: 'invalid-pattern' | 'failed'; message: string }
  | { status: 'aborted' };

interface ContentSearchRuntimeOptions {
  spawn: typeof nodeSpawn;
  path: Pick<typeof nodePath, 'sep' | 'join'>;
  resolveRipgrepBinary: () => Promise<string | null>;
  deadlineMs?: number;
}

export interface ContentSearchOptions {
  query: string;
  regex: boolean;
  includeHidden?: boolean;
  respectGitignore?: boolean;
  resultRoot?: string | null | undefined;
  limit?: number;
  signal?: AbortSignal;
}

const isRipgrepText = (value: unknown): value is RipgrepText => isRecord(value);
const isRipgrepEvent = (value: unknown): value is RipgrepEvent => isRecord(value);
const isRipgrepMatchData = (value: unknown): value is RipgrepMatchData => isRecord(value);
const isRipgrepSubmatch = (value: unknown): value is RipgrepSubmatch => (
  isRecord(value) && value !== null && typeof value === 'object'
  && 'start' in value && Number.isInteger(value.start)
  && 'end' in value && Number.isInteger(value.end)
);
const isLineNumber = (value: unknown): value is number => Number.isInteger(value);

export const CONTENT_SEARCH_DEFAULT_LIMIT = 200;
export const CONTENT_SEARCH_MAX_LIMIT = 500;
export const CONTENT_SEARCH_MAX_QUERY_LENGTH = 1024;
const CONTENT_SEARCH_DEADLINE_MS = 30_000;

const PREVIEW_UNCUT_MATCH_START = 48;
const PREVIEW_LEAD_CHARS = 24;
const PREVIEW_MAX_CHARS = 200;
const MAX_RANGES_PER_LINE = 32;
const STDERR_MAX_BYTES = 64 * 1024;

const decodeRipgrepText = (value: RipgrepText | null) => {
  if (!value) return null;
  if (isString(value.text)) return Buffer.from(String(value.text), 'utf8');
  if (isString(value.bytes)) return Buffer.from(String(value.bytes), 'base64');
  return null;
};

const readRipgrepMatch = (event: RipgrepEvent) => {
  if (event.type !== 'match' || !isRipgrepMatchData(event.data)) return null;
  const { data } = event;
  const pathBytes = decodeRipgrepText(isRipgrepText(data.path) ? data.path : null);
  const lineBytes = decodeRipgrepText(isRipgrepText(data.lines) ? data.lines : null);
  const submatches = Array.isArray(data.submatches)
    ? data.submatches.filter(isRipgrepSubmatch)
    : [];
  if (!pathBytes || !lineBytes || !isLineNumber(data.line_number) || data.line_number < 1 || submatches.length === 0) return null;
  return { pathBytes, lineBytes, line: data.line_number, submatches };
};

const toCharRanges = (lineBytes: Buffer, submatches: RipgrepSubmatch[]) => {
  const ranges: [number, number][] = [];
  let byteCursor = 0;
  let charCursor = 0;
  const advance = (byteOffset: number) => {
    const clamped = Math.min(Math.max(byteOffset, byteCursor), lineBytes.length);
    charCursor += lineBytes.subarray(byteCursor, clamped).toString('utf8').length;
    byteCursor = clamped;
    return charCursor;
  };
  for (const submatch of submatches.slice(0, MAX_RANGES_PER_LINE)) {
    const start = advance(submatch.start);
    const end = advance(submatch.end);
    if (end > start) ranges.push([start, end]);
  }
  return ranges;
};

const buildPreview = (lineBytes: Buffer, submatches: RipgrepSubmatch[]) => {
  const fullText = lineBytes.toString('utf8').replace(/\r?\n$/, '');
  const fullRanges = toCharRanges(lineBytes, submatches);
  const firstMatchStart = fullRanges[0]?.[0] ?? 0;

  const indentation = /^\s*/.exec(fullText)?.[0].length ?? 0;
  const cut = firstMatchStart - indentation > PREVIEW_UNCUT_MATCH_START
    ? firstMatchStart - PREVIEW_LEAD_CHARS
    : indentation;
  const text = fullText.slice(cut, cut + PREVIEW_MAX_CHARS);
  const ranges: [number, number][] = [];
  for (const [start, end] of fullRanges) {
    const shiftedStart = Math.max(0, start - cut);
    const shiftedEnd = Math.min(text.length, end - cut);
    if (shiftedEnd > shiftedStart) ranges.push([shiftedStart, shiftedEnd]);
  }

  return {
    column: firstMatchStart + 1,
    text,
    ranges,
    cutStart: cut > indentation,
  };
};

const INVALID_PATTERN_PATTERN = /regex parse error|error parsing|unrecognized escape/i;

const failureMessage = (stderr: string, fallback: string) => {
  const lines = stderr.split(/\r?\n/).map((part) => part.trim()).filter(Boolean);
  const line = lines.find((candidate) => /^error:/i.test(candidate)) ?? lines[0];
  return line ? line.replace(/^(?:rg|error):\s*/i, '') : fallback;
};

export const createContentSearchRuntime = ({
  spawn,
  path,
  resolveRipgrepBinary,
  deadlineMs = CONTENT_SEARCH_DEADLINE_MS,
}: ContentSearchRuntimeOptions) => {
  const ripgrepArguments = ({ query, regex, includeHidden, respectGitignore }: ContentSearchOptions) => {
    const args = [
      '--json',
      '--no-config',
      '--smart-case',
      '--glob', '!.git',
      '--glob', '!node_modules',
    ];
    if (includeHidden) args.push('--hidden');
    if (!respectGitignore) args.push('--no-ignore');
    if (!regex) args.push('--fixed-strings');
    args.push('-e', query, '--', '.');
    return args;
  };

  const toRelativePath = (ripgrepPath: string) => {
    const trimmed = ripgrepPath.replace(/^\.[\\/]/, '');
    return path.sep === '\\' ? trimmed.split('\\').join('/') : trimmed;
  };

  const searchFileContents = async (rootPath: string, options: ContentSearchOptions): Promise<ContentSearchResult> => {
    const resultRoot = options.resultRoot || rootPath;
    const binary = await resolveRipgrepBinary();
    if (!binary) return { status: 'unavailable' };
    if (options.signal?.aborted) return { status: 'aborted' };

    const limit = Math.min(Math.max(1, options.limit ?? CONTENT_SEARCH_DEFAULT_LIMIT), CONTENT_SEARCH_MAX_LIMIT);

    return new Promise<ContentSearchResult>((resolve) => {
      let child: ChildProcessByStdio<null, Readable, Readable>;
      try {
        child = spawn(binary, ripgrepArguments(options), {
          cwd: rootPath,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (error) {
        resolve({ status: 'failed', message: error instanceof Error ? error.message : String(error) });
        return;
      }

      const matches: ContentMatch[] = [];
      let stopped: 'limit' | 'deadline' | null = null;
      let aborted = false;
      let settled = false;
      let stderr = '';
      const stdoutDecoder = new StringDecoder('utf8');
      let pending: string[] = [];

      const finish = (result: ContentSearchResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        options.signal?.removeEventListener('abort', onAbort);
        resolve(result);
      };

      const stop = (reason: 'abort' | 'limit' | 'deadline') => {
        if (stopped || aborted) return;
        if (reason === 'abort') aborted = true;
        else stopped = reason;
        child.kill();
      };

      const onAbort = () => stop('abort');
      options.signal?.addEventListener('abort', onAbort, { once: true });
      const deadline = setTimeout(() => stop('deadline'), deadlineMs);
      deadline.unref?.();

      const takeMatch = ({ pathBytes, lineBytes, line, submatches }: RipgrepMatch) => {
        const relativePath = toRelativePath(pathBytes.toString('utf8'));
        if (!relativePath) return;
        matches.push({
          path: path.join(resultRoot, relativePath),
          relativePath,
          line,
          ...buildPreview(lineBytes, submatches),
        });
        if (matches.length >= limit) stop('limit');
      };

      const consume = (line: string) => {
        if (!line || stopped || aborted) return;
        let event: unknown;
        try {
          event = JSON.parse(line);
        } catch {
          return;
        }
        const match = isRipgrepEvent(event) ? readRipgrepMatch(event) : null;
        if (match) takeMatch(match);
      };

      child.stdout.on('data', (chunk: Buffer) => {
        const text = stdoutDecoder.write(chunk);
        let lineStart = 0;
        let newline = text.indexOf('\n');
        while (newline !== -1) {
          pending.push(text.slice(lineStart, newline));
          consume(pending.join(''));
          pending = [];
          lineStart = newline + 1;
          newline = text.indexOf('\n', lineStart);
        }
        if (lineStart < text.length) pending.push(text.slice(lineStart));
      });
      child.stderr.on('data', (chunk: Buffer) => {
        if (stderr.length < STDERR_MAX_BYTES) stderr += chunk.toString('utf8', 0, STDERR_MAX_BYTES - stderr.length);
      });
      child.on('error', (error) => finish({ status: 'failed', message: error.message }));
      child.on('close', (code) => {
        if (aborted) {
          finish({ status: 'aborted' });
          return;
        }
        pending.push(stdoutDecoder.end());
        consume(pending.join(''));
        matches.sort((a, b) => (a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : a.line - b.line));
        if (stopped || code === 0 || code === 1 || matches.length > 0) {
          finish({ status: 'ok', matches, stopped });
          return;
        }
        if (INVALID_PATTERN_PATTERN.test(stderr)) {
          finish({ status: 'invalid-pattern', message: failureMessage(stderr, 'Invalid regular expression') });
          return;
        }
        finish({ status: 'failed', message: failureMessage(stderr, `ripgrep exited with code ${code}`) });
      });
    });
  };

  return { searchFileContents };
};
