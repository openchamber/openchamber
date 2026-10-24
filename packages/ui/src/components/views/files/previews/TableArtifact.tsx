import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { ArtifactMetaBar } from './ArtifactMetaBar';
import { formatArtifactSize } from './artifactMeta';
import {
  cutDelimitedRow,
  delimiterForPath,
  type DelimitedRow,
  type DelimitedTable,
} from './delimitedText';
import {
  DEFAULT_CHARACTER_WIDTHS,
  characterWidthsFrom,
  clampTableWindow,
  columnWidth,
  computeTableWindow,
  displayCells,
  holdsWholeTable,
  measureTableColumns,
  planTableColumns,
  sameCharacterWidths,
  tableSpacerSpans,
  tableWidthCss,
  type TableCellMetrics,
  type TableCharacterWidths,
  type TableColumnPlan,
  type TableColumnWidth,
  type TableColumnWidths,
  type TableDirection,
  type TableRange,
  type TableWindow,
} from './tableLayout';
import { useDelimitedTable } from './useDelimitedTable';

/**
 * A row is one line of the preview's meta type plus the cell's padding and
 * its bottom border. The real height is measured from the document; this is
 * only what the first frame plans with.
 */
const TABLE_ROW_ESTIMATE_PX = 27;
/** The rows kept mounted above and below the viewport. */
const TABLE_ROW_OVERSCAN = 6;
/** The columns kept mounted beside the viewport. */
const TABLE_COLUMN_OVERSCAN = 2;
/** The characters the measuring probe draws. */
const PROBE_CHARACTER_COUNT = 256;
const PROBE_TEXT = '0'.repeat(PROBE_CHARACTER_COUNT);
/** The character the row probe draws, to give it a line of its own. */
const PROBE_ROW_TEXT = '0';

/**
 * The cells the cache of the cut rows holds beside the rows on screen.
 *
 * The rows that are on screen are held whatever they cost, because they are
 * the ones the preview draws. The rows beside them are held as long as the
 * cache holds fewer cells than this, so a scroll that comes back over a row
 * does not cut it again, and a file with many columns does not put millions
 * of strings in the cache.
 */
const TABLE_ROW_CACHE_CELL_LIMIT = 2_000;

/**
 * The inline padding of a cell.
 *
 * The measuring probe is read for the padding and the border of a cell, so
 * the probe and the cell carry the same classes. A change to the padding of
 * a cell changes the measurement with it, and the width the browser is given
 * and the width the model reasons about move together.
 */
const CELL_PADDING_CLASS = 'px-2';
/**
 * The border on the inline end of a cell. The last column of the table does
 * not have it, and the probe carries it so the measurement counts the border
 * the cells really have.
 */
const CELL_END_BORDER_CLASS = 'border-e';

/**
 * The border of a spacer cell.
 *
 * A spacer stands for the columns beside the window, and it carries the
 * border a cell of the table carries, so the rule under a row runs across
 * the whole width of the table and not only across the columns that are in
 * view. The spacer that stands for the columns before the window is an
 * interior boundary and keeps the border on its inline end, and the spacer
 * at the end of the file is the table's own last column and keeps the
 * missing border.
 *
 * A range of columns that is wider than a cell may span is carried by more
 * than one cell, and only the last of them ends at the boundary of the
 * window, so only it keeps the border on its inline end. The cells before it
 * end in the middle of the range and have no boundary to mark.
 */
const spacerClassName = (borderClass: string): string => `border-b ${borderClass}`;
const leadingSpacerClassName = (borderClass: string): string => (
  `${spacerClassName(borderClass)} ${CELL_END_BORDER_CLASS}`
);

/**
 * What the preview assumes before the browser has measured the font. The
 * column widths are written in the font's own unit, so these numbers only
 * decide which cells are mounted, and a wrong guess costs a little scroll
 * accuracy rather than a wrong layout.
 */
const FALLBACK_METRICS: TableCellMetrics = {
  charWidth: 7.5,
  cellPadding: 16,
  cellBorder: 1,
  maxCellWidth: 512,
};

type TableLayout = {
  /** What one character and one cell cost, measured from the document. */
  metrics: TableCellMetrics;
  /** What the characters outside latin cost, measured from the document. */
  characterWidths: TableCharacterWidths;
  /** The scroll box's inner size. */
  viewportWidth: number;
  viewportHeight: number;
  /** The measured height of a row, which every row is given. */
  rowHeight: number;
  /** The direction the table is laid out in. */
  direction: TableDirection;
};

const INITIAL_LAYOUT: TableLayout = {
  metrics: FALLBACK_METRICS,
  characterWidths: DEFAULT_CHARACTER_WIDTHS,
  viewportWidth: 0,
  viewportHeight: 0,
  rowHeight: TABLE_ROW_ESTIMATE_PX,
  direction: 'ltr',
};

const sameMetrics = (current: TableCellMetrics, next: TableCellMetrics): boolean => (
  current.charWidth === next.charWidth
  && current.cellPadding === next.cellPadding
  && current.cellBorder === next.cellBorder
  && current.maxCellWidth === next.maxCellWidth
);

const sameLayout = (current: TableLayout, next: TableLayout): boolean => (
  sameMetrics(current.metrics, next.metrics)
  && sameCharacterWidths(current.characterWidths, next.characterWidths)
  && current.viewportWidth === next.viewportWidth
  && current.viewportHeight === next.viewportHeight
  && current.rowHeight === next.rowHeight
  && current.direction === next.direction
);

const toPixels = (value: string): number => {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

/** The computed style of the probe, as far as the border of a cell is read. */
type ProbeBorderStyle = Pick<
  CSSStyleDeclaration,
  'borderInlineEndWidth' | 'borderLeftWidth' | 'borderRightWidth'
>;

/**
 * The width of the border on the inline end of a cell.
 *
 * The computed style resolves the logical side of the border in a runtime
 * that knows the property, and the border is read there. A runtime that does
 * not resolve it counts no border at all, and the error grows by a pixel
 * with every column, so the physical side the direction of the document puts
 * the border on is read as well.
 */
const inlineEndBorder = (style: ProbeBorderStyle, direction: TableDirection): number => {
  const logical = toPixels(style.borderInlineEndWidth);
  if (logical > 0) return logical;
  return toPixels(direction === 'rtl' ? style.borderLeftWidth : style.borderRightWidth);
};

/**
 * The width of the characters outside latin, from the boxes the browser gives them.
 *
 * Every character of the file that is not latin is drawn on its own in the
 * probe, so the browser reports the width it takes in the font it has. A
 * character that falls back to another font and is wider than the monospace
 * font of the preview is counted at the width it takes there, and a value in
 * that script is as wide as the text the browser lays out.
 */
const measureCharacterWidths = (
  probe: HTMLElement | null,
  codePoints: ReadonlyArray<number>,
  charWidth: number,
): TableCharacterWidths => {
  if (!probe || charWidth <= 0 || codePoints.length === 0) return DEFAULT_CHARACTER_WIDTHS;
  const spans = probe.querySelectorAll('span');
  const advances = new Map<number, number>();
  for (let index = 0; index < codePoints.length; index += 1) {
    const span = spans.item(index);
    if (!span) break;
    advances.set(codePoints[index], span.getBoundingClientRect().width);
  }
  return characterWidthsFrom(advances, charWidth);
};

/**
 * The width of the values of a table, in character cells.
 *
 * The header's values and the body's values are counted apart, because the
 * header is never capped and the body is.
 */
type TableCellWidths = {
  /** The width of every header value, in character cells. */
  headerCells: number[];
  /** The width of the widest kept value of every column, in character cells. */
  bodyCells: number[];
};

/**
 * The rows of a file, cut out of its source when they are needed.
 *
 * The preview reads the file in one place: the rows that are cut out of the
 * source and the cache that holds them come from here, so the rest of the
 * preview never walks over the cells of the file.
 *
 * The cache holds the rows that are on screen, and they are held whatever
 * they cost: they are the ones the preview draws, and a bound by the cells
 * the cache holds kept one row of a file with 5,000 columns, so every change
 * of the window cut all the rows on screen again. The rows beside them are
 * held as long as the cache holds fewer cells than the budget, so a scroll
 * that comes back over a row finds it, and the memory the cache holds does
 * not grow with the number of rows of the file.
 */
type TableSource = {
  /** The values of a row, cut out of the source the first time it is asked for. */
  values(row: number): string[];
  /** Keep the rows that are on screen and drop the ones that are not. */
  keepRows(range: TableRange): void;
};

/**
 * The rows of a file, cut out of its source when they are needed.
 *
 * A row is cut out of the source when it is mounted, and a row that was cut
 * is not cut again, so a scroll that comes back over a row does not pay for
 * it twice.
 */
const createTableSource = (
  content: string,
  delimiter: ',' | '\t',
  rows: readonly DelimitedRow[],
): TableSource => {
  /** The rows that were cut out of the source, by the row they belong to. */
  const cutRows = new Map<number, string[]>();
  /** The number of cells the cut rows hold. */
  let cutCells = 0;
  /** The rows that are on screen. */
  let windowRange: TableRange = { start: 0, end: 0 };

  const values = (row: number): string[] => {
    const held = cutRows.get(row);
    if (held) return held;
    const span = rows[row];
    if (!span) return [];
    const cut = cutDelimitedRow(content, span, delimiter);
    cutRows.set(row, cut);
    cutCells += cut.length;
    return cut;
  };

  /**
   * Drop the rows that are not on screen when the cache holds more cells
   * than the budget.
   */
  const prune = (): void => {
    while (cutCells > TABLE_ROW_CACHE_CELL_LIMIT) {
      let dropped = false;
      for (const row of cutRows.keys()) {
        if (row >= windowRange.start && row < windowRange.end) continue;
        const cut = cutRows.get(row);
        cutRows.delete(row);
        cutCells -= cut ? cut.length : 0;
        dropped = true;
        break;
      }
      // Only the rows that are on screen are left, and they are held.
      if (!dropped) return;
    }
  };

  /**
   * Keep the rows that are on screen and drop the ones that are not, as far
   * as the budget allows.
   */
  const keepRows = (range: TableRange): void => {
    windowRange = range;
    prune();
  };

  return { values, keepRows };
};

/**
 * CSV/TSV as a grid: a sticky header row, monospace cells, and a hard cap on
 * rows so a large export renders at all. The cap is stated in the meta line,
 * not hidden, because "2,000 rows" and "the first 2,000 rows" mean different
 * things to someone checking a result.
 *
 * A wide export holds far more cells than a screen can show, and mounting
 * all of them froze the viewer for seconds, so only the rows and the columns
 * in view are in the document. The skipped ones are carried by spacer rows
 * and spacer cells, which keeps the table's own layout, its column widths
 * and its text selection intact.
 *
 * A file whose grid is small enough is kept whole, so the document holds
 * every cell of it and the browser's find-in-page, a selection of the whole
 * file and a screen reader see the file and not the window.
 */
export const TableArtifact: React.FC<{
  path: string;
  content: string;
  sizeBytes: number | null;
}> = ({ path, content, sizeBytes }) => {
  const { t } = useI18n();
  const delimiter = delimiterForPath(path);
  // The parse of the file runs in a worker, so the main thread is free while
  // a wide export is read. The worker answers with the table, and the
  // preview only renders what it sends back.
  const delimited = useDelimitedTable(content, delimiter);

  if (delimited.table === null) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <ArtifactMetaBar items={[formatArtifactSize(sizeBytes)]} />
        <div className="flex items-center gap-2 p-3 typography-ui text-muted-foreground">
          <Icon name="loader-4" className="size-4 animate-spin" />
          {t('common.loading')}
        </div>
      </div>
    );
  }

  return (
    <TableView
      table={delimited.table}
      bodyCells={delimited.bodyCells}
      countBodyCells={delimited.countBodyCells}
      content={content}
      delimiter={delimiter}
      sizeBytes={sizeBytes}
    />
  );
};

/**
 * The table of a file, and the window of it that is on screen.
 */
const TableView: React.FC<{
  table: DelimitedTable;
  bodyCells: number[];
  countBodyCells: (characterWidths: TableCharacterWidths) => void;
  content: string;
  delimiter: ',' | '\t';
  sizeBytes: number | null;
}> = ({ table, bodyCells, countBodyCells, content, delimiter, sizeBytes }) => {
  const { t } = useI18n();
  // The rows of the file are cut out of the source when they are needed, and
  // the cache that holds them is bounded by the window.
  const source = React.useMemo(
    () => createTableSource(content, delimiter, table.rows),
    [content, delimiter, table.rows],
  );
  // Whether the whole grid of the file is small enough to be kept in the
  // document. It is a property of the file, so the same file is kept whole
  // in a narrow panel and in a wide one.
  const holdsWholeGrid = holdsWholeTable(table.rows.length, table.columnCount);
  // The characters outside latin are the ones the browser has to measure,
  // because the font it falls back to can lay them out wider than the
  // monospace font of the preview. The parser finds them in the same walk
  // that counts the widths, so the preview never walks over the text of the
  // file to find them.
  const codePoints = table.codePoints;
  const summary = table.totalRows === 1
    ? t('filesView.artifact.table.rowsSingle', { rows: table.totalRows, columns: table.columnCount })
    : t('filesView.artifact.table.rowsPlural', { rows: table.totalRows, columns: table.columnCount });

  const scrollerRef = React.useRef<HTMLDivElement | null>(null);
  const probeRef = React.useRef<HTMLSpanElement | null>(null);
  const probeTextRef = React.useRef<HTMLSpanElement | null>(null);
  const probeRowRef = React.useRef<HTMLSpanElement | null>(null);
  const characterProbeRef = React.useRef<HTMLSpanElement | null>(null);
  const offsetsRef = React.useRef({ top: 0, left: 0 });

  const [layout, setLayout] = React.useState<TableLayout>(INITIAL_LAYOUT);
  // The first frame keeps one row and one column in the document, so the
  // preview has something to show while it measures.
  const [visible, setVisible] = React.useState<TableWindow>({
    rows: { start: 0, end: 1 },
    columns: { start: 0, end: 1 },
  });

  // The width every column asks for comes from the data and the
  // measurements, so it is measured again when one of them changes and not
  // for a resize of the panel. The room the panel has is shared out over
  // those widths afterwards, and only that part is repeated when the panel
  // is resized.
  //
  // The values of the file are counted with the characters the browser
  // measured, and the count of the body is repeated only when the measured
  // table changes. A resize of the panel, a scroll and a render that changes
  // nothing leave it where it is.
  const cellWidths = React.useMemo<TableCellWidths>(() => ({
    // The header's values are counted here, because the parser leaves them
    // out of the body: they are not part of it and the cap on a cell does
    // not reach them.
    headerCells: table.header.map((value) => displayCells(value, layout.characterWidths)),
    // The widths of the body are the ones the parser counted, and they are
    // counted again with the measured characters when a character is wider
    // than the count gives it. A file whose characters are all counted right
    // is not counted again at all.
    bodyCells,
  }), [bodyCells, layout.characterWidths, table.header]);
  const widths = React.useMemo<TableColumnWidths>(
    () => measureTableColumns(
      cellWidths.headerCells,
      cellWidths.bodyCells,
      table.columnCount,
      layout.metrics,
    ),
    [cellWidths, layout.metrics, table.columnCount],
  );
  const plan = React.useMemo<TableColumnPlan>(
    () => planTableColumns(widths, layout.metrics, layout.viewportWidth),
    [layout.metrics, layout.viewportWidth, widths],
  );
  // The columns are written with the widths they asked for, which do not
  // change when the panel is resized, so the colgroup is not rebuilt either.
  const colgroup = React.useMemo(
    () => (
      <colgroup>
        {widths.cells.map((cells, column) => {
          const width: TableColumnWidth = columnWidth(cells, layout.metrics, column === table.columnCount - 1);
          return (
            <col
              key={column}
              style={{ width: width.css }}
            />
          );
        })}
      </colgroup>
    ),
    [layout.metrics, table.columnCount, widths.cells],
  );

  // The model the window is computed from. It is written after the commit
  // and not during the render, so it always holds a render that reached the
  // document: a render React throws away leaves the model of the commit
  // before it in place, and the window a scroll event asks for is then the
  // one of what is on screen.
  const modelRef = React.useRef({
    plan,
    layout,
    rowCount: table.rows.length,
    columnCount: table.columnCount,
    holdsWholeGrid,
  });

  const applyWindow = React.useCallback(() => {
    const model = modelRef.current;
    // A file whose grid is kept whole has every cell of it in the document,
    // so there is no window to move.
    if (model.holdsWholeGrid) return;
    const offsets = offsetsRef.current;
    const next = computeTableWindow({
      plan: model.plan,
      viewportWidth: model.layout.viewportWidth,
      viewportHeight: model.layout.viewportHeight,
      // The sticky header is one row tall: the header row is given the height
      // of a row, so the cells that are in view cannot change it.
      headerHeight: model.layout.rowHeight,
      rowHeight: model.layout.rowHeight,
      rowCount: model.rowCount,
      columnCount: model.columnCount,
      rowOverscan: TABLE_ROW_OVERSCAN,
      columnOverscan: TABLE_COLUMN_OVERSCAN,
      direction: model.layout.direction,
    }, offsets.top, offsets.left);
    setVisible((current) => (
      current.rows.start === next.rows.start
        && current.rows.end === next.rows.end
        && current.columns.start === next.columns.start
        && current.columns.end === next.columns.end
        ? current
        : next
    ));
  }, []);

  const handleScroll = React.useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    offsetsRef.current = { top: scroller.scrollTop, left: scroller.scrollLeft };
    applyWindow();
  }, [applyWindow]);

  // The font, the cell's own padding, the row height and the scroll box are
  // all read back from the document, because the interface size, the theme
  // and the platform's font all decide them.
  //
  // The effect runs for every file, and the file is what it waits for: the
  // probe is only in the document while the file has rows, so a file that
  // opens without rows leaves the preview unmeasured, and the next file has
  // to be measured afresh. The observers are made for the probe that is in
  // the document at that moment.
  React.useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    const probe = probeRef.current;
    const probeText = probeTextRef.current;
    const probeRow = probeRowRef.current;
    const characterProbe = characterProbeRef.current;
    if (!scroller || !probe || !probeText || !probeRow || !characterProbe) return;

    const measure = () => {
      const style = getComputedStyle(probe);
      const charWidth = probeText.getBoundingClientRect().width / PROBE_CHARACTER_COUNT;
      // The border sits on the inline end of the cell, which is the left edge
      // of the document in a right-to-left one.
      const cellPadding = toPixels(style.paddingLeft) + toPixels(style.paddingRight);
      const direction = style.direction === 'rtl' ? 'rtl' : 'ltr';
      const cellBorder = inlineEndBorder(style, direction);
      const maxCellWidth = toPixels(style.maxWidth);
      // The height of a row with text. Every row is given this height, so
      // one measurement is the height of all of them, the header row
      // included.
      const rowHeight = probeRow.getBoundingClientRect().height;
      // The width the characters outside latin take, which the browser
      // reports for the font it has.
      const measuredWidths = measureCharacterWidths(characterProbe, codePoints, charWidth);
      // The scroll position follows the direction of the document, so it is
      // read with the rest of the layout and not only on a scroll.
      offsetsRef.current = { top: scroller.scrollTop, left: scroller.scrollLeft };
      setLayout((current) => {
        const measured = charWidth > 0 && cellPadding > 0 && maxCellWidth > 0
          ? { charWidth, cellPadding, cellBorder, maxCellWidth }
          : current.metrics;
        const next: TableLayout = {
          // The measurements keep the object they have while their values stay
          // the same. The widths of the columns are measured from them, and a
          // new object for the same numbers would ask for the walk over the
          // cells of the file again on every resize of the panel.
          metrics: sameMetrics(current.metrics, measured) ? current.metrics : measured,
          characterWidths: sameCharacterWidths(current.characterWidths, measuredWidths)
            ? current.characterWidths
            : measuredWidths,
          viewportWidth: scroller.clientWidth,
          viewportHeight: scroller.clientHeight,
          rowHeight: rowHeight > 0 ? rowHeight : current.rowHeight,
          direction,
        };
        return sameLayout(current, next) ? current : next;
      });
      // The widths of the columns are counted again with the characters the
      // browser measured, and the count runs in the worker. A file whose
      // characters are all counted right is not counted again at all.
      countBodyCells(measuredWidths);
    };

    measure();
    const observers: { disconnect: () => void }[] = [];
    const ResizeObserverCtor = globalThis.ResizeObserver;
    if (ResizeObserverCtor) {
      const observer = new ResizeObserverCtor(measure);
      observer.observe(scroller);
      // The probe's text is what changes when the font or the interface size
      // changes, and the row height follows it.
      observer.observe(probeText);
      observers.push(observer);
    }
    // The direction of the document decides which columns are on screen, and
    // the application sets it on the root element when the language changes.
    // Nothing about the preview's size changes with it, so the attribute is
    // watched for it. The interface size is not watched here: the app writes
    // to the root element's style on every sidebar drag, and the probe's
    // own text tells the observer about the font anyway.
    const MutationObserverCtor = globalThis.MutationObserver;
    if (MutationObserverCtor) {
      const observer = new MutationObserverCtor(measure);
      observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['dir'],
      });
      observers.push(observer);
    }
    return () => {
      for (const observer of observers) observer.disconnect();
    };
  }, [codePoints, countBodyCells, table]);

  // A new file, a new size or a new measurement moves the window. It runs
  // before the paint, so the table never shows a half-filled window.
  React.useLayoutEffect(() => {
    // The model is written here and not during the render: a render React
    // throws away must not leave a plan in it that was never in the
    // document, and a scroll event reads this model.
    modelRef.current = {
      plan,
      layout,
      rowCount: table.rows.length,
      columnCount: table.columnCount,
      holdsWholeGrid,
    };
    applyWindow();
  }, [applyWindow, holdsWholeGrid, layout, plan, table]);

  // The window of the file that was open before names the rows and the
  // columns of that file, and it is held inside the file that is open now
  // before anything is mounted. The first commit of a new file then carries
  // the new file's own rows and columns.
  //
  // A file whose grid is small enough is kept whole: every row and every
  // column of it is in the document, so the browser's find-in-page, a
  // selection of the whole file and a screen reader see the file and not the
  // window. The decision is a property of the file, so it does not change
  // with the size of the panel.
  const mountedWindow: TableWindow = holdsWholeGrid
    ? { rows: { start: 0, end: table.rows.length }, columns: { start: 0, end: table.columnCount } }
    : clampTableWindow(visible, table.columnCount, table.rows.length);

  // The cache holds the rows that are on screen and drops the rows that
  // leave the screen, so a scroll or a render does not cut a row that was
  // cut already. It runs after the commit, because the rows of the window
  // are cut during the render.
  React.useLayoutEffect(() => {
    source.keepRows(mountedWindow.rows);
  }, [mountedWindow.rows, source]);

  const visibleColumns: number[] = [];
  for (let column = mountedWindow.columns.start; column < mountedWindow.columns.end; column += 1) {
    visibleColumns.push(column);
  }
  const visibleRows: number[] = [];
  for (let row = mountedWindow.rows.start; row < mountedWindow.rows.end; row += 1) {
    visibleRows.push(row);
  }
  // The cells that carry the columns beside the window. A range of columns
  // that is wider than a cell may span is carried by more than one cell, so
  // that the browser lays the cells of the window out over the columns the
  // model names.
  const leadingSpans = tableSpacerSpans(mountedWindow.columns.start);
  const trailingSpans = tableSpacerSpans(table.columnCount - mountedWindow.columns.end);
  // The cells that carry the rows outside the window. They hold no text, no
  // padding and no border, so they add nothing to the height of their row,
  // which is written on the row itself. A range of columns that is wider
  // than a cell may span is carried by more than one cell here as well, so
  // that no cell of the table claims a span the browser cannot lay out.
  const rowSpans = tableSpacerSpans(table.columnCount);

  const headerClassName = (column: number): string => cn(
    `whitespace-nowrap border-b ${CELL_END_BORDER_CLASS} border-border/40 ${CELL_PADDING_CLASS} py-1 text-start font-medium text-foreground`,
    column === table.columnCount - 1 && 'border-e-0',
  );
  const cellClassName = (column: number): string => cn(
    `max-w-[32rem] truncate border-b ${CELL_END_BORDER_CLASS} border-border/30 ${CELL_PADDING_CLASS} py-1 align-top text-foreground`,
    column === table.columnCount - 1 && 'border-e-0',
  );
  const rowClassName = (row: number): string => (
    row % 2 === 0 ? 'bg-[var(--surface-background)]' : 'bg-[var(--surface-subtle)]/40'
  );

  // The probe that holds the characters outside latin, one in a box of its
  // own, so the browser reports the width each of them takes in the font it
  // has. The probe is built once for the file, so a scroll does not walk
  // over the characters again.
  const characterProbe = React.useMemo(
    () => (
      <span
        ref={characterProbeRef}
        aria-hidden="true"
        className="pointer-events-none invisible absolute h-0 w-0 overflow-hidden font-mono typography-meta"
      >
        {codePoints.map((codePoint, index) => (
          <span key={index} className="inline-block whitespace-pre">{String.fromCodePoint(codePoint)}</span>
        ))}
      </span>
    ),
    [codePoints],
  );

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <ArtifactMetaBar
        items={[
          summary,
          table.truncated ? t('filesView.artifact.table.truncated', { shown: table.rows.length, total: table.totalRows }) : '',
          formatArtifactSize(sizeBytes),
        ]}
      />
      {table.columnCount === 0 ? (
        <div className="p-3 typography-ui text-muted-foreground">{t('filesView.artifact.table.empty')}</div>
      ) : (
        <>
          <span
            ref={probeRef}
            aria-hidden="true"
            className={`pointer-events-none invisible absolute h-0 w-0 overflow-hidden ${CELL_END_BORDER_CLASS} border-border/30 ${CELL_PADDING_CLASS} font-mono typography-meta max-w-[32rem]`}
          >
            {/* The probe's text is a box of its own: an inline box has no
                content box, so the browser reports an empty one for it and
                the observer never sees the font change. */}
            <span ref={probeTextRef} className="inline-block whitespace-pre">{PROBE_TEXT}</span>
            {/* The box a cell holds, with a character in it, so the height of
                a row with text can be read from it. */}
            <span
              ref={probeRowRef}
              className={`inline-block whitespace-nowrap border-b border-border/30 ${CELL_PADDING_CLASS} py-1`}
            >
              {PROBE_ROW_TEXT}
            </span>
          </span>
          {characterProbe}
          <div ref={scrollerRef} onScroll={handleScroll} className="min-h-0 flex-1 overflow-auto">
            <table
              // The rows and the columns outside the window are not in the
              // document, so the table states how many of them it has, the
              // header row counted with the rows.
              aria-colcount={table.columnCount}
              aria-rowcount={table.rows.length + 1}
              className="min-w-full border-separate border-spacing-0 font-mono typography-meta"
              style={{
                tableLayout: 'fixed',
                width: tableWidthCss(plan.totalCells, table.columnCount, layout.metrics),
              }}
            >
              {colgroup}
              <thead className="sticky top-0 z-10 bg-[var(--surface-subtle)]">
                {/* The header row is given the height of a row, so the cells
                    that happen to be in view cannot change it. A header cell
                    without text has no line in it, and a header row that
                    takes its height from the cells in view collapses to the
                    padding and the border while the window moves over it. */}
                <tr aria-rowindex={1} style={{ height: layout.rowHeight }}>
                  {leadingSpans.map((span, index) => (
                    <th
                      key={`leading-${index}`}
                      colSpan={span}
                      aria-hidden="true"
                      className={index === leadingSpans.length - 1
                        ? leadingSpacerClassName('border-border/40')
                        : spacerClassName('border-border/40')}
                    />
                  ))}
                  {visibleColumns.map((column) => (
                    <th
                      key={column}
                      scope="col"
                      aria-colindex={column + 1}
                      className={headerClassName(column)}
                    >
                      {table.header[column] ?? ''}
                    </th>
                  ))}
                  {trailingSpans.map((span, index) => (
                    <th
                      key={`trailing-${index}`}
                      colSpan={span}
                      aria-hidden="true"
                      className={spacerClassName('border-border/40')}
                    />
                  ))}
                </tr>
              </thead>
              <tbody>
                {mountedWindow.rows.start > 0 && (
                  // The height of a spacer row is written on the row: a
                  // cell's own padding would make the cell taller than the
                  // height it asks for, and the rows would sit lower than
                  // the model says. The cells hold no text, so they add
                  // nothing to that height.
                  <tr aria-hidden="true" style={{ height: mountedWindow.rows.start * layout.rowHeight }}>
                    {rowSpans.map((span, index) => (
                      <td key={`rows-above-${index}`} colSpan={span} />
                    ))}
                  </tr>
                )}
                {visibleRows.map((row) => {
                  // The values of a row are cut out of the source when the
                  // row is mounted, and a row that was cut is not cut again.
                  const values = source.values(row);
                  // Every row is the height the document reports, so a row
                  // without text is as tall as a row with text and the
                  // mapping from a scroll offset to a row stays exact.
                  return (
                    <tr
                      key={row}
                      // The row of the file, the header row counted with the
                      // rows before it.
                      aria-rowindex={row + 2}
                      className={rowClassName(row)}
                      style={{ height: layout.rowHeight }}
                    >
                      {leadingSpans.map((span, index) => (
                        <td
                          key={`leading-${index}`}
                          colSpan={span}
                          aria-hidden="true"
                          className={index === leadingSpans.length - 1
                            ? leadingSpacerClassName('border-border/30')
                            : spacerClassName('border-border/30')}
                        />
                      ))}
                      {visibleColumns.map((column) => {
                        const value = values[column] ?? '';
                        return (
                          <td
                            key={column}
                            aria-colindex={column + 1}
                            className={cellClassName(column)}
                            title={value}
                          >
                            {value}
                          </td>
                        );
                      })}
                      {trailingSpans.map((span, index) => (
                        <td
                          key={`trailing-${index}`}
                          colSpan={span}
                          aria-hidden="true"
                          className={spacerClassName('border-border/30')}
                        />
                      ))}
                    </tr>
                  );
                })}
                {mountedWindow.rows.end < table.rows.length && (
                  <tr
                    aria-hidden="true"
                    style={{ height: (table.rows.length - mountedWindow.rows.end) * layout.rowHeight }}
                  >
                    {rowSpans.map((span, index) => (
                      <td key={`rows-below-${index}`} colSpan={span} />
                    ))}
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
};
