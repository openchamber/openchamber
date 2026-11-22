import type fsPromisesModule from 'node:fs/promises';
import fs from 'node:fs';
import { hasErrorCode } from './contracts.js';

export interface PlanProgress {
  done: number;
  total: number;
}

interface PlanSummary {
  title: string;
  progress: PlanProgress | null;
  mtimeMs: number;
  // Set when the plan is past the read cap: listed, but not read.
  tooLarge?: boolean;
}

// The read side of fs/promises this module uses; open is optional so a test
// double with readFile alone still reads (unbounded beyond the size check).
type BoundedReadFs = Pick<typeof fsPromisesModule, 'stat' | 'readFile'> & Partial<Pick<typeof fsPromisesModule, 'open'>>;

interface PlanSummaryCacheDependencies {
  fsPromises: BoundedReadFs;
  parseTitle: (raw: string) => string;
}

const STEPS_HEADING = /^##\s+steps\s*$/i;
const SECTION_END = /^#{1,2}\s/;
const CHECKLIST_ITEM = /^\s*[-*+]\s+\[([ xX])\]\s/;

/**
 * Largest plan file the read paths will buffer whole, in bytes.
 *
 * Plans this app writes are clamped to 200,000 characters
 * (PROJECT_PLAN_BODY_MAX_LENGTH in runtime.js) - at most ~800,000 bytes of
 * UTF-8 - but shared plan files are also written by other tools with no
 * clamp. 1 MiB leaves headroom over every app-written plan while keeping
 * one oversized file from being loaded whole into the server.
 */
export const PLAN_FILE_READ_MAX_BYTES = 1024 * 1024;

/**
 * Read a file as UTF-8 reading at most `maxBytes + 1` bytes from one open
 * handle, so a file that grows after its `stat` can never be buffered
 * whole. Returns the text, or null when the file holds more than
 * `maxBytes` bytes at read time. Falls back to a plain read when the
 * injected fs has no `open` (test doubles); the fallback still refuses an
 * over-cap result, it just cannot bound the transient buffer.
 *
 * The open carries O_NONBLOCK on POSIX and the entry is judged a regular
 * file from the opened handle — the bound-and-judge contract of
 * lib/shared/bounded-file-read.js — so a FIFO at a plan path is refused
 * promptly (error code BOUNDED_FILE_NOT_REGULAR) instead of blocking at
 * open forever. A handle with no `stat` (a test double) cannot be judged
 * and is read as before.
 */

// O_NONBLOCK keeps open() itself from blocking on a FIFO with no writer
// before the handle stat can reject it as non-regular.
const PLAN_READ_OPEN_FLAGS = process.platform === 'win32'
  ? 'r'
  : fs.constants.O_RDONLY | fs.constants.O_NONBLOCK;
export const readBoundedUtf8 = async (fsPromises: BoundedReadFs, filePath: string, maxBytes: number) => {
  if (!fsPromises.open) {
    const raw = await fsPromises.readFile(filePath, 'utf8');
    return Buffer.byteLength(raw, 'utf8') > maxBytes ? null : raw;
  }
  const handle = await fsPromises.open(filePath, PLAN_READ_OPEN_FLAGS);
  try {
    const stat = await handle.stat();
    if (stat && !stat.isFile()) {
      throw Object.assign(new Error(`plan file is not a regular file: ${filePath}`), { code: 'BOUNDED_FILE_NOT_REGULAR' });
    }
    const buffer = Buffer.alloc(maxBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return offset > maxBytes ? null : buffer.subarray(0, offset).toString('utf8');
  } finally {
    await handle.close();
  }
};

export const parsePlanProgress = (raw: string): PlanProgress | null => {
  const lines = raw.replace(/\r\n?/g, '\n').split('\n');
  const start = lines.findIndex((line) => STEPS_HEADING.test(line));
  if (start === -1) return null;
  let done = 0;
  let total = 0;
  for (const line of lines.slice(start + 1)) {
    if (SECTION_END.test(line)) break;
    const item = line.match(CHECKLIST_ITEM);
    if (!item) continue;
    total += 1;
    if (item[1] !== ' ') done += 1;
  }
  return total === 0 ? null : { done, total };
};

/**
 * Most plan summaries the cache holds at once.
 *
 * The cache is one server-lifetime instance shared by every project, and the
 * list flow only ever queries paths a listing just returned, so an entry for
 * a deleted or renamed plan is never queried again and nothing else would
 * ever remove it. The cap matches the sibling plan-metrics cache: past it,
 * the least recently used entry goes first, which is exactly the orphaned
 * entries - live plans are re-listed (and so refreshed) constantly.
 */
export const PLAN_SUMMARY_CACHE_MAX_ENTRIES = 500;


export const createPlanSummaryCache = ({ fsPromises, parseTitle }: PlanSummaryCacheDependencies) => {
  const entries = new Map<string, { mtimeMs: number; size: number; summary: PlanSummary }>();

  /** Remember one entry, evicting least recently used entries past the cap. */
  const remember = (filePath: string, entry: { mtimeMs: number; size: number; summary: PlanSummary }) => {
    entries.delete(filePath);
    while (entries.size >= PLAN_SUMMARY_CACHE_MAX_ENTRIES) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
    entries.set(filePath, entry);
  };

  const summaryOf = async (filePath: string): Promise<PlanSummary | null> => {
    let stat;
    try {
      stat = await fsPromises.stat(filePath);
    } catch (error) {
      if (hasErrorCode(error) && error.code === 'ENOENT') {
        entries.delete(filePath);
        return null;
      }
      throw error;
    }
    const cached = entries.get(filePath);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      // A hit makes this the most recently used entry, so the entries the
      // list flow has stopped querying age out first at the cap.
      entries.delete(filePath);
      entries.set(filePath, cached);
      return cached.summary;
    }
    if (stat.size > PLAN_FILE_READ_MAX_BYTES) {
      const summary = { title: 'Plan', progress: null, mtimeMs: stat.mtimeMs, tooLarge: true };
      remember(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, summary });
      return summary;
    }
    const raw = await readBoundedUtf8(fsPromises, filePath, PLAN_FILE_READ_MAX_BYTES);
    if (raw === null) {
      // Grew past the cap between the stat above and this read.
      const summary = { title: 'Plan', progress: null, mtimeMs: stat.mtimeMs, tooLarge: true };
      remember(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, summary });
      return summary;
    }
    const summary = { title: parseTitle(raw), progress: parsePlanProgress(raw), mtimeMs: stat.mtimeMs };
    remember(filePath, { mtimeMs: stat.mtimeMs, size: stat.size, summary });
    return summary;
  };

  return { summaryOf };
};
