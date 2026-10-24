import React from 'react';

import {
  countDelimitedColumnCellsInWorker,
  parseDelimitedTextInWorker,
  releaseDelimitedParseInWorker,
} from './delimited-worker';
import {
  DEFAULT_TABLE_ROW_CAP,
  countDelimitedColumnCells,
  parseDelimitedText,
  type DelimitedTable,
} from './delimitedText';
import {
  hasWiderCharacter,
  sameCharacterWidths,
  type TableCharacterWidths,
} from './tableLayout';

/**
 * The table of a delimited file, and the widths of its columns.
 *
 * A file that is small enough is parsed here, on the thread the preview is
 * on, in the first render, so it opens without a loading state. A file that
 * is larger is parsed in a worker, and the preview shows its loading state
 * until the worker answers. A runtime without a worker, a worker that cannot
 * be created, one that crashes, one that does not take the request and one
 * that does not answer in time all end the same way: the file is parsed on
 * the main thread, which is slower for the user and the last resort.
 *
 * The widths of the columns are counted with the counted rule while the file
 * is parsed, because the parse runs before the browser has measured a
 * character. A character the browser lays out wider than the count gives it
 * makes those widths too narrow, so they are counted again with the measured
 * table, which the preview asks for when the browser has measured its
 * characters.
 */

/** The time a request has, before the size of the file is counted in. */
const REQUEST_BUDGET_MS = 5_000;

/**
 * The text a request is given one more second for.
 *
 * The parse walks the text of the file once, so a big file takes longer than
 * a small one. A hundred and forty megabytes of text took about a second to
 * parse on the machine the figures of the preview were measured on, so a
 * second for every twenty million characters leaves a slower machine the room
 * it needs. The length of the text is counted in characters, because that is
 * what the walk over it counts.
 */
const REQUEST_BUDGET_CHARACTERS = 20 * 1024 * 1024;

/** The budget a request for a file of the given size has. */
const requestBudgetMs = (contentLength: number): number => (
  REQUEST_BUDGET_MS + Math.ceil(contentLength / REQUEST_BUDGET_CHARACTERS) * 1_000
);

/** The widths of a file that has not been parsed yet. */
const NO_CELLS: number[] = [];

/**
 * The number of characters a file may hold to be parsed on the thread the
 * preview is on.
 *
 * The parse of a file of n characters costs about 15 ms per megabyte in
 * Chromium, so a file of this size is parsed in a few milliseconds. A round
 * trip through a worker costs more than that: the worker is made, the text is
 * copied into it and it answers. A file of this size is therefore parsed in
 * the first render, and the preview opens without a loading state and
 * without a worker. A file that is larger is parsed in the worker, and the
 * preview shows its loading state until the worker answers.
 */
export const SMALL_FILE_CHAR_LIMIT = 200_000;

/**
 * The state of the file that is open now.
 *
 * The file is named with the content and the delimiter it was parsed with,
 * so the table of the file the user has left is not shown while the next one
 * is parsed, and the widths that are counted again are published for the
 * file they were counted for.
 */
type DelimitedState = {
  /** The content of the file. */
  content: string;
  /** The delimiter the file was parsed with. */
  delimiter: ',' | '\t';
  /** The table of the file, or null while the worker parses it. */
  table: DelimitedTable | null;
  /** The id the worker gave the parse, or null when the file was parsed here. */
  id: number | null;
  /** The width of the widest kept value of every column, in character cells. */
  bodyCells: number[];
};

/** A file that could not be parsed, and the file it failed for. */
type FailedFile = {
  content: string;
  delimiter: ',' | '\t';
  error: Error;
};

/**
 * The characters the widths of a file were counted with, and the table they
 * were counted for.
 *
 * A count belongs to one table. A file that is opened again is parsed again,
 * and the table of the new parse starts from the widths the parser counted,
 * so the widths that were counted for the file before it are not the widths
 * of the new table.
 */
type CountedWidths = {
  table: DelimitedTable;
  widths: TableCharacterWidths;
};

/** What the preview knows about the file it shows. */
type DelimitedTableState = {
  /** The table of the file, or null while the file is parsed. */
  table: DelimitedTable | null;
  /**
   * The width of the widest kept value of every column, in character cells.
   */
  bodyCells: number[];
  /**
   * Count the widths of the columns again with the characters the browser
   * measured.
   */
  countBodyCells: (characterWidths: TableCharacterWidths) => void;
};

/**
 * The state of a file that is parsed here, on the thread of the preview.
 *
 * A file that is small enough is parsed in the render, so the preview opens
 * in the first frame and no worker is made for it. The parse of the file
 * counts the widths of its columns with the counted rule, the way the parse
 * in the worker does.
 */
const parseHere = (content: string, delimiter: ',' | '\t'): DelimitedState => {
  const table = parseDelimitedText(content, delimiter, DEFAULT_TABLE_ROW_CAP);
  return { content, delimiter, table, id: null, bodyCells: table.columnCells };
};

export const useDelimitedTable = (
  content: string,
  delimiter: ',' | '\t',
): DelimitedTableState => {
  const [state, setState] = React.useState<DelimitedState | null>(null);
  const [failure, setFailure] = React.useState<FailedFile | null>(null);
  /**
   * The number of the file that is open now. A file that is left behind
   * raises it, so a late answer of the worker does not publish the table of
   * a file the user has left.
   */
  const generationRef = React.useRef(0);
  /** The number of the count that is running, so only the last one publishes. */
  const countRef = React.useRef(0);
  /**
   * The characters the widths were last counted with, and the file they were
   * counted for. The count is asked for once for a set of characters: the
   * panel is resized and rendered again all the time, and the widths of the
   * file do not change with them.
   */
  const countedRef = React.useRef<CountedWidths | null>(null);
  /**
   * The table of the file that is open now.
   *
   * A count that finishes late has to tell whether the file it was started
   * for is still the one that is open, so that the widths of a file the user
   * has left are not counted here: that walk is over the text of every row
   * the preview holds, and it would hold the thread of the preview for as
   * long as it takes.
   */
  const openTableRef = React.useRef<DelimitedTable | null>(null);
  React.useLayoutEffect(() => {
    openTableRef.current = state?.table ?? null;
    return () => {
      // A preview that is gone does not count the widths of a file any more.
      openTableRef.current = null;
    };
  }, [state]);

  // The file that is open now is not the file the state holds, so the state
  // is made for it here, in the render. A file that is small enough is
  // parsed right away, and the preview opens in the first frame. A file that
  // is larger is parsed in the worker, and the effect below publishes its
  // table when the worker answers.
  if (state === null || state.content !== content || state.delimiter !== delimiter) {
    setState(content.length <= SMALL_FILE_CHAR_LIMIT
      ? parseHere(content, delimiter)
      : { content, delimiter, table: null, id: null, bodyCells: [] });
  }

  /**
   * The table of a file, published for the file it belongs to.
   */
  const publishTable = React.useCallback((
    content: string,
    delimiter: ',' | '\t',
    id: number | null,
    table: DelimitedTable,
  ): void => {
    setState((current) => (
      current !== null
      && current.content === content
      && current.delimiter === delimiter
        ? { ...current, table, id, bodyCells: table.columnCells }
        : current
    ));
  }, []);

  /**
   * The widths of the columns of a file, published for the file they belong
   * to.
   *
   * A count that arrives for a file the user has left does not change the
   * file that is open now. Widths that did not change publish nothing, so
   * the preview is not rendered again for them.
   */
  const publishWidths = React.useCallback((file: DelimitedState, cells: number[]): void => {
    setState((current) => (
      current !== null
      && current.content === file.content
      && current.delimiter === file.delimiter
      && current.bodyCells !== cells
        ? { ...current, bodyCells: cells }
        : current
    ));
  }, []);

  React.useEffect(() => {
    generationRef.current += 1;
    const generation = generationRef.current;
    setFailure(null);
    if (content.length <= SMALL_FILE_CHAR_LIMIT) {
      // The file was parsed in the render, so there is nothing to ask the
      // worker for.
      return;
    }
    let cancelled = false;
    let parseId: number | null = null;
    void (async () => {
      const result = await parseDelimitedTextInWorker(
        content,
        delimiter,
        DEFAULT_TABLE_ROW_CAP,
        requestBudgetMs(content.length),
      );
      if (result !== null) parseId = result.id;
      if (cancelled) {
        if (parseId !== null) releaseDelimitedParseInWorker(parseId);
        return;
      }
      if (generationRef.current !== generation) return;
      if (result !== null) {
        publishTable(content, delimiter, result.id, result.table);
        return;
      }
      // The worker cannot be used, so the file is parsed here.
      let fallback: DelimitedTable;
      try {
        fallback = parseDelimitedText(content, delimiter, DEFAULT_TABLE_ROW_CAP);
      } catch (error) {
        if (generationRef.current === generation) {
          setFailure({
            content,
            delimiter,
            error: error instanceof Error ? error : new Error(String(error)),
          });
        }
        return;
      }
      if (generationRef.current !== generation) return;
      publishTable(content, delimiter, null, fallback);
    })();

    return () => {
      cancelled = true;
      if (parseId !== null) releaseDelimitedParseInWorker(parseId);
      // A file that is left behind must not publish its table.
      generationRef.current += 1;
    };
  }, [content, delimiter, publishTable]);

  const countBodyCells = React.useCallback((characterWidths: TableCharacterWidths) => {
    const file = state;
    if (file === null || file.table === null) return;
    const counted = countedRef.current;
    if (counted !== null
      && counted.table === file.table
      && sameCharacterWidths(counted.widths, characterWidths)) {
      return;
    }
    // The measurements changed, so every count that is running was asked for
    // with other characters and must not publish its widths.
    const count = ++countRef.current;
    countedRef.current = { table: file.table, widths: characterWidths };
    // Every character of the file is counted right, so the widths the parse
    // counted are the exact ones and nothing is counted again.
    if (!hasWiderCharacter(characterWidths)) {
      publishWidths(file, file.table.columnCells);
      return;
    }
    const parseId = file.id;
    if (parseId === null) {
      // The file was parsed on this thread, so its widths are counted here.
      publishWidths(file, countDelimitedColumnCells(
        file.content,
        file.delimiter,
        DEFAULT_TABLE_ROW_CAP,
        characterWidths,
      ));
      return;
    }
    void (async () => {
      const cells = await countDelimitedColumnCellsInWorker(
        parseId,
        characterWidths,
        requestBudgetMs(file.content.length),
      );
      // A count that a newer one replaced does not publish its widths.
      if (countRef.current !== count) return;
      // The file is not the one that is open any more, so its widths are
      // neither published nor counted here: that walk is over the text of
      // every row the preview holds, and it would hold the thread of the
      // preview for as long as it takes.
      if (openTableRef.current !== file.table) return;
      // The worker could not answer, so the widths are counted here.
      const countedCells = cells ?? countDelimitedColumnCells(
        file.content,
        file.delimiter,
        DEFAULT_TABLE_ROW_CAP,
        characterWidths,
      );
      publishWidths(file, countedCells);
    })();
  }, [state, publishWidths]);

  // A file that cannot be parsed at all is a fault of the file, and the
  // preview fails the way it failed when it parsed the file itself.
  if (failure !== null && failure.content === content && failure.delimiter === delimiter) {
    throw failure.error;
  }

  const current = state !== null
    && state.content === content
    && state.delimiter === delimiter
    ? state
    : null;

  return {
    table: current?.table ?? null,
    bodyCells: current?.bodyCells ?? NO_CELLS,
    countBodyCells,
  };
};
