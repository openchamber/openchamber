import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createScheduledTaskRunHistory } from './run-history.js';

// Oracle (#2174 Gap 1): every completed scheduled-task run yields
// exactly one durable history row carrying its terminal outcome —
// never zero (a lost run), never two (a duplicate terminal event).

const tempDirs = [];
const makeHistory = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-history-'));
  tempDirs.push(dir);
  const filePath = path.join(dir, 'scheduled-task-run-history.jsonl');
  const logger = { warn: vi.fn() };
  return { history: createScheduledTaskRunHistory({ filePath, logger }), filePath, logger };
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('createScheduledTaskRunHistory', () => {
  it('records exactly one row for a running→success run, with start and finish', () => {
    const { history } = makeHistory();
    history.recordEvent({ projectID: 'code', taskID: 'task-1', taskName: 'Lane A', status: 'running', ranAt: 1_000, sessionID: 'ses_1' });
    expect(history.listRuns({ projectID: 'code' })).toEqual([]);
    history.recordEvent({ projectID: 'code', taskID: 'task-1', status: 'success', ranAt: 4_500, sessionID: 'ses_1' });
    // A duplicate delivery of the same terminal event changes nothing.
    history.recordEvent({ projectID: 'code', taskID: 'task-1', status: 'success', ranAt: 4_500, sessionID: 'ses_1' });

    expect(history.listRuns({ projectID: 'code' })).toEqual([
      {
        projectId: 'code',
        taskId: 'task-1',
        taskName: 'Lane A',
        startedAt: 1_000,
        finishedAt: 4_500,
        outcome: 'success',
        sessionId: 'ses_1',
        tokens: null,
      },
    ]);
  });

  it('records a terminal event with no observed start (server restarted mid-run)', () => {
    const { history } = makeHistory();
    history.recordEvent({ projectID: 'code', taskID: 'task-2', status: 'error', ranAt: 9_000, sessionID: 'ses_2' });
    const runs = history.listRuns({ projectID: 'code' });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ taskId: 'task-2', outcome: 'error', startedAt: null, finishedAt: 9_000 });
  });

  it('ignores non-terminal statuses other than running', () => {
    const { history } = makeHistory();
    history.recordEvent({ projectID: 'code', taskID: 'task-3', status: 'queued', ranAt: 100, sessionID: 'ses_3' });
    expect(history.listRuns({ projectID: 'code' })).toEqual([]);
  });

  it('round-trips rows through the JSONL file, dedupe included', () => {
    const { filePath } = makeHistory();
    const first = createScheduledTaskRunHistory({ filePath, logger: { warn: vi.fn() } });
    first.recordEvent({ projectID: 'code', taskID: 'task-1', status: 'running', ranAt: 10, sessionID: 'ses_1' });
    first.recordEvent({ projectID: 'code', taskID: 'task-1', status: 'success', ranAt: 20, sessionID: 'ses_1' });

    const second = createScheduledTaskRunHistory({ filePath, logger: { warn: vi.fn() } });
    expect(second.listRuns({ projectID: 'code' })).toHaveLength(1);
    second.recordEvent({ projectID: 'code', taskID: 'task-1', status: 'success', ranAt: 20, sessionID: 'ses_1' });
    expect(second.listRuns({ projectID: 'code' })).toHaveLength(1);
    expect(fs.readFileSync(filePath, 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it('skips malformed lines at load instead of losing the file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-history-'));
    tempDirs.push(dir);
    const filePath = path.join(dir, 'scheduled-task-run-history.jsonl');
    const good = JSON.stringify({
      projectId: 'code', taskId: 'task-1', taskName: null, startedAt: 1,
      finishedAt: 2, outcome: 'success', sessionId: null, tokens: null,
    });
    fs.writeFileSync(filePath, `not json\n${good}\n{"projectId":7}\n`);
    const history = createScheduledTaskRunHistory({ filePath, logger: { warn: vi.fn() } });
    expect(history.listRuns({ projectID: 'code' })).toHaveLength(1);
  });

  it('filters by task and time window, newest first', () => {
    const { history } = makeHistory();
    for (const [taskID, finishedAt] of [['task-1', 100], ['task-2', 200], ['task-1', 300]]) {
      history.recordEvent({ projectID: 'code', taskID, status: 'success', ranAt: finishedAt, sessionID: `ses_${finishedAt}` });
    }
    expect(history.listRuns({ projectID: 'code' }).map((r) => r.finishedAt)).toEqual([300, 200, 100]);
    expect(history.listRuns({ projectID: 'code', taskID: 'task-1' }).map((r) => r.finishedAt)).toEqual([300, 100]);
    expect(history.listRuns({ projectID: 'code', since: 150, until: 250 }).map((r) => r.finishedAt)).toEqual([200]);
    expect(history.listRuns({ projectID: 'code', limit: 2 })).toHaveLength(2);
    expect(history.listRuns({ projectID: 'other' })).toEqual([]);
  });

  // Oracle (#2116): retention keeps exactly the newest maxRows rows —
  // in memory, on disk, and across a reload — so neither the JSONL file
  // nor the in-memory mirror grows with total historical runs.
  it('retains only the newest maxRows rows, on disk and across reload', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-history-'));
    tempDirs.push(dir);
    const filePath = path.join(dir, 'scheduled-task-run-history.jsonl');
    const history = createScheduledTaskRunHistory({ filePath, logger: { warn: vi.fn() }, maxRows: 3 });
    for (let i = 1; i <= 5; i += 1) {
      history.recordEvent({ projectID: 'code', taskID: 'task-1', status: 'success', ranAt: i * 1000, sessionID: `ses_${i}` });
    }
    expect(history.listRuns({ projectID: 'code' }).map((r) => r.finishedAt)).toEqual([5000, 4000, 3000]);
    expect(fs.readFileSync(filePath, 'utf8').trim().split('\n')).toHaveLength(3);

    const reloaded = createScheduledTaskRunHistory({ filePath, logger: { warn: vi.fn() }, maxRows: 3 });
    expect(reloaded.listRuns({ projectID: 'code' }).map((r) => r.finishedAt)).toEqual([5000, 4000, 3000]);
  });

  // Oracle (#2116): a file grown past the row cap before the bound
  // Oracle (#2120): a compaction write that fails after the point where
  // an in-place rewrite would have truncated the file must preserve the
  // previous valid history — the durable file keeps every appended row,
  // a reload still sees them, and in-memory rows stay consistent with
  // the file (nothing is dropped until a replacement actually lands).
  it('keeps the previous history when the compaction replacement fails', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-history-'));
    tempDirs.push(dir);
    const filePath = path.join(dir, 'scheduled-task-run-history.jsonl');
    const logger = { warn: vi.fn() };
    const history = createScheduledTaskRunHistory({ filePath, logger, maxRows: 1 });
    history.recordEvent({ projectID: 'code', taskID: 'task-1', status: 'success', ranAt: 1_000, sessionID: 'ses_1' });

    // Inject the failure at the compaction write: a direct write to the
    // history file itself (the old in-place shape) truncates it first,
    // exactly the damage a mid-write ENOSPC did; a staged temp write
    // fails without ever touching the history file. Appends pass
    // through (appendFileSync routes through writeFileSync with
    // flag 'a' and must keep working — only the rewrite is failing).
    const originalWriteFileSync = fs.writeFileSync;
    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation((target, data, options, ...rest) => {
      if (options?.flag === 'a') return originalWriteFileSync(target, data, options, ...rest);
      if (String(target) === filePath) fs.truncateSync(filePath, 0);
      if (String(target).startsWith(dir)) {
        throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
      }
      return originalWriteFileSync(target, data, options, ...rest);
    });
    try {
      history.recordEvent({ projectID: 'code', taskID: 'task-2', status: 'success', ranAt: 2_000, sessionID: 'ses_2' });
    } finally {
      writeSpy.mockRestore();
    }

    // Non-fatal, as before: the failure was logged, not thrown.
    expect(logger.warn).toHaveBeenCalled();
    // The durable file still holds both appended rows, and no staged
    // temp file is left behind.
    const onDisk = fs.readFileSync(filePath, 'utf8').trim().split('\n');
    expect(onDisk).toHaveLength(2);
    expect(fs.readdirSync(dir)).toEqual(['scheduled-task-run-history.jsonl']);
    // In-memory rows remain consistent with the durable file.
    expect(history.listRuns({ projectID: 'code' }).map((row) => row.taskId)).toEqual(['task-2', 'task-1']);
    // A reload sees the history (load trims to the newest maxRows rows).
    const reloaded = createScheduledTaskRunHistory({ filePath, logger: { warn: vi.fn() }, maxRows: 1 });
    expect(reloaded.listRuns({ projectID: 'code' }).map((row) => row.taskId)).toEqual(['task-2']);
  });

  // existed loads trimmed to the newest maxRows rows.
  it('trims an oversized existing file to the newest maxRows rows at load', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-history-'));
    tempDirs.push(dir);
    const filePath = path.join(dir, 'scheduled-task-run-history.jsonl');
    const lines = [];
    for (let i = 1; i <= 5; i += 1) {
      lines.push(JSON.stringify({
        projectId: 'code', taskId: 'task-1', taskName: null, startedAt: null,
        finishedAt: i * 1000, outcome: 'success', sessionId: `ses_${i}`, tokens: null,
      }));
    }
    fs.writeFileSync(filePath, `${lines.join('\n')}\n`);
    const history = createScheduledTaskRunHistory({ filePath, logger: { warn: vi.fn() }, maxRows: 2 });
    expect(history.listRuns({ projectID: 'code' }).map((r) => r.finishedAt)).toEqual([5000, 4000]);
  });

  // Oracle (#2116): startup load reads only the tail of an oversized
  // file — the partial first line of the tail window is dropped and
  // the complete newest rows survive.
  it('bounds the startup read to the newest bytes of an oversized file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-history-'));
    tempDirs.push(dir);
    const filePath = path.join(dir, 'scheduled-task-run-history.jsonl');
    const lines = [];
    for (let i = 1; i <= 5; i += 1) {
      lines.push(JSON.stringify({
        projectId: 'code', taskId: 'task-1', taskName: null, startedAt: null,
        finishedAt: i * 1000, outcome: 'success', sessionId: `ses_${i}`, tokens: null,
      }));
    }
    const content = `${lines.join('\n')}\n`;
    fs.writeFileSync(filePath, content);
    const lineBytes = Buffer.byteLength(lines[0]) + 1;
    // Tail window: the newest two full rows plus half of the third.
    const maxLoadBytes = lineBytes * 2 + Math.floor(lineBytes / 2);
    const history = createScheduledTaskRunHistory({ filePath, logger: { warn: vi.fn() }, maxLoadBytes });
    expect(history.listRuns({ projectID: 'code' }).map((r) => r.finishedAt)).toEqual([5000, 4000]);
  });

  // Oracle (#2267): a tail window that begins exactly on a line
  // boundary holds complete rows only -- the first row is kept, not
  // discarded as if the window had begun mid-line.
  it('keeps the first row when the bounded window starts exactly on a line boundary', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-history-'));
    tempDirs.push(dir);
    const filePath = path.join(dir, 'scheduled-task-run-history.jsonl');
    const lines = [];
    for (let i = 1; i <= 5; i += 1) {
      lines.push(JSON.stringify({
        projectId: 'code', taskId: 'task-1', taskName: null, startedAt: null,
        finishedAt: i * 1000, outcome: 'success', sessionId: `ses_${i}`, tokens: null,
      }));
    }
    const content = `${lines.join('\n')}\n`;
    fs.writeFileSync(filePath, content);
    const lineBytes = Buffer.byteLength(lines[0]) + 1;
    // Tail window: exactly the newest two rows, starting on a boundary.
    const maxLoadBytes = lineBytes * 2;
    const history = createScheduledTaskRunHistory({ filePath, logger: { warn: vi.fn() }, maxLoadBytes });
    expect(history.listRuns({ projectID: 'code' }).map((r) => r.finishedAt)).toEqual([5000, 4000]);
  });

  it('never throws when the file cannot be written', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-history-'));
    tempDirs.push(dir);
    const blocker = path.join(dir, 'blocker');
    fs.writeFileSync(blocker, 'a regular file, not a directory');
    const logger = { warn: vi.fn() };
    const history = createScheduledTaskRunHistory({ filePath: path.join(blocker, 'history.jsonl'), logger });
    expect(() => history.recordEvent({ projectID: 'code', taskID: 'task-1', status: 'success', ranAt: 1 })).not.toThrow();
    expect(logger.warn).toHaveBeenCalled();
  });
});
