
import { StringDecoder } from 'node:string_decoder';

import { isRecord, isString } from '../shared/guards.js';

export const CONTENT_SEARCH_DEFAULT_LIMIT = 200;
export const CONTENT_SEARCH_MAX_LIMIT = 500;
export const CONTENT_SEARCH_MAX_QUERY_LENGTH = 1024;
const CONTENT_SEARCH_DEADLINE_MS = 30_000;

const PREVIEW_UNCUT_MATCH_START = 48;
const PREVIEW_LEAD_CHARS = 24;
const PREVIEW_MAX_CHARS = 200;
const MAX_RANGES_PER_LINE = 32;
const STDERR_MAX_BYTES = 64 * 1024;

const decodeRipgrepText = (value) => {
  if (!isRecord(value)) return null;
  if (isString(value.text)) return Buffer.from(String(value.text), 'utf8');
  if (isString(value.bytes)) return Buffer.from(String(value.bytes), 'base64');
  return null;
};

const readRipgrepMatch = (event) => {
  if (!isRecord(event) || event.type !== 'match' || !isRecord(event.data)) return null;
  const { data } = event;
  const pathBytes = decodeRipgrepText(data.path);
  const lineBytes = decodeRipgrepText(data.lines);
  const submatches = Array.isArray(data.submatches)
    ? data.submatches.filter((submatch) => isRecord(submatch) && Number.isInteger(submatch.start) && Number.isInteger(submatch.end))
    : [];
  if (!pathBytes || !lineBytes || !Number.isInteger(data.line_number) || data.line_number < 1 || submatches.length === 0) return null;
  return { pathBytes, lineBytes, line: data.line_number, submatches };
};

const toCharRanges = (lineBytes, submatches) => {
  const ranges = [];
  let byteCursor = 0;
  let charCursor = 0;
  const advance = (byteOffset) => {
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

const buildPreview = (lineBytes, submatches) => {
  const fullText = lineBytes.toString('utf8').replace(/\r?\n$/, '');
  const fullRanges = toCharRanges(lineBytes, submatches);
  const firstMatchStart = fullRanges[0]?.[0] ?? 0;

  const indentation = /^\s*/.exec(fullText)?.[0].length ?? 0;
  const cut = firstMatchStart - indentation > PREVIEW_UNCUT_MATCH_START
    ? firstMatchStart - PREVIEW_LEAD_CHARS
    : indentation;
  const text = fullText.slice(cut, cut + PREVIEW_MAX_CHARS);
  const ranges = [];
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

const failureMessage = (stderr, fallback) => {
  const lines = stderr.split(/\r?\n/).map((part) => part.trim()).filter(Boolean);
  const line = lines.find((candidate) => /^error:/i.test(candidate)) ?? lines[0];
  return line ? line.replace(/^(?:rg|error):\s*/i, '') : fallback;
};

export const createContentSearchRuntime = ({
  spawn,
  path,
  resolveRipgrepBinary,
  deadlineMs = CONTENT_SEARCH_DEADLINE_MS,
}) => {
  const ripgrepArguments = ({ query, regex, includeHidden, respectGitignore }) => {
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

  const toRelativePath = (ripgrepPath) => {
    const trimmed = ripgrepPath.replace(/^\.[\\/]/, '');
    return path.sep === '\\' ? trimmed.split('\\').join('/') : trimmed;
  };

  /**
   * @returns one of
   *   `{ status: 'ok', matches, stopped: null | 'limit' | 'deadline' }`,
   *   `{ status: 'unavailable' }` when there is no ripgrep to run,
   *   `{ status: 'invalid-pattern', message }` for a regex ripgrep rejects,
   *   `{ status: 'failed', message }` for any other failure,
   *   `{ status: 'aborted' }` when the caller's signal fired first.
   */
  const searchFileContents = async (rootPath, options) => {
    const resultRoot = options.resultRoot || rootPath;
    const binary = await resolveRipgrepBinary();
    if (!binary) return { status: 'unavailable' };
    if (options.signal?.aborted) return { status: 'aborted' };

    const limit = Math.min(Math.max(1, options.limit ?? CONTENT_SEARCH_DEFAULT_LIMIT), CONTENT_SEARCH_MAX_LIMIT);

    return new Promise((resolve) => {
      let child;
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

      const matches = [];
      let stopped = null;
      let aborted = false;
      let settled = false;
      let stderr = '';
      const stdoutDecoder = new StringDecoder('utf8');
      let pending = [];

      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        options.signal?.removeEventListener('abort', onAbort);
        resolve(result);
      };

      const stop = (reason) => {
        if (stopped || aborted) return;
        if (reason === 'abort') aborted = true;
        else stopped = reason;
        child.kill();
      };

      const onAbort = () => stop('abort');
      options.signal?.addEventListener('abort', onAbort, { once: true });
      const deadline = setTimeout(() => stop('deadline'), deadlineMs);
      deadline.unref?.();

      const takeMatch = ({ pathBytes, lineBytes, line, submatches }) => {
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

      const consume = (line) => {
        if (!line || stopped || aborted) return;
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          return;
        }
        const match = readRipgrepMatch(event);
        if (match) takeMatch(match);
      };

      child.stdout.on('data', (chunk) => {
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
      child.stderr.on('data', (chunk) => {
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
