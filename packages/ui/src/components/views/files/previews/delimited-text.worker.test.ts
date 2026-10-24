import { afterAll, describe, expect, test } from 'bun:test';

import type { DelimitedWorkerRequest, DelimitedWorkerResponse } from './delimited-worker-protocol';

/** The request the worker reads. */
type WorkerMessage = (event: { data: DelimitedWorkerRequest }) => void;

/**
 * The global the worker runs in.
 *
 * The worker is a script of its own, and the test gives it one: the
 * requests are handed to it and the answers are read from it.
 */
type WorkerGlobal = {
  onmessage: WorkerMessage | null;
  postMessage: (response: DelimitedWorkerResponse) => void;
};

const answers: DelimitedWorkerResponse[] = [];
const workerGlobal: WorkerGlobal = {
  onmessage: null,
  postMessage: (response) => {
    answers.push(response);
  },
};

const originalSelf = globalThis.self;
Object.assign(globalThis, { self: workerGlobal });
await import('./delimited-text.worker');

afterAll(() => {
  Object.assign(globalThis, { self: originalSelf });
});

/** Hand a request to the worker and read the answer it gives. */
const ask = (request: DelimitedWorkerRequest): DelimitedWorkerResponse | undefined => {
  answers.length = 0;
  workerGlobal.onmessage?.({ data: request });
  return answers[0];
};

describe('the worker that parses a delimited file', () => {
  test('parses a file and answers with its table', () => {
    const answer = ask({
      type: 'parse',
      id: 7,
      content: 'a,b\n1,2',
      delimiter: ',',
      rowCap: 100,
    });

    if (!answer || answer.type !== 'parsed') throw new Error('The worker did not answer with a table');
    expect(answer.id).toBe(7);
    expect(answer.table.header).toEqual(['a', 'b']);
    expect(answer.table.columnCount).toBe(2);
    expect(answer.table.totalRows).toBe(1);
  });

  test('counts the widths of the columns of the parse it holds', () => {
    ask({ type: 'parse', id: 7, content: 'Ω,a\nΩ,b', delimiter: ',', rowCap: 100 });

    // The character is counted at the width the browser measured for it, so
    // the column is wider than the counted rule gives it.
    const answer = ask({
      type: 'count',
      id: 8,
      parseId: 7,
      characterWidths: new Map([[0x3a9, 2]]),
    });

    if (!answer || answer.type !== 'counted') throw new Error('The worker did not answer with the widths');
    expect(answer.id).toBe(8);
    expect(answer.cells[0]).toBe(2);
  });

  test('fails a count for a parse it does not hold', () => {
    ask({ type: 'parse', id: 7, content: 'a,b\n1,2', delimiter: ',', rowCap: 100 });

    // The text of a parse the worker does not hold is gone, so the count
    // cannot be made.
    const answer = ask({
      type: 'count',
      id: 8,
      parseId: 99,
      characterWidths: new Map(),
    });

    if (!answer || answer.type !== 'error') throw new Error('The worker did not fail the count');
    expect(answer.id).toBe(8);
  });

  test('releases only the parse whose text is still held', () => {
    ask({ type: 'parse', id: 7, content: 'a,b\n1,2', delimiter: ',', rowCap: 100 });
    ask({ type: 'parse', id: 8, content: 'c,d\n3,4', delimiter: ',', rowCap: 100 });
    ask({ type: 'release', parseId: 7 });

    const current = ask({
      type: 'count',
      id: 9,
      parseId: 8,
      characterWidths: new Map(),
    });
    if (!current || current.type !== 'counted') throw new Error('A stale release cleared the current parse');

    ask({ type: 'release', parseId: 8 });
    const released = ask({
      type: 'count',
      id: 10,
      parseId: 8,
      characterWidths: new Map(),
    });
    if (!released || released.type !== 'error') throw new Error('The released parse is still held');
  });
});
