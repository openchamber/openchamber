/// <reference lib="webworker" />

import { countDelimitedColumnCells, parseDelimitedText } from './delimitedText';
import type { DelimitedWorkerRequest, DelimitedWorkerResponse } from './delimited-worker-protocol';

/**
 * The parse the worker holds the text of.
 *
 * The count of the widths walks the text of the rows the parse kept, so the
 * worker holds the text of the parse it answered and the count does not have
 * to carry the text of the file again. Only the newest parse is held: the
 * preview has one file open at a time, and the text of a file the user has
 * left is of no use to the file that is open now.
 */
type HeldParse = {
  /** The id of the parse, which a count request names. */
  id: number;
  content: string;
  delimiter: ',' | '\t';
  rowCap: number;
};

let held: HeldParse | null = null;

const post = (response: DelimitedWorkerResponse): void => {
  self.postMessage(response);
};

self.onmessage = (event: MessageEvent<DelimitedWorkerRequest>) => {
  const request = event.data;
  if (request.type === 'parse') {
    try {
      const table = parseDelimitedText(request.content, request.delimiter, request.rowCap);
      held = {
        id: request.id,
        content: request.content,
        delimiter: request.delimiter,
        rowCap: request.rowCap,
      };
      post({ type: 'parsed', id: request.id, table });
    } catch (error) {
      post({
        type: 'error',
        id: request.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }
  if (request.type === 'release') {
    if (held?.id === request.parseId) held = null;
    return;
  }
  const parse = held;
  if (parse === null || parse.id !== request.parseId) {
    // The worker does not hold the parse any more, so the text the count
    // walks over is gone and the count cannot be made.
    post({ type: 'error', id: request.id, message: 'The worker does not hold this parse.' });
    return;
  }
  try {
    const cells = countDelimitedColumnCells(
      parse.content,
      parse.delimiter,
      parse.rowCap,
      request.characterWidths,
    );
    post({ type: 'counted', id: request.id, cells });
  } catch (error) {
    post({
      type: 'error',
      id: request.id,
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
