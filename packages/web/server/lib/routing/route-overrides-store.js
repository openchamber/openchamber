/**
 * Overrides that OpenCode reads at routing time, and the feedback log the
 * interpreter learns from. Both live beside each other in OpenCode's data
 * directory, the same place OpenCode resolves `route-overrides.json`, so the
 * file format here must stay in step with `ModelRouteOverrides.parse`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { renameSyncWithRetry } from '../shared/atomic-rename.js';
import { readBoundedFileSync } from '../shared/bounded-file-read.js';
import {
  isJsonObject,
  preserveMalformedJsonFileSync,
  readDurableJsonFileSync,
  writeDurableJsonFileSync,
} from '../shared/durable-json-store.js';

const ACTIONS = ['avoid', 'prefer', 'allow-over-budget'];
const MAX_ROUTE_FEEDBACK_BYTES = 4 * 1024 * 1024;
const RETAIN_ROUTE_FEEDBACK_BYTES = 3 * 1024 * 1024;
const MAX_COMPACT_RETRIES = 3;
const ROUTE_FEEDBACK_OPEN_FLAGS = fs.constants.O_RDWR
  | fs.constants.O_APPEND
  | fs.constants.O_CREAT
  | (process.platform === 'win32' ? 0 : fs.constants.O_NONBLOCK);

const discardFeedbackSnapshot = (temporary) => {
  try {
    fs.unlinkSync(temporary);
  } catch {
    // The rename or another cleanup may already have consumed the temporary path.
  }
};

const writeFeedbackSnapshot = (file, initialBuffer, initialExpectedSize, mode) => {
  let buffer = initialBuffer;
  let expectedSize = initialExpectedSize;
  let currentMode = mode;

  for (let attempt = 0; attempt < MAX_COMPACT_RETRIES; attempt++) {
    if (buffer === null) {
      let fd;
      try {
        fd = fs.openSync(file, fs.constants.O_RDONLY | (process.platform === 'win32' ? 0 : fs.constants.O_NONBLOCK));
        try {
          const stat = fs.fstatSync(fd);
          if (!stat.isFile() || stat.size <= MAX_ROUTE_FEEDBACK_BYTES) return;
          expectedSize = stat.size;
          buffer = feedbackTail(fd, expectedSize);
          currentMode = stat.mode & 0o777;
        } finally {
          fs.closeSync(fd);
        }
      } catch (error) {
        if (error?.code === 'ENOENT') return;
        throw error;
      }
    }

    const temporary = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      fs.writeFileSync(temporary, buffer, { mode: currentMode });

      let statBeforeRename;
      try {
        statBeforeRename = fs.statSync(file);
      } catch (error) {
        discardFeedbackSnapshot(temporary);
        if (error?.code === 'ENOENT') return;
        throw error;
      }

      if (!statBeforeRename.isFile() || statBeforeRename.size <= MAX_ROUTE_FEEDBACK_BYTES) {
        // The file was already compacted by another process, or is no longer a regular file.
        discardFeedbackSnapshot(temporary);
        return;
      }

      if (statBeforeRename.size !== expectedSize) {
        // Another process appended while the snapshot was prepared.
        // Discard this snapshot and retry so the newer append is retained.
        discardFeedbackSnapshot(temporary);
        buffer = null;
        continue;
      }

      renameSyncWithRetry((from, to) => fs.renameSync(from, to), temporary, file);
      return;
    } catch (error) {
      discardFeedbackSnapshot(temporary);
      throw error;
    }
  }
};

const feedbackTail = (fd, size) => {
  const start = Math.max(0, size - RETAIN_ROUTE_FEEDBACK_BYTES);
  const tail = Buffer.alloc(size - start);
  let total = 0;
  while (total < tail.length) {
    const bytesRead = fs.readSync(fd, tail, total, tail.length - total, start + total);
    if (bytesRead === 0) break;
    total += bytesRead;
  }

  let retained = tail.subarray(0, total);
  if (start > 0) {
    const firstLineEnd = retained.indexOf(0x0a);
    retained = firstLineEnd < 0 ? Buffer.alloc(0) : retained.subarray(firstLineEnd + 1);
  }
  return retained;
};

export const resolveOpenCodeDataDir = (env = process.env) => {
  const base = env.XDG_DATA_HOME?.trim() || path.join(os.homedir(), '.local', 'share');
  return path.join(base, 'opencode');
};

const strings = (value) =>
  Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : [];

const parseOverride = (item) => {
  if (!item || typeof item !== 'object') return null;
  if (typeof item.id !== 'string' || !ACTIONS.includes(item.action)) return null;
  if (typeof item.until !== 'number' || !Number.isFinite(item.until)) return null;
  const providers = strings(item.providers);
  const models = strings(item.models);
  if (providers.length === 0 && models.length === 0) return null;
  const factor = typeof item.factor === 'number' && Number.isFinite(item.factor) && item.factor > 0 ? item.factor : undefined;
  return {
    id: item.id,
    action: item.action,
    providers,
    models,
    routes: strings(item.routes),
    fixed: item.fixed !== false,
    ...(factor !== undefined ? { factor } : {}),
    until: item.until,
    text: typeof item.text === 'string' ? item.text : '',
    summary: typeof item.summary === 'string' ? item.summary : '',
    source: item.source === 'interpreter' ? 'interpreter' : 'user',
    createdAt: typeof item.createdAt === 'number' ? item.createdAt : 0,
    ...(item.origin && typeof item.origin.key === 'string' && typeof item.origin.option === 'string'
      ? { origin: { key: item.origin.key, option: item.origin.option } }
      : {}),
  };
};

export const createOverrideStore = ({ dataDir = resolveOpenCodeDataDir(), now = () => Date.now() } = {}) => {
  const overridesFile = path.join(dataDir, 'route-overrides.json');
  const feedbackFile = path.join(dataDir, 'route-feedback.jsonl');

  // This store rides the shared durable-store primitive (design #976):
  // the sync spellings match this store's synchronous read and save. The
  // value judgement stays this store's own: the file is an object whose
  // `overrides`, when present, is an array; anything else is as malformed
  // as unparseable bytes. The parse error itself is never logged: Node's
  // JSON.parse messages quote the file content, and override text is the
  // user's own sentence.
  const validateValue = (value) =>
    isJsonObject(value) && (value.overrides === undefined || Array.isArray(value.overrides));

  const readAll = () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let result;
      try {
        result = readDurableJsonFileSync(overridesFile, { validateValue });
      } catch (error) {
        // A read failure other than absence (EACCES, EISDIR, ...) warns
        // and reads as empty, the behaviour this store always had; the
        // primitive answers absence itself as 'missing'.
        console.warn('Failed to read route overrides file:', error);
        return [];
      }
      if (result.state === 'valid') {
        const list = result.value.overrides;
        return Array.isArray(list) ? list.map(parseOverride).filter(Boolean) : [];
      }
      // The primitive collapses an absent file and an existing empty file
      // into 'missing'. An empty file holds no overrides, so there is
      // nothing to preserve in either case.
      if (result.state === 'missing') return [];
      // A torn or otherwise unparseable overrides file is user data, not
      // an empty store: move its bytes aside before any later save can
      // overwrite them, and name the preserved copy so the loss is
      // recoverable.
      const preservation = preserveMalformedJsonFileSync(overridesFile, { validateValue });
      if (preservation.preserved) {
        console.warn(`Failed to read route overrides file: preserved the unreadable file at ${preservation.preservedPath}`);
        return [];
      }
      // A valid replacement landed while the malformed bytes were being
      // judged: read that file instead of answering from the stale one.
      if (preservation.outcome === 'replaced') continue;
      console.warn('Failed to read route overrides file: the file could not be parsed');
      console.warn('Failed to preserve the unreadable route overrides file');
      return [];
    }
    return [];
  };

  const save = (overrides) => {
    const live = overrides.filter((item) => item.until > now());
    fs.mkdirSync(dataDir, { recursive: true });
    // A save must not overwrite an unpreserved corrupt file: the preserve
    // helper re-reads and re-judges the on-disk bytes, and any failure to
    // read, judge, or preserve them refuses the save. A valid file, an
    // absent file, and an empty file need no preservation and the save
    // proceeds.
    const preservation = preserveMalformedJsonFileSync(overridesFile, { validateValue });
    if (preservation.outcome === 'failed') {
      throw new Error(`Refusing to overwrite the unreadable route overrides file at ${overridesFile}: it could not be preserved`);
    }
    if (preservation.preserved) {
      console.warn(`Failed to read route overrides file: preserved the unreadable file at ${preservation.preservedPath}`);
    }
    // The file mode is stated explicitly through the primitive: this
    // store never restricted its file (a plain write under the process
    // umask), so 0o666 keeps the effective mode it always had.
    writeDurableJsonFileSync(overridesFile, JSON.stringify({ version: 1, overrides: live }, null, 2), { mode: 0o666 });
    return live;
  };

  const list = () => readAll().filter((item) => item.until > now());

  const add = (items) => {
    const incoming = new Set(items.map((item) => item.id));
    return save([...readAll().filter((existing) => !incoming.has(existing.id)), ...items]);
  };

  const remove = (id) => {
    const existing = readAll();
    if (!existing.some((item) => item.id === id)) return false;
    save(existing.filter((item) => item.id !== id));
    return true;
  };

  const recordFeedback = (entry) => {
    fs.mkdirSync(dataDir, { recursive: true });
    const line = Buffer.from(`${JSON.stringify({ time: now(), ...entry })}\n`);
    // An entry larger than the compaction retention window cannot survive
    // compaction as a complete line.
    if (line.length > RETAIN_ROUTE_FEEDBACK_BYTES) {
      throw new RangeError(`Route feedback entries must fit within ${RETAIN_ROUTE_FEEDBACK_BYTES} bytes`);
    }

    const fd = fs.openSync(feedbackFile, ROUTE_FEEDBACK_OPEN_FLAGS, 0o666);
    let retained = null;
    let initialSize = 0;
    let mode = 0o666;
    try {
      if (!fs.fstatSync(fd).isFile()) throw new Error(`Route feedback file is not a regular file: ${feedbackFile}`);
      let written = 0;
      while (written < line.length) {
        const bytesWritten = fs.writeSync(fd, line, written, line.length - written, null);
        if (bytesWritten === 0) throw new Error(`Failed to append route feedback: ${feedbackFile}`);
        written += bytesWritten;
      }
      const stat = fs.fstatSync(fd);
      if (stat.size > MAX_ROUTE_FEEDBACK_BYTES) {
        retained = feedbackTail(fd, stat.size);
        initialSize = stat.size;
        mode = stat.mode & 0o777;
      }
    } finally {
      fs.closeSync(fd);
    }
    if (retained !== null) {
      try {
        writeFeedbackSnapshot(feedbackFile, retained, initialSize, mode);
      } catch (error) {
        console.warn(`Failed to compact route feedback file: ${error?.code ?? 'I/O failure'}`);
      }
    }
  };

  const readFeedback = () => {
    let result;
    try {
      result = readBoundedFileSync(feedbackFile, MAX_ROUTE_FEEDBACK_BYTES);
    } catch (error) {
      console.warn(`Failed to read route feedback file: ${error?.code ?? 'I/O failure'}`);
      return [];
    }
    if (!result.ok) {
      if (result.reason === 'missing') return [];
      if (result.reason === 'too-large') {
        console.warn(`Route feedback file exceeds the ${MAX_ROUTE_FEEDBACK_BYTES}-byte limit: ${feedbackFile}`);
      } else {
        console.warn(`Route feedback file is not a regular file: ${feedbackFile}`);
      }
      return [];
    }
    const text = result.buffer.toString('utf8');
    return text
      .split('\n')
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
  };

  return { list, add, remove, recordFeedback, readFeedback, overridesFile, feedbackFile };
};
