// The durable scheduled-task run history (#2174 Gap 1), opened once the routes
// know the data directory. Runs recorded before that are dropped.
import path from 'node:path';
import { createScheduledTaskRunHistory } from './run-history.js';

type RunHistory = ReturnType<typeof createScheduledTaskRunHistory>;

export const createScheduledTaskRunHistorySlot = () => {
  let history: RunHistory | null = null;
  return {
    open: (openchamberDataDir: string): RunHistory => {
      history ??= createScheduledTaskRunHistory({
        filePath: path.join(openchamberDataDir, 'scheduled-task-run-history.jsonl'),
        logger: console,
      });
      return history;
    },
    record: (event: Parameters<RunHistory['recordEvent']>[0]) => { history?.recordEvent(event); },
  };
};
