import DelimitedTextWorkerUrl from './delimited-text.worker.ts?worker&url';

import { isVSCodeRuntime } from '@/stores/utils/vscodeRuntime';
import type { DelimitedTable } from './delimitedText';
import type { DelimitedWorkerRequest, DelimitedWorkerResponse } from './delimited-worker-protocol';
import type { TableCharacterWidths } from './tableLayout';

/**
 * The client of the worker that parses a delimited file.
 *
 * The parse of a file walks its text once, and a wide export is tens of
 * megabytes of text, so the parse runs in a worker and the main thread only
 * renders what the worker sends back. The worker is made when the first
 * request comes and lives until it fails.
 *
 * Every request has a budget. A worker that does not answer within it is
 * given up on: it is terminated and every request waiting for it fails, so
 * the preview falls back to parsing on the main thread instead of waiting
 * forever. A worker that answers slowly is not a fault of the file, so the
 * budget is set by the caller, which knows how big the file is. A request
 * the worker does not take is given up on the same way.
 */

/** How a request ended. */
type RequestOutcome =
  | { status: 'ok'; response: DelimitedWorkerResponse }
  | { status: 'failed' };

type PendingEntry = {
  resolve: (outcome: RequestOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
};

/**
 * A parse of a file, and the id the worker gave it.
 *
 * The id names the parse in a count request, so the worker can be asked to
 * count the widths of the columns of this parse again without being sent the
 * text of the file a second time.
 */
type DelimitedParse = {
  /** The id of the parse in the worker. */
  id: number;
  /** The table of the file. */
  table: DelimitedTable;
};

let worker: Worker | undefined;
let workerCreation: Promise<Worker | undefined> | undefined;
let workerObjectUrl: string | undefined;
let workerGeneration = 0;
let nextId = 0;
const pending = new Map<number, PendingEntry>();

const disposeWorker = (): void => {
  workerGeneration += 1;
  worker?.terminate();
  worker = undefined;
  workerCreation = undefined;
  if (workerObjectUrl !== undefined) {
    URL.revokeObjectURL(workerObjectUrl);
    workerObjectUrl = undefined;
  }
};

/**
 * The worker cannot answer any more: it crashed, or a request ran out of its
 * budget. Every request waiting for it fails, so the preview falls back
 * instead of waiting for an answer that will not come.
 */
const failAll = (): void => {
  for (const entry of pending.values()) {
    clearTimeout(entry.timer);
    entry.resolve({ status: 'failed' });
  }
  pending.clear();
  disposeWorker();
};

const createWorker = async (generation: number): Promise<Worker | undefined> => {
  // A runtime without a worker cannot make one.
  if (!('Worker' in globalThis)) return undefined;
  let objectUrl: string | undefined;
  try {
    let workerUrl = DelimitedTextWorkerUrl;
    if (isVSCodeRuntime(null)) {
      // The VS Code webview cannot load a worker from its URL, so the worker
      // is fetched and started from a blob URL.
      const response = await fetch(workerUrl);
      if (!response.ok) throw new Error(`Delimited worker request failed with ${response.status}`);
      objectUrl = URL.createObjectURL(await response.blob());
      if (generation !== workerGeneration) {
        URL.revokeObjectURL(objectUrl);
        return undefined;
      }
      workerObjectUrl = objectUrl;
      workerUrl = objectUrl;
    }
    if (generation !== workerGeneration) return undefined;
    const instance = new Worker(workerUrl, { type: 'module' });
    worker = instance;
    instance.onmessage = (event: MessageEvent<DelimitedWorkerResponse>) => {
      const entry = pending.get(event.data.id);
      if (!entry) return;
      clearTimeout(entry.timer);
      pending.delete(event.data.id);
      entry.resolve({ status: 'ok', response: event.data });
    };
    instance.onerror = failAll;
    instance.onmessageerror = failAll;
    return instance;
  } catch (error) {
    if (objectUrl !== undefined) {
      URL.revokeObjectURL(objectUrl);
      if (workerObjectUrl === objectUrl) workerObjectUrl = undefined;
    }
    console.error('Failed to create the delimited worker:', error);
    return undefined;
  }
};

const getWorker = async (): Promise<Worker | undefined> => {
  if (worker) return worker;
  if (!workerCreation) {
    const generation = workerGeneration;
    const wrappedCreation = createWorker(generation).finally(() => {
      if (workerCreation === wrappedCreation) workerCreation = undefined;
    });
    workerCreation = wrappedCreation;
  }
  return workerCreation;
};

/**
 * Post one request. Its budget starts when the caller asks, including worker
 * startup and reading the worker response body in runtimes that fetch it.
 *
 * A request that cannot be posted fails like every other failure: the
 * worker is given up on, the way it is given up on when it crashes and when
 * it does not answer in time, and the preview falls back to parsing on the
 * main thread instead of waiting for an answer that will not come.
 */
const dispatch = async (
  id: number,
  resolve: (outcome: RequestOutcome) => void,
  payload: DelimitedWorkerRequest,
): Promise<void> => {
  const instance = await getWorker();
  const entry = pending.get(id);
  if (!entry) return;
  if (!instance) {
    clearTimeout(entry.timer);
    pending.delete(id);
    resolve({ status: 'failed' });
    return;
  }
  try {
    instance.postMessage(payload);
  } catch (error) {
    console.error('The delimited worker did not take the request:', error);
    failAll();
  }
};

const request = async (
  build: (id: number) => DelimitedWorkerRequest,
  budgetMs: number,
): Promise<RequestOutcome> => {
  const id = ++nextId;
  const message = build(id);
  return new Promise<RequestOutcome>((resolve) => {
    const timer = setTimeout(() => {
      console.warn(`The delimited worker did not answer within ${budgetMs}ms; terminating it`);
      failAll();
    }, budgetMs);
    pending.set(id, { resolve, timer });
    // A request that cannot be made at all fails like every other failure,
    // so the promise the caller waits for always settles.
    void dispatch(id, resolve, message).catch(() => {
      resolve({ status: 'failed' });
    });
  });
};

/** Drop text retained for this parse, without affecting a newer parse. */
export const releaseDelimitedParseInWorker = (parseId: number): void => {
  if (!worker) return;
  try {
    worker.postMessage({ type: 'release', parseId });
  } catch (error) {
    console.error('The delimited worker did not take the release:', error);
  }
};

/**
 * Parse the text of a file in the worker.
 *
 * Resolves with the table of the file, or with `null` when the worker cannot
 * be created, has crashed, or did not answer within the budget.
 */
export const parseDelimitedTextInWorker = async (
  content: string,
  delimiter: ',' | '\t',
  rowCap: number,
  budgetMs: number,
): Promise<DelimitedParse | null> => {
  const outcome = await request(
    (id) => ({ type: 'parse', id, content, delimiter, rowCap }),
    budgetMs,
  );
  if (outcome.status !== 'ok' || outcome.response.type !== 'parsed') return null;
  return { id: outcome.response.id, table: outcome.response.table };
};

/**
 * Count the widths of the columns of a parse again, with the characters the
 * browser measured.
 *
 * Resolves with the widths of the columns, or with `null` when the worker
 * cannot answer: it does not hold the parse any more, it crashed, or it did
 * not answer within the budget.
 */
export const countDelimitedColumnCellsInWorker = async (
  parseId: number,
  characterWidths: TableCharacterWidths,
  budgetMs: number,
): Promise<number[] | null> => {
  const outcome = await request(
    (id) => ({ type: 'count', id, parseId, characterWidths }),
    budgetMs,
  );
  if (outcome.status !== 'ok' || outcome.response.type !== 'counted') return null;
  return outcome.response.cells;
};

/** Test-only: give up the worker and every request that is waiting for it. */
export const resetDelimitedWorkerClientForTests = (): void => {
  failAll();
};
