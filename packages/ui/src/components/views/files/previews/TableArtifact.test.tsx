import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act, useLayoutEffect, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { I18nProvider } from '@/lib/i18n';

import type { DelimitedWorkerRequest, DelimitedWorkerResponse } from './delimited-worker-protocol';
import type { DelimitedTable } from './delimitedText';

// Bun cannot load Vite's `?worker&url` import that the client of the worker
// makes. The preview itself never starts a worker in this test, because the
// runtime has none, so the URL is never read.
mock.module('./delimited-text.worker.ts?worker&url', () => ({
  default: 'blob:test-delimited-worker',
}));

const { resetDelimitedWorkerClientForTests } = await import('./delimited-worker');

// The number of times the preview counts the widths of the columns again
// with the characters the browser measured. That count walks over the text
// of the file, so it is the part of the preview that grows with the file,
// and it is counted here.
const delimitedText = await import('./delimitedText');
const countDelimitedColumnCells = delimitedText.countDelimitedColumnCells;
const cutDelimitedRow = delimitedText.cutDelimitedRow;
// The parse of a file, as the preview makes it on the thread it is on. The
// worker of the preview parses the file with the parser of the repository,
// and that parse is not counted here: it happens in the worker.
const parseDelimitedText = delimitedText.parseDelimitedText;
let widthCounts = 0;
let rowCuts = 0;
let parseCalls = 0;
mock.module('./delimitedText', () => ({
  ...delimitedText,
  parseDelimitedText: (...args: Parameters<typeof parseDelimitedText>) => {
    parseCalls += 1;
    return parseDelimitedText(...args);
  },
  countDelimitedColumnCells: (...args: Parameters<typeof countDelimitedColumnCells>) => {
    widthCounts += 1;
    return countDelimitedColumnCells(...args);
  },
  cutDelimitedRow: (...args: Parameters<typeof cutDelimitedRow>) => {
    rowCuts += 1;
    return cutDelimitedRow(...args);
  },
}));

// The preview is loaded after the mock, so it is the count of the preview
// that is counted.
const { TableArtifact } = await import('./TableArtifact');
// The number of characters a file may hold to be parsed on the thread the
// preview is on. A file that is larger is parsed in a worker.
const { SMALL_FILE_CHAR_LIMIT } = await import('./useDelimitedTable');

/** What the preview reads from the computed style of its probe. */
type ComputedStyleDouble = Pick<
  CSSStyleDeclaration,
  | 'direction'
  | 'paddingLeft'
  | 'paddingRight'
  | 'borderInlineEndWidth'
  | 'borderLeftWidth'
  | 'borderRightWidth'
  | 'maxWidth'
>;

/** The size of the box the preview is rendered in. */
const VIEWPORT_WIDTH = 800;
const VIEWPORT_HEIGHT = 600;
/**
 * The height of a row with text: a line, the cell's padding and its bottom
 * border. It is the height every row is given.
 */
const ROW_HEIGHT = 30;
/**
 * The height of a row without text: it has no line in it, so only the
 * padding and the border are left.
 */
const EMPTY_ROW_HEIGHT = 9;
/** The height of the line the text of a cell sits on. */
const LINE_HEIGHT = 21;
/** The rows kept mounted above and below the viewport. */
const ROW_OVERSCAN = 6;
/** The columns kept mounted beside the viewport. */
const COLUMN_OVERSCAN = 2;
/** The width of a column of four characters, the way the preview plans with. */
const COLUMN_WIDTH = 4 * 7.5 + 17;
/**
 * The advance a browser measures in Chromium. The measured text box is
 * rounded up to the next 1/64 px, so the measured advance is a hair above
 * the one the layout uses.
 */
const MEASURED_ADVANCE = 7.50006103515625;
/** The characters the measuring probe draws. */
const PROBE_CHARACTER_COUNT = 256;
/** The width of the probe's text, the way a browser measures it. */
let probeTextWidth = PROBE_CHARACTER_COUNT * MEASURED_ADVANCE;
/**
 * The width the browser gives a character of the file, by the character.
 *
 * The preview draws every character outside latin on its own and reads the
 * width back, so the test hands it the width of the characters it wants the
 * preview to know about.
 */
const characterAdvances = new Map<string, number>();

/**
 * The observer the preview uses for the font and for the size of the panel.
 * happy-dom has none, so the test drives it by hand.
 */
class FakeResizeObserver implements ResizeObserver {
  /** Every observer the preview has made. */
  static instances: FakeResizeObserver[] = [];
  private readonly callback: ResizeObserverCallback;
  private readonly targets = new Set<Element>();
  private watching = true;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    FakeResizeObserver.instances.push(this);
  }

  observe(target: Element): void {
    this.targets.add(target);
  }

  unobserve(target: Element): void {
    this.targets.delete(target);
  }

  disconnect(): void {
    this.targets.clear();
    this.watching = false;
  }

  /** The resize the browser would report. */
  fire(): void {
    if (!this.watching) return;
    this.callback([], this);
  }
}

/**
 * The parse the worker holds the text of.
 *
 * The count of the widths walks the text of the rows the parse kept, so the
 * worker holds the text of the parse it answered and the count does not have
 * to carry the text of the file again.
 */
type HeldParse = {
  content: string;
  delimiter: ',' | '\t';
  rowCap: number;
};

/**
 * A worker that parses a file the way the worker of the preview does.
 *
 * The worker of the preview is a script of its own, and the test gives it
 * one: the request is handed to it and the answer is read from it. The file
 * is parsed with the parser of the repository, the one the preview would
 * have used on the thread it is on.
 */
class FakeWorker {
  /** Every worker the preview has made. */
  static instances: FakeWorker[] = [];
  /**
   * Whether the worker holds the answer of a count back.
   *
   * The preview asks the worker to count the widths of the columns again,
   * and the answer of that count can arrive after the measurements of the
   * preview have changed. A test that holds the answer back decides when it
   * arrives.
   */
  static holdsCounts = false;
  /** Whether parse responses wait for a test to release them. */
  static holdsParses = false;
  /** The requests the preview sent to this worker. */
  readonly requests: DelimitedWorkerRequest[] = [];
  /** The parses the worker holds, so it can count their widths again. */
  private readonly parses = new Map<number, HeldParse>();
  /** The counts the worker has not answered yet. */
  private readonly held: { id: number; cells: number[] }[] = [];
  private readonly heldParses: { id: number; table: DelimitedTable }[] = [];
  onmessage: ((event: { data: DelimitedWorkerResponse }) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;

  constructor() {
    FakeWorker.instances.push(this);
  }

  postMessage(request: DelimitedWorkerRequest): void {
    this.requests.push(request);
    if (request.type === 'parse') {
      const table = parseDelimitedText(request.content, request.delimiter, request.rowCap);
      this.parses.set(request.id, {
        content: request.content,
        delimiter: request.delimiter,
        rowCap: request.rowCap,
      });
      if (FakeWorker.holdsParses) {
        this.heldParses.push({ id: request.id, table });
      } else {
        // The worker answers in a task of its own, the way a worker does.
        setTimeout(() => {
          this.onmessage?.({ data: { type: 'parsed', id: request.id, table } });
        }, 0);
      }
      return;
    }
    if (request.type === 'release') {
      this.parses.delete(request.parseId);
      return;
    }
    const parse = this.parses.get(request.parseId);
    if (parse === undefined) {
      // The worker does not hold the parse any more, so the text the count
      // walks over is gone.
      setTimeout(() => {
        this.onmessage?.({
          data: { type: 'error', id: request.id, message: 'The worker does not hold this parse.' },
        });
      }, 0);
      return;
    }
    const cells = countDelimitedColumnCells(
      parse.content,
      parse.delimiter,
      parse.rowCap,
      request.characterWidths,
    );
    if (FakeWorker.holdsCounts) {
      this.held.push({ id: request.id, cells });
      return;
    }
    setTimeout(() => {
      this.onmessage?.({ data: { type: 'counted', id: request.id, cells } });
    }, 0);
  }

  /** Answer the counts the worker held back. */
  releaseCounts(): void {
    for (const count of this.held.splice(0, this.held.length)) {
      this.onmessage?.({ data: { type: 'counted', id: count.id, cells: count.cells } });
    }
  }

  /** Answer the parses held back by the test. */
  releaseParses(): void {
    for (const parse of this.heldParses.splice(0, this.heldParses.length)) {
      this.onmessage?.({ data: { type: 'parsed', id: parse.id, table: parse.table } });
    }
  }

  hasParse(id: number): boolean {
    return this.parses.has(id);
  }

  terminate(): void {}
}

/**
 * A worker that does not take the request it is given.
 *
 * A worker that cannot be used is given up on, so the request fails and the
 * file is parsed on the thread of the preview, the way a runtime without a
 * worker does.
 */
class RefusingWorker extends FakeWorker {
  postMessage(): void {
    throw new Error('The worker does not take the request');
  }
}

/**
 * A resize observer that reports what the browser reports.
 *
 * The browser reports the content box of the element it observes and it
 * reports a resize only when that box changed. An inline box has no content
 * box of its own, so the browser reports an empty one for it and never
 * reports a resize for it, whatever the text inside it measures. This
 * double is used by the test that watches the probe's text, which has to be
 * a box of its own for the observer to see a change of the font.
 */
class ContentBoxResizeObserver implements ResizeObserver {
  /** Every observer the preview has made. */
  static instances: ContentBoxResizeObserver[] = [];
  private readonly callback: ResizeObserverCallback;
  private readonly targets = new Set<Element>();
  /** The box the browser reported the last time it looked. */
  private readonly reported = new Map<Element, { width: number; height: number }>();
  private watching = true;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    ContentBoxResizeObserver.instances.push(this);
  }

  observe(target: Element): void {
    this.targets.add(target);
    this.reported.set(target, observedBox(target));
  }

  unobserve(target: Element): void {
    this.targets.delete(target);
    this.reported.delete(target);
  }

  disconnect(): void {
    this.targets.clear();
    this.reported.clear();
    this.watching = false;
  }

  /** The resize the browser would report. */
  fire(): void {
    if (!this.watching) return;
    let changed = false;
    for (const target of this.targets) {
      const box = observedBox(target);
      const previous = this.reported.get(target);
      if (previous && previous.width === box.width && previous.height === box.height) continue;
      this.reported.set(target, box);
      changed = true;
    }
    if (!changed) return;
    this.callback([], this);
  }
}

const buildCsv = (rows: number, columns: number): string => {
  const lines: string[] = [];
  for (let row = 0; row < rows; row += 1) {
    const cells: string[] = [];
    for (let column = 0; column < columns; column += 1) {
      cells.push(`r${row}c${column}`.padEnd(4, 'x'));
    }
    lines.push(cells.join(','));
  }
  return lines.join('\n');
};

/**
 * A file whose text is longer than the preview parses on the thread it is
 * on, so the preview parses it in a worker.
 *
 * The file holds the same line over and over, so it is large without
 * holding more than a few values.
 */
const buildLargeCsv = (columns: number): string => {
  const line = buildCsv(1, columns);
  const lines: string[] = [];
  let length = 0;
  while (length <= SMALL_FILE_CHAR_LIMIT) {
    lines.push(line);
    length += line.length + 1;
  }
  return lines.join('\n');
};

/**
 * A file that is parsed in a worker, and whose first data row holds a
 * character the browser can lay out wider than the monospace font of the
 * preview.
 *
 * The widths of such a file are counted again with the measured characters,
 * and that count runs in the worker.
 */
const buildLargeCsvWithWideCharacter = (columns: number): string => {
  const lines = buildLargeCsv(columns).split('\n');
  const first = lines[1];
  if (first === undefined) return lines.join('\n');
  lines[1] = `Ω${first}`;
  return lines.join('\n');
};

/**
 * A file of exactly the given number of characters, in rows of forty.
 */
const buildCsvOfLength = (length: number): string => {
  const rows = Math.floor(length / 41);
  const text = `${'x'.repeat(40)}\n`.repeat(rows);
  return text + 'x'.repeat(length - text.length);
};

/**
 * A table whose first data row holds a character the browser can lay out
 * wider than the monospace font of the preview.
 *
 * The character is measured in the browser, and the widths of the columns
 * are counted again with the measurement.
 */
const buildCsvWithWideCharacter = (rows: number, columns: number): string => {
  const lines = buildCsv(rows, columns).split('\n');
  const first = lines[1];
  if (first === undefined) return lines.join('\n');
  lines[1] = `Ω${first.slice(1)}`;
  return lines.join('\n');
};

/**
 * A table whose first data row holds nothing but delimiters. Such a row has
 * no text in it, so it is shorter than the rows around it.
 */
const buildCsvWithAnEmptyRow = (rows: number, columns: number): string => {
  const lines = buildCsv(rows, columns).split('\n');
  lines.splice(1, 0, Array.from({ length: columns }, () => '').join(','));
  return lines.join('\n');
};

/**
 * A table whose first columns have no header.
 *
 * A header cell without text has no line in it, so a header row that takes
 * its height from the cells in view collapses to the padding and the border.
 */
const buildCsvWithEmptyHeaders = (rows: number, columns: number, emptyColumns: number): string => {
  const header = Array.from({ length: columns }, (_, column) => (
    column < emptyColumns ? '' : `h${String(column).padStart(3, '0')}`
  ));
  const lines = buildCsv(rows - 1, columns).split('\n');
  return [header.join(','), ...lines].join('\n');
};

/**
 * A table whose columns are all four characters wide, so the model is exact.
 *
 * The file holds ten rows of the same line, so its grid is too large to be
 * kept whole and the preview windows it.
 */
const buildUniformCsv = (columns: number, rows = 10): string => {
  const cells: string[] = [];
  for (let column = 0; column < columns; column += 1) {
    cells.push(`c${String(column).padStart(3, '0')}`);
  }
  const line = cells.join(',');
  return [line, ...Array.from({ length: rows }, () => line)].join('\n');
};

/**
 * The height of a row, the way the browser lays it out.
 *
 * A row takes the height it asks for, and a row whose cells hold no text is
 * only as tall as its padding and its border.
 */
const rowHeight = (row: Element): number => {
  const asked = row instanceof HTMLElement ? Number.parseFloat(row.style.height) : 0;
  const empty = Array.from(row.querySelectorAll('td, th')).every((cell) => !cell.textContent);
  return Math.max(asked || 0, empty ? EMPTY_ROW_HEIGHT : ROW_HEIGHT);
};

/**
 * What the preview reads from the box of an element. happy-dom has no
 * layout, so the boxes the preview measures are given the sizes a browser
 * would report.
 */
const measureBox = (element: Element) => {
  if (element.tagName === 'TR') {
    return { width: 0, height: rowHeight(element) };
  }
  if (element.tagName === 'THEAD') {
    // The header is as tall as the row it holds.
    const row = element.querySelector('tr');
    return { width: 0, height: row ? rowHeight(row) : 0 };
  }
  if (element.tagName === 'SPAN') {
    // The probe that holds the text measures the advance of a character. The
    // probe that stands for a cell measures the height of a row with text.
    const text = element.textContent ?? '';
    if (text.length === PROBE_CHARACTER_COUNT) {
      return { width: probeTextWidth, height: LINE_HEIGHT };
    }
    // A character of the file is drawn on its own, and the browser reports
    // the width it takes in the font it has.
    const advance = characterAdvances.get(text);
    if (advance !== undefined) {
      return { width: advance, height: ROW_HEIGHT };
    }
    return { width: 0, height: ROW_HEIGHT };
  }
  return { width: 0, height: 0 };
};

/**
 * The box the browser reports for an element it observes.
 *
 * The browser reports the content box of the element, and an inline box has
 * no content box of its own: the browser reports an empty one for it,
 * whatever the text inside it measures. An inline block has a content box of
 * its own, and that box follows the font.
 */
const observedBox = (element: Element) => {
  // happy-dom does not apply the stylesheets, so the display of an element
  // is read from the class that asks for it.
  const isInline = element.tagName === 'SPAN' && !element.classList.contains('inline-block');
  return isInline ? { width: 0, height: 0 } : measureBox(element);
};

/** The props of the watcher that records the document after every commit. */
type CommitWatcherProps = {
  onCommit: () => void;
  children?: ReactNode;
};

/**
 * The preview with a parent that records the document after every commit.
 *
 * The layout effect of a parent runs after the layout effects of its
 * children, so the record holds the document as the commit left it, before
 * the preview has corrected its window.
 */
const CommitWatcher = ({ onCommit, children }: CommitWatcherProps) => {
  useLayoutEffect(() => {
    onCommit();
  });
  return <>{children}</>;
};

describe('TableArtifact', () => {
  let windowInstance: Window;
  let host: HTMLDivElement;
  let root: Root;
  let scrollTop = 0;
  let scrollLeft = 0;
  /** The worker of the runtime, which this test takes away. */
  let originalWorker: unknown;
  /** The width of the box the preview is rendered in. */
  let viewportWidth = VIEWPORT_WIDTH;
  /** The padding on each side of a cell, as the preview reads it. */
  let cellPadding = 8;
  /** The border on the inline end of a cell, as the preview reads it. */
  let cellBorder = 1;
  /**
   * Whether the runtime resolves the logical side of the border. A runtime
   * that does not knows only the physical sides.
   */
  let logicalBorderResolves = true;

  beforeEach(() => {
    windowInstance = new Window();
    FakeResizeObserver.instances = [];
    ContentBoxResizeObserver.instances = [];
    probeTextWidth = PROBE_CHARACTER_COUNT * MEASURED_ADVANCE;
    characterAdvances.clear();
    widthCounts = 0;
    rowCuts = 0;
    parseCalls = 0;
    FakeWorker.instances = [];
    FakeWorker.holdsCounts = false;
    FakeWorker.holdsParses = false;
    viewportWidth = VIEWPORT_WIDTH;
    cellPadding = 8;
    cellBorder = 1;
    logicalBorderResolves = true;
    // happy-dom does not apply the stylesheets, so the values the preview
    // reads from the computed style are given the ones its own classes ask
    // for, and the direction is the one the root element carries.
    const computedStyle = (): ComputedStyleDouble => {
      const direction = windowInstance.document.documentElement.getAttribute('dir');
      const rtl = direction === 'rtl';
      return {
        direction: rtl ? 'rtl' : 'ltr',
        paddingLeft: `${cellPadding}px`,
        paddingRight: `${cellPadding}px`,
        // The border of a cell is on its inline end: the right edge of a
        // left-to-right document, the left edge of a right-to-left one.
        borderInlineEndWidth: logicalBorderResolves ? `${cellBorder}px` : '',
        borderRightWidth: rtl ? '0px' : `${cellBorder}px`,
        borderLeftWidth: rtl ? `${cellBorder}px` : '0px',
        maxWidth: '512px',
      };
    };
    // The preview measures the character width from the width of the probe's
    // text and the row height from the probe that stands for a cell, the way
    // a browser measures them.
    Object.defineProperty(windowInstance.Element.prototype, 'getBoundingClientRect', {
      configurable: true,
      value: function (this: Element) {
        const box = measureBox(this);
        return {
          width: box.width,
          height: box.height,
          top: 0,
          left: 0,
          right: box.width,
          bottom: box.height,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        };
      },
    });
    Object.assign(globalThis, {
      window: windowInstance,
      document: windowInstance.document,
      HTMLElement: windowInstance.HTMLElement,
      Element: windowInstance.Element,
      Node: windowInstance.Node,
      MutationObserver: windowInstance.MutationObserver,
      ResizeObserver: FakeResizeObserver,
      getComputedStyle: computedStyle,
      IS_REACT_ACT_ENVIRONMENT: true,
    });
    // The runtime of this test has no worker, so the preview parses the file
    // on the main thread, which is the path a runtime without a worker
    // takes.
    originalWorker = globalThis.Worker;
    Reflect.deleteProperty(globalThis, 'Worker');
    // A worker of an earlier test must not answer for this one.
    resetDelimitedWorkerClientForTests();
    // The preview reads the box it is in and where that box is scrolled to.
    Object.defineProperty(windowInstance.HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get: () => viewportWidth,
    });
    Object.defineProperty(windowInstance.HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get: () => VIEWPORT_HEIGHT,
    });
    Object.defineProperty(windowInstance.Element.prototype, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => { scrollTop = value; },
    });
    Object.defineProperty(windowInstance.Element.prototype, 'scrollLeft', {
      configurable: true,
      get: () => scrollLeft,
      set: (value: number) => { scrollLeft = value; },
    });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    scrollTop = 0;
    scrollLeft = 0;
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    await windowInstance.happyDOM.close();
    Object.assign(globalThis, { Worker: originalWorker });
  });

  const render = async (content: string, sizeBytes: number | null = null) => {
    await act(async () => {
      root.render(
        <I18nProvider>
          <TableArtifact path="/repo/data.csv" content={content} sizeBytes={sizeBytes} />
        </I18nProvider>,
      );
    });
    // The language sets the direction on the root element, and the preview
    // answers that in a task of its own. The answer has to land inside an
    // act, or the update lands outside one.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };

  const scrollTo = async (top: number, left = 0) => {
    scrollTop = top;
    scrollLeft = left;
    const scroller = windowInstance.document.querySelector('.overflow-auto');
    await act(async () => {
      scroller?.dispatchEvent(new windowInstance.Event('scroll', { bubbles: true }));
    });
  };

  /** The resize the browser would report, with the panel at its new width. */
  const resize = async (width: number) => {
    viewportWidth = width;
    await act(async () => {
      for (const observer of FakeResizeObserver.instances) observer.fire();
    });
  };

  const dataCells = () => Array.from(host.querySelectorAll('td[title]'));

  /**
   * The columns the preview has in the document, in order. The values of the
   * uniform table are named after their column.
   */
  const mountedColumns = (): number[] => {
    const columns = dataCells().map((cell) => Number(cell.getAttribute('title')?.replace(/\D/g, '')));
    return [...new Set(columns)].sort((a, b) => a - b);
  };

  /** The columns from the first to the one before the last. */
  const columnsFrom = (start: number, end: number): number[] => (
    Array.from({ length: end - start }, (_, index) => start + index)
  );

  /** The rows the preview has in the document, by the name of their values. */
  const mountedRowNames = (): string[] => (
    [...new Set(dataCells()
      .map((cell) => (cell.getAttribute('title') ?? '').replace(/c\d+$/, ''))
      .filter((name) => name !== ''))]
  );

  /**
   * The rows the preview has in the document, with the index of the data they
   * hold. The values of the built file are named after their row, and the
   * first line of the file is its header, so the index of the data is one
   * less than the number in the name.
   */
  const mountedRows = (): { index: number; element: Element }[] => (
    Array.from(host.querySelectorAll('tbody tr'))
      .filter((row) => row.querySelector('td[title]'))
      .map((row) => ({
        index: Number((row.querySelector('td[title]')?.getAttribute('title') ?? '').replace(/r(\d+)c\d+$/, '$1')) - 1,
        element: row,
      }))
  );

  /** The stripe a row carries. */
  const stripeOf = (row: Element): string => (
    (row.getAttribute('class') ?? '').includes('bg-[var(--surface-background)]')
      ? 'even'
      : 'odd'
  );

  /** The column of a cell, from the name of its value. */
  const columnOf = (value: string): number => Number(value.replace(/^r\d+c/, ''));

  /** True when the cell keeps the border on its inline end. */
  const keepsEndBorder = (cell: Element | null): boolean => (
    (cell?.getAttribute('class') ?? '').includes('border-e')
    && !(cell?.getAttribute('class') ?? '').includes('border-e-0')
  );

  /**
   * The classes that decide the padding and the border of a cell. The last
   * column does not have the border, so it is left out.
   */
  const chromeClasses = (element: Element | null): string[] => (
    (element?.getAttribute('class') ?? '')
      .split(/\s+/)
      .filter((name) => name.startsWith('px-') || (name.startsWith('border-e') && name !== 'border-e-0'))
      .sort()
  );

  /**
   * The classes that decide the box of a cell: the padding around its text
   * and the border under it. The font size is the one of the table, which
   * both kinds of cell inherit.
   */
  const boxClasses = (element: Element | null): string[] => (
    (element?.getAttribute('class') ?? '')
      .split(/\s+/)
      .filter((name) => name.startsWith('px-') || name.startsWith('py-') || name === 'border-b')
      .sort()
  );

  /** The height of the header row, the way the browser lays it out. */
  const headerRowHeight = (): number => {
    const row = host.querySelector('thead tr');
    return row ? row.getBoundingClientRect().height : 0;
  };

  /** The height of the sticky header, the way the browser lays it out. */
  const stickyHeaderHeight = (): number => {
    const head = host.querySelector('thead');
    return head ? head.getBoundingClientRect().height : 0;
  };

  /** The border classes of a cell. */
  const borderClasses = (element: Element | null): string[] => (
    (element?.getAttribute('class') ?? '')
      .split(/\s+/)
      .filter((name) => name.startsWith('border-'))
      .sort()
  );

  /**
   * The spacer cells of the first mounted row: the ones that stand for the
   * columns beside the window.
   */
  const columnSpacers = (): Element[] => {
    const row = Array.from(host.querySelectorAll('tbody tr'))
      .find((candidate) => candidate.querySelector('td[title]'));
    if (!row) return [];
    return Array.from(row.children).filter((cell) => !cell.hasAttribute('title'));
  };

  /** The first mounted row of the body. */
  const firstMountedRow = (): Element | null => (
    Array.from(host.querySelectorAll('tbody tr'))
      .find((row) => row.querySelector('td[aria-colindex]')) ?? null
  );

  /**
   * The cells that stand for the columns beside the window, split into the
   * ones before the window and the ones after it.
   *
   * The cells of the window state the column they sit in and the spacers
   * state none, so the cells around them are the ones that stand for the
   * columns beside the window.
   */
  const spacerGroups = (row: Element | null) => {
    if (!row) return { leading: [], trailing: [] };
    const cells = Array.from(row.children);
    const isWindow = (cell: Element) => cell.hasAttribute('aria-colindex');
    const first = cells.findIndex(isWindow);
    const last = cells.map(isWindow).lastIndexOf(true);
    return {
      leading: cells.slice(0, first),
      trailing: cells.slice(last + 1),
    };
  };

  /** The number of columns a spacer cell stands for. */
  const spanOf = (cell: Element): number => Number(cell.getAttribute('colspan') ?? '1');

  /** The number of columns a group of spacer cells stands for. */
  const spanOfGroup = (cells: Element[]): number => (
    cells.reduce((sum, cell) => sum + spanOf(cell), 0)
  );

  test('releases a parse that finishes after the preview unmounts', async () => {
    Object.assign(globalThis, { Worker: FakeWorker });
    FakeWorker.holdsParses = true;
    await render(buildCsv(10_000, 4));

    const worker = FakeWorker.instances[0];
    if (!worker) throw new Error('The preview did not make a worker');
    const parse = worker.requests.find((request) => request.type === 'parse');
    if (!parse || parse.type !== 'parse') throw new Error('The preview did not request a parse');

    await act(async () => root.render(null));
    worker.releaseParses();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    expect(worker.requests.some((request) => request.type === 'release' && request.parseId === parse.id)).toBe(true);
    expect(worker.hasParse(parse.id)).toBe(false);
  });

  test('a stale cleanup leaves the replacement file parse held', async () => {
    Object.assign(globalThis, { Worker: FakeWorker });
    FakeWorker.holdsParses = true;
    await render(buildCsv(10_000, 4));
    const worker = FakeWorker.instances[0];
    if (!worker) throw new Error('The preview did not make a worker');
    const first = worker.requests.find((request) => request.type === 'parse');
    if (!first || first.type !== 'parse') throw new Error('The preview did not request its first parse');

    await render(`${buildCsv(10_000, 4)}\nreplacement`);
    const parses = worker.requests.filter((request) => request.type === 'parse');
    const second = parses[1];
    if (!second || second.type !== 'parse') throw new Error('The preview did not request its replacement parse');

    worker.releaseParses();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    expect(worker.hasParse(first.id)).toBe(false);
    expect(worker.hasParse(second.id)).toBe(true);
    expect(worker.requests.some((request) => request.type === 'release' && request.parseId === first.id)).toBe(true);
  });

  test('mounts only the cells in view of a wide export', async () => {
    await render(buildCsv(2_100, 50));

    const cells = dataCells();
    const maxRows = Math.ceil(VIEWPORT_HEIGHT / ROW_HEIGHT) + 1 + 2 * ROW_OVERSCAN;
    const maxColumns = Math.ceil(VIEWPORT_WIDTH / COLUMN_WIDTH) + 2 * COLUMN_OVERSCAN;
    expect(cells.length).toBeGreaterThan(0);
    expect(cells.length).toBeLessThanOrEqual(maxRows * maxColumns);
    // The rows that are not in view are not in the document.
    expect(host.querySelectorAll('td').length).toBeLessThan(2_000);
  });

  test('keeps the header, its scope and the title on every cell', async () => {
    await render(buildCsv(20, 4));

    const headers = Array.from(host.querySelectorAll('th[scope="col"]'));
    expect(headers.length).toBeGreaterThan(0);
    expect(headers[0]?.textContent).toBe('r0c0');
    const cells = dataCells();
    expect(cells.length).toBeGreaterThan(0);
    expect(cells[0]?.getAttribute('title')).toBe(cells[0]?.textContent);
  });

  test('states the rows, the columns and the cap in the meta line', async () => {
    await render(buildCsv(2_100, 50), 1_234);

    const meta = host.querySelector('.typography-meta')?.textContent ?? '';
    expect(meta).toContain('2099 rows · 50 columns');
    expect(meta).toContain('Showing the first 2000 of 2099 rows');
    expect(meta).toContain('1.2 KB');
  });

  test('reaches the last retained row when the table is scrolled to the end', async () => {
    await render(buildCsv(2_100, 50));

    await scrollTo(ROW_HEIGHT + 1_999 * ROW_HEIGHT);

    const values = dataCells().map((cell) => cell.getAttribute('title'));
    expect(values).toContain('r1999c0');
  });

  test('reaches the last retained row when a row of the file has no text', async () => {
    // The first data row holds nothing but delimiters, so it is shorter than
    // the rows below it.
    await render(buildCsvWithAnEmptyRow(2_000, 4));

    await scrollTo(ROW_HEIGHT + 1_999 * ROW_HEIGHT);

    const values = dataCells().map((cell) => cell.getAttribute('title'));
    expect(values).toContain('r1999c0');
  });

  test('gives a row without text the height of a row with text', async () => {
    await render(buildCsvWithAnEmptyRow(4, 3));

    const rows = Array.from(host.querySelectorAll<HTMLElement>('tbody tr'))
      .filter((row) => row.querySelector('td[title]'));
    expect(rows.length).toBe(4);
    for (const row of rows) {
      expect(row.style.height).toBe(`${ROW_HEIGHT}px`);
    }
  });

  test('keeps the height of the header row when the header cells are empty', async () => {
    // The first columns of the file have no header, so the window opens over
    // header cells that hold nothing. A header row that takes its height from
    // the cells in view collapses to the padding and the border, and the
    // content below it jumps while the window moves.
    await render(buildCsvWithEmptyHeaders(20, 50, 25));

    // The header row is given the height of a row, so the cells in view
    // cannot change it.
    expect(host.querySelector<HTMLElement>('thead tr')?.style.height).toBe(`${ROW_HEIGHT}px`);
    expect(headerRowHeight()).toBe(ROW_HEIGHT);
    expect(stickyHeaderHeight()).toBe(ROW_HEIGHT);

    // The window moves onto the columns that have a header.
    await scrollTo(0, 1200);
    expect(headerRowHeight()).toBe(ROW_HEIGHT);
    expect(stickyHeaderHeight()).toBe(ROW_HEIGHT);

    // And back onto the ones that have none.
    await scrollTo(0, 0);
    expect(headerRowHeight()).toBe(ROW_HEIGHT);
    expect(stickyHeaderHeight()).toBe(ROW_HEIGHT);
  });

  test('gives the header cell the box of a cell of the body', async () => {
    await render(buildCsv(4, 3));

    // The header row is given the height of a row, and that height is
    // measured from a cell of the body, so the header cell has to hold the
    // same box.
    expect(boxClasses(host.querySelector('th[scope="col"]')))
      .toEqual(boxClasses(host.querySelector('td[title]')));
  });

  test('mounts the same rows for a file whose header cells are empty', async () => {
    await render(buildCsv(200, 50));
    const withHeaders = host.querySelectorAll('tbody tr').length;
    await render(buildCsvWithEmptyHeaders(200, 50, 25));
    const withEmptyHeaders = host.querySelectorAll('tbody tr').length;

    // The sticky header covers one row, whichever header cells are in view,
    // so the window holds the same rows either way.
    expect(withEmptyHeaders).toBe(withHeaders);
  });

  test('writes the height of a spacer row on the row', async () => {
    await render(buildCsv(2_100, 50));
    await scrollTo(ROW_HEIGHT * 100);

    const spacers = Array.from(host.querySelectorAll<HTMLElement>('tbody tr'))
      .filter((row) => !row.querySelector('td[title]'));
    expect(spacers.length).toBeGreaterThan(0);
    for (const spacer of spacers) {
      // The spacer carries the height of the rows it stands for.
      const asked = Number.parseFloat(spacer.style.height);
      expect(asked).toBeGreaterThan(0);
      expect(asked % ROW_HEIGHT).toBe(0);
      // The height is on the row: a cell's own padding would make the cell
      // taller than the height it asks for, and the rows would sit lower
      // than the model says.
      expect(spacer.firstElementChild?.getAttribute('style') ?? '').not.toContain('height');
    }
  });

  test('names the row the scroll position is on when a row has no text', async () => {
    await render(buildCsvWithAnEmptyRow(200, 4));

    // Ten rows down, with the scroll position inside the eleventh.
    await scrollTo(ROW_HEIGHT * 10 + 13);

    expect(mountedRowNames()).toContain('r10');
  });

  test('shows the empty state for a file without rows', async () => {
    await render('');

    expect(host.textContent).toContain('This file has no rows.');
    expect(host.querySelector('table')).toBeNull();
  });

  test('opens a file the same way after a file without rows', async () => {
    // A file without rows has no table to measure, so the preview has to be
    // measured again for the file that comes after it.
    await render('');
    await render(buildCsv(20, 8));

    // The whole table fits into the panel, so every column of it and every
    // one of its rows has to be in the document.
    expect(host.querySelectorAll('th[scope="col"]').length).toBe(8);
    expect(dataCells().length).toBe(19 * 8);
  });

  test('notices a font change after a file without rows', async () => {
    await render('');
    // The grid of the file is too large to be kept whole, so the file is
    // windowed and the width of a character decides which columns are in
    // the document.
    await render(buildCsv(100, 50));
    const before = mountedColumns().length;

    // The font changes, so a character takes more room and fewer columns
    // fit into the panel.
    probeTextWidth = PROBE_CHARACTER_COUNT * MEASURED_ADVANCE * 4;
    await act(async () => {
      for (const observer of FakeResizeObserver.instances) observer.fire();
    });

    expect(mountedColumns().length).toBeLessThan(before);
  });

  test('notices a font change through the probe it watches', async () => {
    // The observer of the browser reports the content box of the element it
    // watches, and an inline box has no content box of its own: the browser
    // reports an empty one for it and never reports a resize for it. The
    // preview watches the probe's text, so that text has to be a box of its
    // own for a change of the font to reach the measurement.
    globalThis.ResizeObserver = ContentBoxResizeObserver;
    // The grid of the file is too large to be kept whole, so the file is
    // windowed.
    await render(buildCsv(100, 50));
    const before = mountedColumns().length;
    expect(before).toBeGreaterThan(0);

    // The font changes, so a character takes more room and fewer columns
    // fit into the panel.
    probeTextWidth = PROBE_CHARACTER_COUNT * MEASURED_ADVANCE * 4;
    await act(async () => {
      for (const observer of ContentBoxResizeObserver.instances) observer.fire();
    });

    expect(mountedColumns().length).toBeLessThan(before);
  });

  test('computes the window of the file that is open when the table is scrolled', async () => {
    // The window is computed from the model of the commit that is on
    // screen, so a scroll event asks for the rows of the file that is open
    // now.
    await render(buildCsv(100, 50));
    await scrollTo(ROW_HEIGHT * 50);
    expect(mountedRowNames()).toContain('r50');

    // A new file, with more rows and fewer columns. Its grid is too large to
    // be kept whole, so the file is windowed.
    await render(buildCsv(500, 8));
    await scrollTo(ROW_HEIGHT * 400);

    // The scroll lands on a row of the file that is open now, not on a row
    // of the file before it.
    expect(mountedRowNames()).toContain('r400');
  });

  test('measures a file that has a header but no rows', async () => {
    // The measuring probe is in the document as long as the file has
    // columns, so a file with a header and no rows is measured like any
    // other file. The header holds more columns than a grid may hold and be
    // kept whole, so the file is windowed.
    const header = Array.from({ length: 2_100 }, (_, column) => `h${column}`).join(',');
    await render(header);
    const before = host.querySelectorAll('th[scope="col"]').length;
    expect(before).toBeGreaterThan(0);

    // The font changes, so a character takes more room and fewer columns
    // fit into the panel.
    probeTextWidth = PROBE_CHARACTER_COUNT * MEASURED_ADVANCE * 4;
    await act(async () => {
      for (const observer of FakeResizeObserver.instances) observer.fire();
    });

    expect(host.querySelectorAll('th[scope="col"]').length).toBeLessThan(before);
  });

  test('does not count the widths of the columns again when the panel is resized', async () => {
    // A file with a character the browser lays out wider than the count
    // gives it, so the widths of the body are counted again with the
    // measured table.
    characterAdvances.set('Ω', 40);
    await render(buildCsvWithWideCharacter(200, 50));
    const afterOpen = widthCounts;
    // The count has to have happened, or the count below says nothing.
    expect(afterOpen).toBeGreaterThan(0);

    // The panel grows: the room it has changes, the widths the file asks for
    // do not, so the widths are not counted again.
    await resize(VIEWPORT_WIDTH + 240);

    expect(widthCounts).toBe(afterOpen);

    // And a scroll over the file does not count them again either.
    await scrollTo(ROW_HEIGHT * 100);

    expect(widthCounts).toBe(afterOpen);
  });

  test('counts the widths of the columns again when the font changes', async () => {
    characterAdvances.set('Ω', 40);
    await render(buildCsvWithWideCharacter(200, 50));
    const afterOpen = widthCounts;
    expect(afterOpen).toBeGreaterThan(0);

    // The font changes, so the characters are measured again and the widths
    // of the file are counted with them.
    probeTextWidth = PROBE_CHARACTER_COUNT * MEASURED_ADVANCE * 4;
    await resize(VIEWPORT_WIDTH);

    expect(widthCounts).toBeGreaterThan(afterOpen);
  });

  test('counts the widths of the columns again when the file changes', async () => {
    characterAdvances.set('Ω', 40);
    await render(buildCsvWithWideCharacter(20, 4));
    const afterOpen = widthCounts;
    expect(afterOpen).toBeGreaterThan(0);

    await render(buildCsvWithWideCharacter(20, 8));

    expect(widthCounts).toBeGreaterThan(afterOpen);
  });

  test('counts the widths of the columns again when a file is opened again', async () => {
    // A file with a character the browser lays out wider than the count gives
    // it, so the widths of the body are counted again with the measured
    // table.
    characterAdvances.set('Ω', 40);
    const content = buildCsvWithWideCharacter(20, 4);
    await render(content);
    const afterOpen = widthCounts;
    expect(afterOpen).toBeGreaterThan(0);
    // The character takes five and a third cells, so the first column is as
    // wide as the text the browser lays out for it.
    expect(host.querySelector('col')?.getAttribute('style')).toContain('calc(8.334ch + 16px + 1px)');

    // A file without rows has no table to measure, so the widths of the file
    // before it stay counted.
    await render('');

    // The file is opened again. It is parsed again, and the table of the new
    // parse starts from the widths the parser counted, so the widths that
    // were counted for the file before it are not the widths of the new
    // table and are counted again.
    await render(content);

    expect(widthCounts).toBeGreaterThan(afterOpen);
    expect(host.querySelector('col')?.getAttribute('style')).toContain('calc(8.334ch + 16px + 1px)');
  });

  test('does not publish the widths of a count whose measurements are old', async () => {
    Object.assign(globalThis, { Worker: FakeWorker });
    // The worker holds the answer of the count back, so the test decides when
    // it arrives.
    FakeWorker.holdsCounts = true;
    characterAdvances.set('Ω', 40);
    await render(buildLargeCsvWithWideCharacter(50));
    const worker = FakeWorker.instances[0];
    if (!worker) throw new Error('The worker was not asked for the file');
    // The widths of the file are counted again in the worker, with the
    // characters the browser measured.
    const count = worker.requests.find((request) => request.type === 'count');
    if (!count || count.type !== 'count') throw new Error('The worker was not asked to count the widths');
    expect([...count.characterWidths.values()].some((width) => width > 1)).toBe(true);

    // The font changes, and the character is not wider than the count any
    // more, so the widths the parser counted are the exact ones.
    characterAdvances.set('Ω', 7.5);
    await resize(VIEWPORT_WIDTH);
    expect(host.querySelector('col')?.getAttribute('style')).toContain('calc(5ch + 16px + 1px)');

    // The answer of the count arrives now. It was asked for with the
    // measurements of the font before it, so its widths belong to a font that
    // is not the one on the screen, and they are not published.
    await act(async () => {
      worker.releaseCounts();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(host.querySelector('col')?.getAttribute('style')).toContain('calc(5ch + 16px + 1px)');
  });

  test('does not count the widths of a file that is closed on this thread', async () => {
    Object.assign(globalThis, { Worker: FakeWorker });
    // The worker holds the answer of the count back, so the test decides when
    // it arrives.
    FakeWorker.holdsCounts = true;
    characterAdvances.set('Ω', 40);
    await render(buildLargeCsvWithWideCharacter(50));

    // The file is closed, and a file without rows takes its place. A file
    // without rows has no table to measure, so nothing is counted for it.
    await render('');

    // The worker gives up, and the request of the count fails.
    await act(async () => {
      resetDelimitedWorkerClientForTests();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // The widths of the file that is closed are not counted on this thread:
    // that walk is over the text of every row the preview holds, for a
    // file nobody is looking at.
    expect(widthCounts).toBe(0);
  });

  test('does not count the widths of the columns again for a file of plain latin', async () => {
    // Every character of the file is counted right, so the widths the parser
    // counted are the exact widths and the body is not counted again.
    await render(buildCsv(200, 50));

    expect(widthCounts).toBe(0);
  });

  test('cuts a row out of the source only once', async () => {
    await render(buildCsv(600, 4));
    const afterOpen = rowCuts;
    expect(afterOpen).toBeGreaterThan(0);

    // The window moves over rows that were not mounted before.
    await scrollTo(ROW_HEIGHT * 300);
    const afterScroll = rowCuts;
    expect(afterScroll).toBeGreaterThan(afterOpen);

    // And back over the rows that were mounted before. They were cut out of
    // the source when they were mounted the first time, so a scroll that
    // comes back over them does not pay for them twice.
    await scrollTo(0);

    expect(rowCuts).toBe(afterScroll);
  });

  test('drops the cut rows that do not fit in the cache', async () => {
    // A file with 500 columns holds 500 cells in every row, so the cache
    // holds a few rows of it and not the whole file.
    await render(buildCsv(100, 500));
    const afterOpen = rowCuts;
    expect(afterOpen).toBeGreaterThan(0);

    // The window moves over rows that were not mounted before.
    await scrollTo(ROW_HEIGHT * 40);
    const afterScroll = rowCuts;
    expect(afterScroll).toBeGreaterThan(afterOpen);

    // The cache had no room for the rows that were mounted before, so they
    // are cut again.
    await scrollTo(0);

    expect(rowCuts).toBeGreaterThan(afterScroll);
  });

  test('keeps the rows that are on screen when they do not fit in the cache', async () => {
    // A file with 500 columns holds more cells in one row than the cache has
    // room for, so the rows that are on screen are held and the rows beside
    // them are dropped.
    await render(buildCsv(100, 500));
    const afterOpen = rowCuts;
    expect(afterOpen).toBeGreaterThan(0);

    // The window moves over one row. The rows that stay on screen are not
    // cut again, so only the row that came into the window is.
    await scrollTo(ROW_HEIGHT);

    expect(rowCuts - afterOpen).toBeLessThanOrEqual(ROW_OVERSCAN);
  });

  test('shows a loading state while the file is parsed', async () => {
    // The file is larger than the preview parses on the thread it is on, so
    // it is parsed in a worker and the worker answers in a promise. The
    // table is not there in the first commit.
    const content = buildLargeCsv(50);
    act(() => {
      root.render(
        <I18nProvider>
          <TableArtifact path="/repo/data.csv" content={content} sizeBytes={null} />
        </I18nProvider>,
      );
    });

    expect(host.textContent).toContain('Loading...');
    expect(host.querySelector('table')).toBeNull();

    // And the table is there once the file is parsed.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(host.querySelector('table')).not.toBeNull();
  });

  test('parses a small file on this thread, without a worker', async () => {
    // The runtime has a worker, and the file is small enough to be parsed on
    // the thread the preview is on, so the table is there in the first
    // commit and no worker is made for it.
    Object.assign(globalThis, { Worker: FakeWorker });
    act(() => {
      root.render(
        <I18nProvider>
          <TableArtifact path="/repo/data.csv" content={buildCsv(20, 4)} sizeBytes={null} />
        </I18nProvider>,
      );
    });

    expect(host.textContent).not.toContain('Loading...');
    expect(host.querySelector('table')).not.toBeNull();
    // The file was parsed here, and no worker was asked for it.
    expect(parseCalls).toBe(1);
    expect(FakeWorker.instances).toHaveLength(0);
  });

  test('parses a file of the limit on this thread and one character over it in the worker', async () => {
    // The limit is where the preview stops parsing on the thread of the
    // preview, so the file that is exactly as long is parsed here and the
    // file that is one character longer is read in the worker.
    Object.assign(globalThis, { Worker: FakeWorker });
    const atLimit = buildCsvOfLength(SMALL_FILE_CHAR_LIMIT);
    expect(atLimit.length).toBe(SMALL_FILE_CHAR_LIMIT);
    await render(atLimit);

    // The file was parsed here, and no worker was asked for it.
    expect(parseCalls).toBe(1);
    expect(FakeWorker.instances).toHaveLength(0);

    // One character more and the file is read in the worker.
    await render(buildCsvOfLength(SMALL_FILE_CHAR_LIMIT + 1));

    expect(parseCalls).toBe(1);
    expect(FakeWorker.instances).toHaveLength(1);
  });

  test('parses the file in the worker when the runtime has one', async () => {
    // The runtime has a worker, so the file is parsed in it and the thread
    // the user is looking at does not parse it.
    Object.assign(globalThis, { Worker: FakeWorker });
    const content = buildLargeCsv(50);
    await render(content);

    // The worker was asked to parse the file, and it answered with the
    // table of the file.
    const worker = FakeWorker.instances[0];
    expect(worker).toBeDefined();
    const request = worker?.requests[0];
    if (!request || request.type !== 'parse') throw new Error('The worker was not asked to parse the file');
    expect(request.content).toBe(content);
    expect(host.querySelector('table')).not.toBeNull();
    // The file was not parsed on the thread of the preview.
    expect(parseCalls).toBe(0);
  });

  test('parses the file on this thread when the runtime has no worker', async () => {
    // The runtime of this test has no worker, so the file is parsed here.
    // The parse is slower for the user and it is the last resort.
    await render(buildLargeCsv(50));

    expect(host.querySelector('table')).not.toBeNull();
    expect(parseCalls).toBe(1);
  });

  test('parses the file on this thread when the worker does not take the request', async () => {
    // The worker does not take the request, so the request fails and the
    // file is parsed here, the way a runtime without a worker does.
    Object.assign(globalThis, { Worker: RefusingWorker });
    await render(buildLargeCsv(50));

    expect(host.querySelector('table')).not.toBeNull();
    expect(parseCalls).toBe(1);
  });

  test('measures a file whose dropped rows hold wide characters the same as a latin file', async () => {
    // A dropped row is never measured, and the characters of a dropped row
    // are in no value that is counted, so they cannot change a width.
    const lines = buildCsv(2_001, 4).split('\n');
    lines.push('名前の名前,wide,wide,wide');
    await render(lines.join('\n'));

    // The first column holds seven characters in the longest of the rows
    // that are kept, so it is seven cells wide and not the ten cells the
    // dropped row would ask for.
    expect(host.querySelector('col')?.getAttribute('style')).toContain('calc(7ch + 16px + 1px)');
  });

  test('does not count the widths of a dropped row again', async () => {
    // The character of the dropped row is measured and laid out wider than
    // the count gives it, so the widths of the body are counted again with
    // the measured table. The dropped row is not one of the rows that are
    // counted, and its characters are in no value that is counted.
    characterAdvances.set('名', 20);
    const lines = buildCsv(2_001, 4).split('\n');
    lines.push('名前の名前,wide,wide,wide');
    await render(lines.join('\n'));

    // The widths of the body were counted again, because the character of
    // the dropped row is one the browser lays out wider than the count.
    expect(widthCounts).toBeGreaterThan(0);

    // The first column holds seven characters in the longest of the rows
    // that are kept, so it is seven cells wide and not the ten cells the
    // dropped row would ask for.
    expect(host.querySelector('col')?.getAttribute('style')).toContain('calc(7ch + 16px + 1px)');
  });

  test('measures a file whose kept rows hold wide characters the wide way', async () => {
    const lines = buildCsv(10, 4).split('\n');
    lines[3] = '名前の名前,wide,wide,wide';
    await render(lines.join('\n'));

    // Five full-width characters take ten cells, and the column is as wide
    // as the text the browser lays out for them.
    expect(host.querySelector('col')?.getAttribute('style')).toContain('10ch');
  });

  test('sizes a column to the value it holds', async () => {
    await render(`h\n${'x'.repeat(65)}`);
    expect(host.querySelector('col')?.getAttribute('style')).toContain('65ch');

    await render(`h\n${'x'.repeat(66)}`);
    expect(host.querySelector('col')?.getAttribute('style')).toContain('66ch');
  });

  test('writes the width of a column from the measurement of the cell', async () => {
    await render(buildCsv(4, 3));

    // The padding and the border the preview measured are the ones the width
    // of the column is written with.
    const columns = Array.from(host.querySelectorAll('col'));
    expect(columns).toHaveLength(3);
    expect(columns[0]?.getAttribute('style')).toContain('calc(4ch + 16px + 1px)');
    // The last column keeps its missing border.
    expect(columns[2]?.getAttribute('style')).toContain('calc(4ch + 16px)');
    expect(columns[2]?.getAttribute('style')).not.toContain('+ 1px');
  });

  test('writes the width of the table from the same measurement', async () => {
    await render(buildCsv(4, 3));

    // The table is as wide as its columns together: twelve characters, three
    // paddings and the two borders between the columns.
    expect(host.querySelector('table')?.getAttribute('style')).toContain('calc(12ch + 48px + 2px)');
  });

  test('moves the width of the columns when the padding of the cell changes', async () => {
    await render(buildCsv(4, 3));
    expect(host.querySelector('col')?.getAttribute('style')).toContain('calc(4ch + 16px + 1px)');

    // The padding of the cell changes, and the preview measures it again.
    cellPadding = 12;
    await resize(VIEWPORT_WIDTH);

    expect(host.querySelector('col')?.getAttribute('style')).toContain('calc(4ch + 24px + 1px)');
    expect(host.querySelector('table')?.getAttribute('style')).toContain('calc(12ch + 72px + 2px)');
  });

  test('moves the width of the columns when the border of the cell changes', async () => {
    await render(buildCsv(4, 3));
    expect(host.querySelector('col')?.getAttribute('style')).toContain('calc(4ch + 16px + 1px)');

    // The border of the cell changes, and the preview measures it again.
    cellBorder = 2;
    await resize(VIEWPORT_WIDTH);

    expect(host.querySelector('col')?.getAttribute('style')).toContain('calc(4ch + 16px + 2px)');
    expect(host.querySelector('table')?.getAttribute('style')).toContain('calc(12ch + 48px + 4px)');
  });

  test('the measuring probe carries the padding and the border of a cell', async () => {
    await render(buildCsv(4, 3));

    // The probe is read for the padding and the border of a cell, so the two
    // have to carry the same classes.
    const probe = host.querySelector('span[aria-hidden="true"]');
    const cell = host.querySelector('td[title]');
    expect(chromeClasses(probe)).not.toEqual([]);
    expect(chromeClasses(probe)).toEqual(chromeClasses(cell));
  });

  test('cuts a value one character over the room of the cell short', async () => {
    await render(`h\n${'x'.repeat(67)}`);

    // The column holds the 66 characters that fit, and the cell cuts the
    // value short.
    expect(host.querySelector('col')?.getAttribute('style')).toContain('66ch');
  });

  test('mounts the columns the viewer can see after the document turns right to left', async () => {
    await render(buildUniformCsv(500));

    // The window starts at the first column of a left-to-right document.
    expect(mountedColumns()).toEqual(columnsFrom(0, 20));

    // A right-to-left document is scrolled from the other end, and the
    // application sets the direction on the root element.
    await act(async () => {
      windowInstance.document.documentElement.setAttribute('dir', 'rtl');
      scrollLeft = -200;
      const scroller = windowInstance.document.querySelector('.overflow-auto');
      scroller?.dispatchEvent(new windowInstance.Event('scroll', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // The columns on screen are the ones the right-to-left window holds.
    expect(mountedColumns()).toEqual(columnsFrom(2, 24));
  });

  test('mounts the columns the viewer can see at the far end of a wide right-to-left table', async () => {
    const columns = 500;
    await render(buildUniformCsv(columns));

    // A right-to-left table is scrolled from its other end, and the
    // application sets the direction on the root element.
    await act(async () => {
      windowInstance.document.documentElement.setAttribute('dir', 'rtl');
      scrollLeft = -(columns * COLUMN_WIDTH - VIEWPORT_WIDTH);
      const scroller = windowInstance.document.querySelector('.overflow-auto');
      scroller?.dispatchEvent(new windowInstance.Event('scroll', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // The far end of a right-to-left table shows the last columns of the
    // file, and every one of them has to be in the document.
    expect(mountedColumns()).toEqual(columnsFrom(columns - 20, columns));
  });

  test('gives the spacer cells the border of a cell of the table', async () => {
    // The grid of the file is too large to be kept whole, so the file is
    // windowed.
    await render(buildCsv(100, 50));
    // The table is wide, so the window has a spacer on both sides of it.
    await scrollTo(0, 1000);

    const spacers = columnSpacers();
    expect(spacers).toHaveLength(2);
    const [leading, trailing] = spacers;
    // The rule under the row runs across the spacer, and the spacer before
    // the window is an interior boundary and keeps the border on its inline
    // end.
    expect(borderClasses(leading)).toEqual(['border-b', 'border-border/30', 'border-e']);
    // The spacer at the end of the file is the table's own last column and
    // keeps the missing border.
    expect(borderClasses(trailing)).toEqual(['border-b', 'border-border/30']);
  });

  test('gives the spacer cells of the header the border of a header cell', async () => {
    // The grid of the file is too large to be kept whole, so the file is
    // windowed.
    await render(buildCsv(100, 50));
    await scrollTo(0, 1000);

    const spacers = Array.from(host.querySelectorAll('thead th[colspan]'));
    expect(spacers).toHaveLength(2);
    const [leading, trailing] = spacers;
    expect(borderClasses(leading)).toEqual(['border-b', 'border-border/40', 'border-e']);
    expect(borderClasses(trailing)).toEqual(['border-b', 'border-border/40']);
  });

  test('carries the columns beside the window in cells that HTML allows', async () => {
    // A file with more columns than a cell may span, so the columns before
    // the window are more than 1000 of them.
    await render(buildUniformCsv(2_000));
    await scrollTo(0, 70_000);

    const cells = dataCells();
    const start = Number(cells[0].getAttribute('aria-colindex')) - 1;
    const end = Number(cells[cells.length - 1].getAttribute('aria-colindex'));
    // The window is far enough into the file that the columns before it are
    // more than a cell may span.
    expect(start).toBeGreaterThan(1_000);

    for (const row of [host.querySelector('thead tr'), firstMountedRow()]) {
      const { leading, trailing } = spacerGroups(row);
      // The cells before the window stand for the columns before it, and the
      // cells after it for the columns after it.
      expect(spanOfGroup(leading)).toBe(start);
      expect(spanOfGroup(trailing)).toBe(2_000 - end);
      // No cell stands for more columns than HTML allows. A cell that does
      // is laid out over fewer columns than it says, and the cells of the
      // window end up in the wrong columns.
      for (const cell of [...leading, ...trailing]) {
        expect(spanOf(cell)).toBeLessThanOrEqual(1_000);
      }
    }
  });

  test('carries a range of columns that fits in one cell with one cell', async () => {
    // A file with 1,001 columns: the columns before the window are at most
    // 1,000 of them, which is what a cell may span.
    await render(buildUniformCsv(1_001));
    await scrollTo(0, 20_000);

    const { leading, trailing } = spacerGroups(firstMountedRow());
    expect(leading).toHaveLength(1);
    expect(trailing).toHaveLength(1);
  });

  test('carries the rows outside the window in cells that HTML allows', async () => {
    // A file with more columns than a cell may span, so the row that stands
    // for the rows outside the window is wider than a cell may span.
    await render(buildUniformCsv(2_000, 100));
    await scrollTo(ROW_HEIGHT * 10);

    // The rows that stand for the rows above and below the window.
    const spacerRows = Array.from(host.querySelectorAll('tbody tr'))
      .filter((row) => !row.querySelector('td[title]'));
    expect(spacerRows).toHaveLength(2);
    for (const row of spacerRows) {
      const cells = Array.from(row.children);
      // The cells of the row stand for the columns of the file.
      expect(spanOfGroup(cells)).toBe(2_000);
      // No cell stands for more columns than HTML allows. A cell that does is
      // laid out over fewer columns than it says.
      for (const cell of cells) {
        expect(spanOf(cell)).toBeLessThanOrEqual(1_000);
      }
    }
  });

  test('keeps the width and the height of a table whose rows are carried by several cells', async () => {
    // The row that stands for the rows outside the window is carried by more
    // than one cell, and the table is as wide and as tall as it was.
    await render(buildUniformCsv(2_000, 100));
    await scrollTo(ROW_HEIGHT * 10);

    // The table is as wide as its columns ask for. The first thousand
    // columns are four characters wide and the rest are five.
    expect(host.querySelector('table')?.getAttribute('style')).toContain('calc(9000ch + 32000px + 1999px)');

    // The rows of the table are as tall as they were: the spacer rows carry
    // the height of the rows they stand for, and the header row is a row of
    // its own.
    const heightOf = (row: Element | null): number => (
      row instanceof HTMLElement ? Number.parseFloat(row.style.height) : 0
    );
    const bodyHeight = Array.from(host.querySelectorAll('tbody tr'))
      .reduce((sum, row) => sum + heightOf(row), 0);
    expect(bodyHeight + heightOf(host.querySelector('thead tr'))).toBe(101 * ROW_HEIGHT);
  });

  test('mounts the columns of the new file and not the ones of the file before it', async () => {
    // The window of the file before names more columns than the file that is
    // open now has, so the first commit of the new file has to hold the new
    // file's own columns.
    const commits: { headers: number; emptyCells: number }[] = [];
    const record = () => {
      commits.push({
        headers: host.querySelectorAll('th[scope="col"]').length,
        emptyCells: Array.from(host.querySelectorAll('td[title]'))
          .filter((cell) => cell.getAttribute('title') === '').length,
      });
    };
    const mount = async (content: string) => {
      await act(async () => {
        root.render(
          <I18nProvider>
            <CommitWatcher onCommit={record}>
              <TableArtifact path="/repo/data.csv" content={content} sizeBytes={null} />
            </CommitWatcher>
          </I18nProvider>,
        );
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    };

    await mount(buildCsv(20, 50));
    commits.length = 0;
    await mount(buildCsv(20, 4));

    // Every commit of the new file holds its own columns, and no cell of a
    // column the new file does not have.
    expect(commits.length).toBeGreaterThan(0);
    for (const commit of commits) {
      expect(commit.headers).toBeLessThanOrEqual(4);
      expect(commit.emptyCells).toBe(0);
    }
  });

  test('counts the border of a cell when the runtime does not resolve the logical side', async () => {
    // A runtime that does not resolve the logical border counts no border
    // at all, and the error grows by a pixel with every column, so the
    // columns in view stop being the ones on screen.
    logicalBorderResolves = false;
    await render(buildCsv(4, 3));

    // The border is read on the side the direction of the document puts it.
    expect(host.querySelector('col')?.getAttribute('style')).toContain('calc(4ch + 16px + 1px)');
    expect(host.querySelector('table')?.getAttribute('style')).toContain('calc(12ch + 48px + 2px)');
  });

  test('counts the border of a cell on the left in a right-to-left document', async () => {
    logicalBorderResolves = false;
    await render(buildCsv(4, 3));

    // The document turns right to left, so the border of a cell is on its
    // left edge.
    await act(async () => {
      windowInstance.document.documentElement.setAttribute('dir', 'rtl');
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(host.querySelector('col')?.getAttribute('style')).toContain('calc(4ch + 16px + 1px)');
  });

  test('stripes the rows by their index and not by their place in the document', async () => {
    // The grid of the file is too large to be kept whole, so the file is
    // windowed.
    await render(buildCsv(600, 4));

    // The window is moved over a row with an odd index, so the first row in
    // the document is an odd one.
    await scrollTo(ROW_HEIGHT * 11);

    const rows = mountedRows();
    expect(rows.length).toBeGreaterThan(1);
    // A stripe that followed the place of the row in the document would be
    // the wrong one for the first row in it.
    expect(rows[0]?.index % 2).toBe(1);
    for (const row of rows) {
      expect(stripeOf(row.element)).toBe(row.index % 2 === 0 ? 'even' : 'odd');
    }
  });

  test('keeps the border on the inline end of the columns before the last one of the file', async () => {
    // The grid of the file is too large to be kept whole, so the file is
    // windowed.
    await render(buildCsv(100, 50));

    // The window is in the middle of the file, so the last column in the
    // document is not the last column of the file.
    await scrollTo(0, 1000);

    const cells = dataCells();
    expect(cells.length).toBeGreaterThan(0);
    for (const cell of cells) {
      expect(keepsEndBorder(cell)).toBe(true);
    }
    for (const header of Array.from(host.querySelectorAll('th[scope="col"]'))) {
      expect(keepsEndBorder(header)).toBe(true);
    }
  });

  test('gives the last column of the file its missing border', async () => {
    await render(buildCsv(20, 4));

    const cells = dataCells();
    const lastColumn = cells.filter((cell) => cell.getAttribute('title')?.endsWith('c3'));
    expect(lastColumn.length).toBeGreaterThan(0);
    for (const cell of lastColumn) {
      expect(keepsEndBorder(cell)).toBe(false);
    }
    for (const cell of cells.filter((cell) => !cell.getAttribute('title')?.endsWith('c3'))) {
      expect(keepsEndBorder(cell)).toBe(true);
    }

    // The header of the last column of the file keeps the missing border as
    // well.
    const headers = Array.from(host.querySelectorAll('th[scope="col"]'));
    expect(headers).toHaveLength(4);
    expect(keepsEndBorder(headers[3])).toBe(false);
    expect(keepsEndBorder(headers[0])).toBe(true);
  });

  test('counts a character the browser lays out wider at the width the browser gives it', async () => {
    // A character the monospace font does not cover falls back to another
    // font, and that font can lay the character out wider. The preview
    // measures the character and counts the value at the width it takes
    // there, so the value is not cut short.
    characterAdvances.set('Ω', 9);
    await render(`h\n${'Ω'.repeat(10)}`);

    // Ten characters of 9 px take 90 px, which is twelve cells of 7.5 px.
    expect(host.querySelector('col')?.getAttribute('style')).toContain('12ch');
  });

  test('keeps the counted width of a character the browser lays out narrower', async () => {
    // A character that takes less room than the monospace font does keeps
    // the cell the count gives it, so the column is not padded with room
    // the text does not need.
    characterAdvances.set('Я', 7.19);
    await render(`h\n${'Я'.repeat(10)}`);

    // Ten characters still take ten cells, and not less.
    expect(host.querySelector('col')?.getAttribute('style')).toContain('10ch');
  });

  test('counts the header with the characters the browser measured', async () => {
    // A character of the header is measured like any other character, and
    // the header is as wide as the text the browser lays out for it. The
    // header is not capped, so it is as wide as it asks for.
    characterAdvances.set('Ω', 9);
    await render(`ΩΩΩΩΩ\na\n`);

    // Five characters of 9 px take 45 px, which is six cells of 7.5 px.
    expect(host.querySelector('col')?.getAttribute('style')).toContain('6ch');
  });

  test('states how many rows and columns the whole table has', async () => {
    await render(buildCsv(100, 50));

    // The rows outside the window are not in the document, so the table
    // states how many of them it has. The header row is counted with the
    // rows.
    expect(host.querySelector('table')?.getAttribute('aria-rowcount')).toBe('100');
    expect(host.querySelector('table')?.getAttribute('aria-colcount')).toBe('50');
  });

  test('counts the rows the table holds and not the rows the file has', async () => {
    // The parser keeps the first rows of the file and the meta line says
    // so. The table holds the rows it keeps.
    await render(buildCsv(2_100, 50));

    expect(host.querySelector('table')?.getAttribute('aria-rowcount')).toBe('2001');
    expect(host.querySelector('table')?.getAttribute('aria-colcount')).toBe('50');
  });

  test('gives every mounted row and cell its place in the file', async () => {
    await render(buildCsv(2_100, 50));

    const expectPlacesToBeRight = () => {
      const rows = mountedRows();
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        // The header row is the first row of the table, so the row of the
        // file is one below it.
        expect(row.element.getAttribute('aria-rowindex')).toBe(String(row.index + 2));
        for (const cell of Array.from(row.element.querySelectorAll('td[title]'))) {
          const column = columnOf(cell.getAttribute('title') ?? '');
          expect(cell.getAttribute('aria-colindex')).toBe(String(column + 1));
        }
      }
      for (const header of Array.from(host.querySelectorAll('th[scope="col"]'))) {
        const column = columnOf(header.textContent ?? '');
        expect(header.getAttribute('aria-colindex')).toBe(String(column + 1));
      }
    };

    expectPlacesToBeRight();

    // The window moves over the rows and the columns in the middle of the
    // file, and the places are the ones the file gives them.
    await scrollTo(ROW_HEIGHT * 100, 1000);
    expectPlacesToBeRight();

    // And back to the start of it.
    await scrollTo(0, 0);
    expectPlacesToBeRight();
  });

  test('keeps the spacer rows and the spacer cells out of the accessibility tree', async () => {
    await render(buildCsv(2_100, 50));
    await scrollTo(ROW_HEIGHT * 100, 1000);

    // The rows that stand for the rows outside the window.
    const spacerRows = Array.from(host.querySelectorAll('tbody tr'))
      .filter((row) => !row.querySelector('td[title]'));
    expect(spacerRows.length).toBeGreaterThan(0);
    for (const row of spacerRows) {
      expect(row.getAttribute('aria-hidden')).toBe('true');
    }

    // The cells that stand for the columns beside the window.
    const headerSpacers = Array.from(host.querySelectorAll('thead th[colspan]'));
    expect(headerSpacers.length).toBe(2);
    for (const cell of headerSpacers) {
      expect(cell.getAttribute('aria-hidden')).toBe('true');
    }

    const bodySpacers = columnSpacers();
    expect(bodySpacers.length).toBe(2);
    for (const cell of bodySpacers) {
      expect(cell.getAttribute('aria-hidden')).toBe('true');
    }
  });

  test('keeps a file whose grid is small whole', async () => {
    await render(buildCsv(20, 8));

    // Every row and every column of the file is in the document, so the
    // browser's find-in-page, a selection of the whole file and a screen
    // reader see the file.
    expect(host.querySelectorAll('th[scope="col"]').length).toBe(8);
    expect(dataCells().length).toBe(19 * 8);

    // Nothing is outside the window, so there are no spacers.
    expect(host.querySelectorAll('tbody tr[aria-hidden]').length).toBe(0);
    expect(host.querySelectorAll('td[colspan], th[colspan]').length).toBe(0);
  });

  test('windows a file whose grid is large', async () => {
    await render(buildCsv(2_100, 50));

    // The document holds the cells in view and not the cells of the file.
    expect(dataCells().length).toBeLessThan(2_000 * 50);
    expect(host.querySelectorAll('tbody tr[aria-hidden]').length).toBeGreaterThan(0);
  });

  test('keeps the same file whole in a narrow panel and in a wide panel', async () => {
    await render(buildCsv(20, 8));
    const inWidePanel = dataCells().length;

    await resize(320);

    // The decision is a property of the file, so the narrow panel holds the
    // same cells.
    expect(dataCells().length).toBe(inWidePanel);
    expect(host.querySelectorAll('th[scope="col"]').length).toBe(8);
  });
});
