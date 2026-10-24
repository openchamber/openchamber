/**
 * The messages between the preview and the worker that parses a delimited
 * file.
 *
 * The worker answers two requests. A parse walks the text of the file once
 * and hands over the table the preview shows. A count walks the text of the
 * rows the parse kept and answers with the widths of the columns, counted
 * with the characters the browser measured.
 *
 * Every answer carries the id of the request it belongs to, so an answer for
 * a file the user has left is dropped by the client.
 */

import type { DelimitedTable } from './delimitedText';
import type { TableCharacterWidths } from './tableLayout';

export type DelimitedWorkerRequest =
  /**
   * Parse the text of a file.
   *
   * The worker keeps the text of the parse it answers, so the count that
   * follows does not have to carry the text of the file again.
   */
  | { type: 'parse'; id: number; content: string; delimiter: ',' | '\t'; rowCap: number }
  /** Release the text held for a parse, if it is still the worker's current parse. */
  | { type: 'release'; parseId: number }
  /**
   * Count the widths of the columns of a parse again, with the characters the
   * browser measured.
   *
   * `parseId` names the parse the count belongs to. A count for a parse the
   * worker does not hold any more is answered as a failure, because the text
   * the count walks over is gone.
   */
  | { type: 'count'; id: number; parseId: number; characterWidths: TableCharacterWidths };

export type DelimitedWorkerResponse =
  | { type: 'parsed'; id: number; table: DelimitedTable }
  | { type: 'counted'; id: number; cells: number[] }
  | { type: 'error'; id: number; message: string };
