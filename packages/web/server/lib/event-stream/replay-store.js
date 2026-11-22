import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readBoundedFileSync } from '../shared/bounded-file-read.js';

// Durable state for the global stream's local frames. Append-only so a commit is one small write
// before the frame is sent, compacted into a snapshot so the file stays bounded.
//
// The records:
//   { t: 'local', ...entry }            one non-reconstructible local frame
//   { t: 'head', p, u }                 the newest stream position and upstream OpenCode cursor
//   { t: 'trim', p }                    local entries at or below p were dropped by retention
//   { t: 'reset', p, u }                upstream resynced: nothing before p may be replayed
//   { t: 'snapshot', ... }              a compacted replacement for everything before it

const STORE_VERSION = 1;

const RECORD_KIND_LOCAL = 'local';
const RECORD_KIND_HEAD = 'head';
const RECORD_KIND_TRIM = 'trim';
const RECORD_KIND_RESET = 'reset';
const RECORD_KIND_SNAPSHOT = 'snapshot';

const DEFAULT_COMPACT_AFTER_RECORDS = 4096;
const DEFAULT_COMPACT_AFTER_BYTES = 8 * 1024 * 1024;
// Room for the retained snapshot, JSON escaping, and the append log between compactions.
export const MAX_REPLAY_FILE_BYTES = 32 * 1024 * 1024;

export function resolveGlobalReplayFilePath(env = process.env, home = os.homedir()) {
  const configured = env.OPENCHAMBER_DATA_DIR === undefined || env.OPENCHAMBER_DATA_DIR === null
    ? ''
    : `${env.OPENCHAMBER_DATA_DIR}`.trim();
  const dataDir = configured ? path.resolve(configured) : path.join(home, '.config', 'openchamber');
  return path.join(dataDir, 'event-stream', 'global-replay.jsonl');
}

const isPosition = (value) => Number.isSafeInteger(value) && value >= 0;

const sanitizeHead = (head) => ({
  position: isPosition(head?.position) ? head.position : 0,
  upstream: head?.upstream === undefined || head?.upstream === null ? '' : `${head.upstream}`,
});

// Entries crossing the file boundary are untrusted: a partial append or an edited file must not
// resurrect a frame with a torn payload.
const sanitizeEntry = (entry) => {
  if (!entry || !isPosition(entry.position)) return null;
  const serializedFrame = `${entry.serializedFrame ?? ''}`;
  if (serializedFrame.length === 0) return null;
  if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0) return null;
  if (!isPosition(entry.committedAt)) return null;
  return {
    position: entry.position,
    upstream: entry.upstream === undefined || entry.upstream === null ? '' : `${entry.upstream}`,
    eventId: entry.eventId === undefined || entry.eventId === null ? undefined : `${entry.eventId}`,
    serializedFrame,
    bytes: entry.bytes,
    committedAt: entry.committedAt,
  };
};

const sortAndDedupe = (entries) => {
  const byPosition = new Map();
  for (const entry of entries) byPosition.set(entry.position, entry);
  return [...byPosition.values()].sort((left, right) => left.position - right.position);
};

/**
 * Creates the durable replay store. Without a `filePath` it keeps the same records in memory, which
 * is what tests use to simulate a restart and what a hub runs with outside production.
 */
export function createReplayStore({
  filePath = null,
  now = () => Date.now(),
  warn = (message) => console.warn(`[event-stream] ${message}`),
  compactAfterRecords = DEFAULT_COMPACT_AFTER_RECORDS,
  compactAfterBytes = DEFAULT_COMPACT_AFTER_BYTES,
} = {}) {
  let head = { position: 0, upstream: '' };
  let entries = [];
  let droppedLocalThroughPosition = 0;
  let recordsSinceSnapshot = 0;
  let appendedBytes = 0;
  let writeFailed = false;
  let persistenceDisabled = false;
  let repairBeforeWrite = false;
  // Encoded records whose append failed. They are not committed — the state
  // below never advances past them — and they must land, in order, before
  // any later record, so the persisted head can never skip a failed frame
  // (#2111). A later successful write flushes them first; a reset clears
  // them, because a reset supersedes everything before it.
  let pendingLines = [];

  const noteWriteFailure = (error) => {
    if (!writeFailed) {
      warn(`could not persist replay state to ${filePath}: ${error?.message ?? error}`);
      writeFailed = true;
    }
  };

  const appendLine = (line) => {
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    fs.appendFileSync(filePath, line, { mode: 0o600 });
    recordsSinceSnapshot += 1;
    appendedBytes += Buffer.byteLength(line);
    writeFailed = false;
  };

  const flushPending = () => {
    while (pendingLines.length > 0) {
      try {
        appendLine(pendingLines[0]);
      } catch (error) {
        noteWriteFailure(error);
        return false;
      }
      pendingLines.shift();
    }
    return true;
  };

  // Returns whether the record is durable. With no persistence configured
  // (or persistence disabled at load) the store is in-memory by design and
  // every write counts as committed; a failed append to a configured file
  // is queued behind pendingLines and reported as not committed.
  const write = (record) => {
    if (!filePath || persistenceDisabled) return true;
    if (repairBeforeWrite) {
      compact();
      if (repairBeforeWrite) return false;
    }
    let line;
    try {
      line = `${JSON.stringify(record)}\n`;
    } catch (error) {
      warn(`could not encode a replay record: ${error?.message ?? error}`);
      return false;
    }
    if (!flushPending()) {
      pendingLines.push(line);
      return false;
    }
    try {
      appendLine(line);
    } catch (error) {
      noteWriteFailure(error);
      pendingLines.push(line);
      return false;
    }
    return true;
  };

  const applySnapshot = (record) => {
    head = sanitizeHead(record.head);
    entries = sortAndDedupe((Array.isArray(record.entries) ? record.entries : []).map(sanitizeEntry).filter(Boolean));
    droppedLocalThroughPosition = isPosition(record.droppedLocalThroughPosition)
      ? record.droppedLocalThroughPosition
      : 0;
  };

  const applyRecord = (record) => {
    if (record === null || record === undefined) return;
    if (record.v !== undefined && record.v !== STORE_VERSION) return;
    switch (record.t) {
      case RECORD_KIND_SNAPSHOT:
        applySnapshot(record);
        break;
      case RECORD_KIND_LOCAL: {
        const entry = sanitizeEntry(record.entry);
        if (!entry) return;
        if (entry.position > head.position) head = { position: entry.position, upstream: entry.upstream };
        entries.push(entry);
        break;
      }
      case RECORD_KIND_HEAD: {
        const next = sanitizeHead({ position: record.p, upstream: record.u });
        if (next.position >= head.position) head = next;
        break;
      }
      case RECORD_KIND_TRIM:
        if (isPosition(record.p)) {
          droppedLocalThroughPosition = Math.max(droppedLocalThroughPosition, record.p);
          entries = entries.filter((entry) => entry.position > record.p);
        }
        break;
      case RECORD_KIND_RESET: {
        const next = sanitizeHead({ position: record.p, upstream: record.u });
        head = { position: Math.max(head.position, next.position), upstream: next.upstream };
        droppedLocalThroughPosition = Math.max(droppedLocalThroughPosition, head.position);
        entries = [];
        break;
      }
      default:
        break;
    }
  };

  const load = () => {
    if (filePath) {
      recordsSinceSnapshot = 0;
      appendedBytes = 0;
      head = { position: 0, upstream: '' };
      entries = [];
      droppedLocalThroughPosition = 0;
      repairBeforeWrite = false;
      pendingLines = [];
      let text = '';
      try {
        const result = readBoundedFileSync(filePath, MAX_REPLAY_FILE_BYTES);
        if (result.ok) {
          text = result.buffer.toString('utf8');
        } else if (result.reason !== 'missing') {
          warn(`could not read replay state from ${filePath}: ${result.reason}`);
          persistenceDisabled = true;
        }
      } catch (error) {
        warn(`could not read replay state from ${filePath}: ${error?.message ?? error}`);
        persistenceDisabled = true;
      }
      const lines = text.split('\n');
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index].trim();
        if (!line) continue;
        let record;
        try {
          record = JSON.parse(line);
        } catch {
          repairBeforeWrite = true;
          // A torn final line is expected after a killed process; anything after it is not trusted.
          if (index < lines.length - 1) {
            warn(`ignored replay state after a malformed record in ${filePath}`);
          }
          break;
        }
        applyRecord(record);
        recordsSinceSnapshot += 1;
        appendedBytes += Buffer.byteLength(lines[index]) + (index < lines.length - 1 ? 1 : 0);
      }
      if (text.length > 0 && !text.endsWith('\n')) repairBeforeWrite = true;
      entries = sortAndDedupe(entries).filter((entry) => entry.position > droppedLocalThroughPosition);
      const newest = entries.at(-1);
      if (newest && newest.position > head.position) {
        head = { position: newest.position, upstream: newest.upstream };
      }
    }
    return state();
  };

  const state = () => ({
    head: { ...head },
    entries: entries.map((entry) => ({ ...entry })),
    droppedLocalThroughPosition,
  });

  const compact = () => {
    if (persistenceDisabled) return;
    // A snapshot reflects only committed state; never compact past a
    // record that has not landed yet.
    if (pendingLines.length > 0 && !flushPending()) return;
    if (!filePath) {
      recordsSinceSnapshot = 0;
      appendedBytes = 0;
      return;
    }
    const snapshot = {
      v: STORE_VERSION,
      t: RECORD_KIND_SNAPSHOT,
      head: { ...head },
      entries,
      droppedLocalThroughPosition,
    };
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
      const temporaryPath = `${filePath}.${process.pid}.tmp`;
      fs.writeFileSync(temporaryPath, `${JSON.stringify(snapshot)}\n`, { mode: 0o600 });
      fs.renameSync(temporaryPath, filePath);
      recordsSinceSnapshot = 1;
      appendedBytes = Buffer.byteLength(JSON.stringify(snapshot));
      writeFailed = false;
      repairBeforeWrite = false;
    } catch (error) {
      if (!writeFailed) {
        warn(`could not compact replay state at ${filePath}: ${error?.message ?? error}`);
        writeFailed = true;
      }
    }
  };

  const maybeCompact = () => {
    if (recordsSinceSnapshot >= compactAfterRecords || appendedBytes >= compactAfterBytes) {
      compact();
    }
  };

  return {
    load,
    state,
    // The append methods return whether the change was committed. On a
    // failed durable write nothing advances — not the entries, not the
    // head — so in-memory state never claims more than the file holds.
    appendLocal(entry) {
      const sanitized = sanitizeEntry(entry);
      if (!sanitized) return false;
      if (!write({ v: STORE_VERSION, t: RECORD_KIND_LOCAL, entry: sanitized })) return false;
      entries.push(sanitized);
      if (sanitized.position > head.position) {
        head = { position: sanitized.position, upstream: sanitized.upstream };
      }
      maybeCompact();
      return true;
    },
    appendHead(nextHead) {
      const sanitized = sanitizeHead(nextHead);
      if (sanitized.position < head.position) return true;
      if (!write({ v: STORE_VERSION, t: RECORD_KIND_HEAD, p: sanitized.position, u: sanitized.upstream })) return false;
      head = sanitized;
      maybeCompact();
      return true;
    },
    appendTrim(throughPosition) {
      if (!isPosition(throughPosition) || throughPosition <= droppedLocalThroughPosition) return true;
      if (!write({ v: STORE_VERSION, t: RECORD_KIND_TRIM, p: throughPosition })) return false;
      droppedLocalThroughPosition = throughPosition;
      entries = entries.filter((entry) => entry.position > throughPosition);
      maybeCompact();
      return true;
    },
    appendReset({ position, upstream }) {
      const sanitized = sanitizeHead({ position: Math.max(head.position, position), upstream });
      // A reset supersedes every earlier record, committed or still pending.
      pendingLines = [];
      if (!write({ v: STORE_VERSION, t: RECORD_KIND_RESET, p: sanitized.position, u: sanitized.upstream })) return false;
      head = sanitized;
      droppedLocalThroughPosition = Math.max(droppedLocalThroughPosition, sanitized.position);
      entries = [];
      maybeCompact();
      return true;
    },
    now,
  };
}
