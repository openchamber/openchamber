import WorkerUrl from '@pierre/diffs/worker/worker.js?worker&url';

/** @public Loaded by DiffWorkerProvider through a dynamic import. */
export function workerFactory(): Worker {
  return new Worker(WorkerUrl, { type: 'module' });
}
