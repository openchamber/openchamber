import WorkerUrl from '@pierre/diffs/worker/worker.js?worker&url';

export function workerFactory(): Worker {
  return new Worker(WorkerUrl, { type: 'module' });
}
