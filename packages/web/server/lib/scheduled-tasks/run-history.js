import fs from 'node:fs';
import path from 'node:path';

// Durable per-run history for scheduled tasks (developing-today/code#2174,
// Gap 1). The scheduler emits `openchamber:scheduled-task-ran` events, but
// before this store nothing persisted them: the live task records keep only
// latest-run fields, so no per-run outcome dataset existed for the
// Muse↔OpenChamber comparison or a watchdog.
//
// The store is fed every run event from the single emit choke point in
// index.js. A `running` event opens a run; the matching terminal event
// (`success` | `error`) appends exactly one row. Rows are append-only JSONL
// on disk and mirrored in memory for reads; a malformed line on disk is
// skipped at load, never fatal. Token usage stays null until the exporter
// (developing-today/code#2072) can supply it — the bound session id is the
// join key when it lands.
//
// Retention bound (#2116): the store keeps at most MAX_RUN_HISTORY_ROWS
// rows — the newest — in memory and on disk. An append that crosses the
// cap compacts the file from the retained rows, and startup reads at
// most the last MAX_RUN_HISTORY_LOAD_BYTES of the file, so neither disk
// nor startup memory grows with total historical runs. Dedupe covers
// retained rows only: a terminal event for a row already aged out is
// not recognised as a duplicate.

const TERMINAL_STATUSES = new Set(['success', 'error']);
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;
const MAX_RUN_HISTORY_ROWS = 5000;
const MAX_RUN_HISTORY_LOAD_BYTES = 8 * 1024 * 1024; // 8 MiB, the tracked-items cap

const runKey = (projectID, taskID, sessionID) =>
  `${projectID}\0${taskID}\0${sessionID ?? ''}`;

const isValidRow = (row) =>
  row !== null
  && typeof row === 'object'
  && typeof row.projectId === 'string' && row.projectId.length > 0
  && typeof row.taskId === 'string' && row.taskId.length > 0
  && typeof row.finishedAt === 'number'
  && TERMINAL_STATUSES.has(row.outcome);

export const createScheduledTaskRunHistory = ({
  filePath,
  logger = console,
  maxRows = MAX_RUN_HISTORY_ROWS,
  maxLoadBytes = MAX_RUN_HISTORY_LOAD_BYTES,
} = {}) => {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw new Error('scheduled-task run history requires a filePath');
  }
  const rowCap = Number.isSafeInteger(maxRows) && maxRows > 0 ? maxRows : MAX_RUN_HISTORY_ROWS;
  const loadCap = Number.isSafeInteger(maxLoadBytes) && maxLoadBytes > 0
    ? maxLoadBytes
    : MAX_RUN_HISTORY_LOAD_BYTES;

  const rows = [];
  const openRuns = new Map();
  const appendedTerminalKeys = new Set();

  // Bounded startup load (#2116): read at most the last loadCap
  // bytes — the newest rows live at the tail — so a history file
  // grown large before this bound existed cannot buffer arbitrarily
  // much memory at startup. A read that starts mid-line drops the
  // partial first line; the per-line tolerance below handles the rest.
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const { size } = fs.fstatSync(fd);
      const readStart = Math.max(0, size - loadCap);
      const length = size - readStart;
      const buffer = Buffer.alloc(length);
      if (length > 0) fs.readSync(fd, buffer, 0, length, readStart);
      let raw = buffer.toString('utf8');
      if (readStart > 0) {
        const firstNewline = raw.indexOf('\n');
        raw = firstNewline === -1 ? '' : raw.slice(firstNewline + 1);
      }
      for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const row = JSON.parse(trimmed);
          if (isValidRow(row)) {
            rows.push(row);
            appendedTerminalKeys.add(`${runKey(row.projectId, row.taskId, row.sessionId)}\0${row.finishedAt}\0${row.outcome}`);
          }
        } catch {
          // A torn final write or a hand-edited line must not lose the rest.
        }
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      logger.warn?.('[scheduled-tasks] run history load failed:', error?.message ?? error);
    }
  }

  // Retention also trims what a pre-bound file already held: only
  // the newest rowCap rows (and their dedupe keys) are kept.
  if (rows.length > rowCap) {
    const dropped = rows.splice(0, rows.length - rowCap);
    for (const row of dropped) {
      appendedTerminalKeys.delete(`${runKey(row.projectId, row.taskId, row.sessionId)}\0${row.finishedAt}\0${row.outcome}`);
    }
  }

  const recordEvent = (event) => {
    try {
      const projectID = typeof event?.projectID === 'string' ? event.projectID : '';
      const taskID = typeof event?.taskID === 'string' ? event.taskID : '';
      const status = typeof event?.status === 'string' ? event.status : '';
      const ranAt = typeof event?.ranAt === 'number' ? event.ranAt : Date.now();
      const sessionID = typeof event?.sessionID === 'string' && event.sessionID.length > 0
        ? event.sessionID
        : null;
      const taskName = typeof event?.taskName === 'string' && event.taskName.length > 0
        ? event.taskName
        : null;
      if (!projectID || !taskID) return;

      const key = runKey(projectID, taskID, sessionID);
      if (status === 'running') {
        openRuns.set(key, { startedAt: ranAt, taskName });
        return;
      }
      if (!TERMINAL_STATUSES.has(status)) {
        // 'queued' and any future non-terminal status are not run boundaries.
        return;
      }

      const dedupeKey = `${key}\0${ranAt}\0${status}`;
      if (appendedTerminalKeys.has(dedupeKey)) return;

      const open = openRuns.get(key);
      openRuns.delete(key);
      const row = {
        projectId: projectID,
        taskId: taskID,
        taskName: taskName ?? open?.taskName ?? null,
        startedAt: open?.startedAt ?? null,
        finishedAt: ranAt,
        outcome: status,
        sessionId: sessionID,
        tokens: null,
      };
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`);
      rows.push(row);
      appendedTerminalKeys.add(dedupeKey);
      if (rows.length > rowCap) {
        // Retention (#2116): newest rowCap rows win. Rewrite the file
        // from the retained in-memory rows so disk growth is bounded
        // by the same cap; scheduled runs are infrequent, so the
        // rewrite cost is paid only on appends past the cap.
        //
        // The replacement is failure-atomic (#2120): stage the retained
        // rows in a sibling temp file and rename it over the history
        // file, and only drop the aged-out rows from memory and the
        // dedupe set after the rename succeeds. An in-place rewrite
        // that failed mid-write (ENOSPC after truncate) erased the
        // whole durable history while the caller was allowed to
        // continue; here a failed compaction leaves the previous valid
        // file — which now also holds the just-appended row — and the
        // in-memory mirror exactly as they were, and the next append
        // past the cap retries the compaction.
        const retained = rows.slice(rows.length - rowCap);
        const tempPath = `${filePath}.tmp-${process.pid}`;
        try {
          fs.writeFileSync(tempPath, retained.map((kept) => `${JSON.stringify(kept)}\n`).join(''));
          fs.renameSync(tempPath, filePath);
        } catch (compactionError) {
          try { fs.rmSync(tempPath, { force: true }); } catch { /* best effort */ }
          throw compactionError;
        }
        const dropped = rows.splice(0, rows.length - rowCap);
        for (const oldRow of dropped) {
          appendedTerminalKeys.delete(`${runKey(oldRow.projectId, oldRow.taskId, oldRow.sessionId)}\0${oldRow.finishedAt}\0${oldRow.outcome}`);
        }
      }
    } catch (error) {
      // History is evidence, never a reason to break the run itself.
      logger.warn?.('[scheduled-tasks] run history record failed:', error?.message ?? error);
    }
  };

  const listRuns = ({ projectID, taskID, since, until, limit } = {}) => {
    const effectiveLimit = Number.isFinite(limit)
      ? Math.min(Math.max(Math.trunc(limit), 1), MAX_LIMIT)
      : DEFAULT_LIMIT;
    const matches = [];
    for (let i = rows.length - 1; i >= 0 && matches.length < effectiveLimit; i -= 1) {
      const row = rows[i];
      if (projectID && row.projectId !== projectID) continue;
      if (taskID && row.taskId !== taskID) continue;
      if (Number.isFinite(since) && row.finishedAt < since) continue;
      if (Number.isFinite(until) && row.finishedAt > until) continue;
      matches.push(row);
    }
    return matches;
  };

  return { recordEvent, listRuns, filePath };
};
