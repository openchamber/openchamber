import React from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';

import { UiBlock } from '@/components/chat/uiBlocks/UiBlock';
import { QuoteCommentMenu } from '@/components/comments/QuoteCommentMenu';
import { Icon } from '@/components/icon/Icon';
import { PRESSED_CLASS } from '@/components/ui/action-toolbar';
import { Button } from '@/components/ui/button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { Input } from '@/components/ui/input';
import { ColumnResizeHandle } from '@/components/ui/ColumnResizeHandle';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { copyTextToClipboard } from '@/lib/clipboard';
import { loadColumnWidths, saveColumnWidths, type ColumnWidths } from '@/lib/columnWidthMemory';
import { isRightToLeft, useI18n } from '@/lib/i18n';
import { openExternalUrl } from '@/lib/url';
import { cn } from '@/lib/utils';
import { ArtifactMetaBar } from './ArtifactMetaBar';
import { formatArtifactSize } from './artifactMeta';
import { delimiterForPath, parseDelimitedText, setDelimitedField, shiftDelimitedColumn, shiftDelimitedRow } from './delimitedText';
import { columnName } from '@/sync/document-attachments';
import { markSeen, noteOwnEdit, traceChanges } from './cellTraces';
import { chartProgram } from './tableChart';
import { cellParts, fromTsv, selectionSummary, sortedRowOrder, toTsv, type SortDirection } from './tableCells';

const ROW_HEIGHT_ESTIMATE = 25;
const MIN_COLUMN_CHARS = 4;
const MAX_COLUMN_CHARS = 64;
const MAX_UNDO = 100;
const MAX_PASTE_COLUMN = 256;
const MAX_FILTER_VALUES = 500;

/**
 * Column widths from the longest value in each column, in `ch` of the
 * monospace cell font. Only the visible rows are in the DOM, so an automatic
 * table layout would resize the columns on every scroll step.
 */
const measureColumnChars = (header: string[], rows: string[][], columnCount: number): number[] => {
  const widths = Array.from({ length: columnCount }, (_, column) => (header[column] ?? '').length);
  for (const row of rows) {
    for (let column = 0; column < row.length; column += 1) {
      const length = row[column]?.length ?? 0;
      if (length > widths[column]) widths[column] = length;
    }
  }
  return widths.map((width) => Math.min(MAX_COLUMN_CHARS, Math.max(MIN_COLUMN_CHARS, width)));
};

type CellText = { row: number; column: number; input: string };

export type TableEditing = {
  /** `row` is an index into the grid's rows, or -1 for the heading. A row past the end is one to add. */
  canEdit: (row: number, column: number) => boolean;
  inputOf: (row: number, column: number) => string;
  /** One undo step, however many cells it covers. */
  commit: (cells: CellText[]) => void;
  undo: () => void;
  redo: () => void;
  /** Rows and columns as a whole; absent where they cannot move. Rows are grid rows, each change is one undo step. */
  structure?: TableStructure;
};

export type TableStructure = {
  insertRow: (row: number) => void;
  deleteRow: (row: number) => void;
  insertColumn: (column: number) => void;
  deleteColumn: (column: number) => void;
};

type CellPosition = { row: number; column: number };
type Editor = CellPosition & { draft: string };

const CellText: React.FC<{ text: string; href?: string }> = ({ text, href }) => {
  const parts = cellParts(text, href);
  if (parts.every((part) => !part.href)) return text;
  return parts.map((part, index) => (part.href ? (
    <a
      key={index}
      href={part.href}
      className="text-[var(--primary-base)] underline underline-offset-2"
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (part.href) void openExternalUrl(part.href);
      }}
    >
      {part.text}
    </a>
  ) : part.text));
};

const CellEditor: React.FC<{
  value: string;
  onChange: (value: string) => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onBlur: () => void;
  label: string;
}> = ({ value, onChange, onKeyDown, onBlur, label }) => {
  const ref = React.useRef<HTMLTextAreaElement>(null);
  React.useLayoutEffect(() => {
    const field = ref.current;
    if (!field) return;
    field.focus();
    field.setSelectionRange(field.value.length, field.value.length);
  }, []);
  return (
    <textarea
      ref={ref}
      rows={1}
      aria-label={label}
      dir="auto"
      value={value}
      className="block w-full resize-none overflow-hidden bg-transparent font-mono text-foreground outline-none"
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={onKeyDown}
      onBlur={onBlur}
    />
  );
};

/**
 * A table as a grid: a sticky header row and monospace cells. Only the rows in
 * view are rendered: a wide export at the row cap is hundreds of thousands of
 * cells, which froze the app when they all went into the DOM at once.
 *
 * Sorting changes the view only, and the order stays put while cells change, so
 * a row never jumps out from under the edit that was just made.
 */
export const TableGrid: React.FC<{
  /** Names the table in the column width memory. */
  tableId: string;
  header: string[];
  rows: string[][];
  /** Row numbers in the file, drawn as a column that stays beside the data. */
  rowLabels?: Array<string | number>;
  columnCount: number;
  /** Columns with data, for the meta line; the grid may hold a spare one. */
  dataColumnCount?: number;
  totalRows: number;
  sizeBytes: number | null;
  /** Rows that stay on top of a sort: a sheet's own headings. */
  pinnedRows?: number;
  hrefOf?: (row: number, column: number) => string | undefined;
  editing?: TableEditing;
  /** The selected cell in the meta line: its reference and formula. */
  describeCell?: (row: number, column: number) => string;
  /** The file a comment on a selection names, and the sheet inside it. Absent, the grid takes no comments. */
  commentTarget?: { fileLabel: string; place?: string };
  /** Cells changed from outside and not looked at yet, as `row:column`; selecting one clears it. */
  changedCells?: ReadonlySet<string>;
  onSeen?: (keys: string[]) => void;
  /** Save state and other facts for the meta line. */
  status?: string;
  actions?: React.ReactNode;
}> = ({ tableId, header, rows, rowLabels, columnCount, dataColumnCount = columnCount, totalRows, sizeBytes, pinnedRows = 0, hrefOf, editing, describeCell, commentTarget, changedCells, onSeen, status, actions }) => {
  const { t } = useI18n();
  const columnChars = React.useMemo(
    () => measureColumnChars(header, rows, columnCount),
    [header, rows, columnCount],
  );
  const [widths, setWidths] = React.useState<ColumnWidths>(() => loadColumnWidths(tableId));
  const [dragged, setDragged] = React.useState<{ column: number; width: number } | null>(null);
  const shownWidths = dragged ? { ...widths, [dragged.column]: dragged.width } : widths;
  const storeWidths = (next: ColumnWidths) => {
    setWidths(next);
    setDragged(null);
    saveColumnWidths(tableId, next);
  };
  const columnWidth = (column: number): string => {
    const width = shownWidths[column];
    return width ? `${width}px` : `calc(${columnChars[column]}ch + 1rem + 1px)`;
  };
  const gutterChars = rowLabels ? Math.max(3, String(rowLabels[rowLabels.length - 1] ?? '').length) : 0;
  const gutterWidth = rowLabels ? `calc(${gutterChars}ch + 1rem + 1px)` : '';
  const tableWidth = `calc(${[...(rowLabels ? [gutterWidth] : []), ...columnChars.map((_, column) => columnWidth(column))].join(' + ') || '0px'})`;

  const [sort, setSort] = React.useState<{ column: number; direction: SortDirection } | null>(null);
  const [order, setOrder] = React.useState<number[] | null>(null);
  const [searchOpen, setSearchOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const [valueFilters, setValueFilters] = React.useState<ReadonlyMap<number, ReadonlySet<string>>>(() => new Map());
  const [frozenColumns, setFrozenColumns] = React.useState(0);
  const viewRows = React.useMemo(() => {
    // A row added after sorting joins the end.
    const ordered = order
      ? [...order.filter((row) => row < rows.length), ...Array.from({ length: Math.max(0, rows.length - order.length) }, (_, index) => order.length + index)]
      : Array.from({ length: rows.length }, (_, index) => index);
    const needle = query.trim().toLocaleLowerCase();
    if (!needle && valueFilters.size === 0) return ordered;
    return ordered.filter((rowIndex) => {
      if (rowIndex < pinnedRows) return true;
      const row = rows[rowIndex] ?? [];
      if (needle && !row.some((value) => value.toLocaleLowerCase().includes(needle))) return false;
      for (const [column, hidden] of valueFilters) if (hidden.has(row[column] ?? '')) return false;
      return true;
    });
  }, [order, rows, query, valueFilters, pinnedRows]);
  const bodyRows = React.useMemo(() => viewRows.slice(pinnedRows), [viewRows, pinnedRows]);
  const isFiltered = viewRows.length < rows.length;
  const columnValues = (column: number): string[] => Array.from(new Set(rows.slice(pinnedRows).map((row) => row[column] ?? '')))
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }))
    .slice(0, MAX_FILTER_VALUES);
  const toggleValue = (column: number, value: string) => {
    setValueFilters((current) => {
      const next = new Map(current);
      const hidden = new Set(current.get(column));
      if (hidden.has(value)) hidden.delete(value);
      else hidden.add(value);
      if (hidden.size === 0) next.delete(column);
      else next.set(column, hidden);
      return next;
    });
  };
  const clearFilter = (column: number) => {
    setValueFilters((current) => {
      const next = new Map(current);
      next.delete(column);
      return next;
    });
  };
  // Frozen columns stay beside the row numbers, each after the widths before it.
  const frozenStart = (column: number): string => `calc(${[...(rowLabels ? [gutterWidth] : []), ...Array.from({ length: column }, (_, index) => columnWidth(index)), '0px'].join(' + ')})`;
  const toggleSort = (column: number) => {
    if (sort?.column === column && sort.direction === 'descending') {
      setSort(null);
      setOrder(null);
      return;
    }
    const direction: SortDirection = sort?.column === column ? 'descending' : 'ascending';
    setSort({ column, direction });
    setOrder(sortedRowOrder(rows, column, direction, pinnedRows));
  };

  const scrollRef = React.useRef<HTMLElement>(null);
  const gridRef = React.useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: bodyRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT_ESTIMATE,
    overscan: 12,
  });
  const summary = totalRows === 1
    ? t('filesView.artifact.table.rowsSingle', { rows: totalRows, columns: dataColumnCount })
    : t('filesView.artifact.table.rowsPlural', { rows: totalRows, columns: dataColumnCount });

  const [active, setActive] = React.useState<CellPosition | null>(null);
  const [rangeEnd, setRangeEnd] = React.useState<CellPosition | null>(null);
  const [editor, setEditor] = React.useState<Editor | null>(null);
  const [commentAnchor, setCommentAnchor] = React.useState<{ x: number; y: number } | null>(null);
  const viewIndexOf = React.useMemo(() => new Map(viewRows.map((row, index) => [row, index])), [viewRows]);
  const range = React.useMemo(() => {
    if (!active || active.row < 0) return null;
    const end = rangeEnd ?? active;
    const firstView = viewIndexOf.get(active.row) ?? 0;
    const lastView = viewIndexOf.get(end.row) ?? firstView;
    return {
      top: Math.min(firstView, lastView),
      bottom: Math.max(firstView, lastView),
      left: Math.min(active.column, end.column),
      right: Math.max(active.column, end.column),
    };
  }, [active, rangeEnd, viewIndexOf]);
  const isMultiCell = Boolean(range && (range.top !== range.bottom || range.left !== range.right));
  const rangeRows = React.useMemo(() => (range
    ? viewRows.slice(range.top, range.bottom + 1).map((row) => (rows[row] ?? []).slice(range.left, range.right + 1))
    : []), [range, viewRows, rows]);
  const reference = (viewIndex: number, column: number) => `${columnName(column)}${rowLabels?.[viewRows[viewIndex]] ?? viewRows[viewIndex] + 2}`;
  const rangeName = range ? (isMultiCell ? `${reference(range.top, range.left)}:${reference(range.bottom, range.right)}` : reference(range.top, range.left)) : '';
  const selection = React.useMemo(() => (isMultiCell ? selectionSummary(rangeRows.flat()) : null), [isMultiCell, rangeRows]);
  const [chartOpen, setChartOpen] = React.useState(false);
  const selectionChart = React.useMemo(() => {
    if (!isMultiCell || !range) return null;
    const headings = (pinnedRows > 0 ? rows[0] : header).slice(range.left, range.right + 1);
    return chartProgram(rangeRows, headings);
  }, [isMultiCell, range, pinnedRows, rows, header, rangeRows]);
  const selectionFacts = selection ? [
    rangeName,
    selection.sum ? t('filesView.artifact.table.selectionSum', { value: selection.sum }) : '',
    selection.average ? t('filesView.artifact.table.selectionAverage', { value: selection.average }) : '',
    t('filesView.artifact.table.selectionCount', { count: selection.count }),
  ] : [];
  const skipBlurCommit = React.useRef(false);

  React.useEffect(() => {
    if (!range || !changedCells || changedCells.size === 0) return;
    const inView = Array.from(changedCells).filter((key) => {
      const [row, column] = key.split(':').map(Number);
      const viewIndex = viewIndexOf.get(row);
      return viewIndex !== undefined && viewIndex >= range.top && viewIndex <= range.bottom && column >= range.left && column <= range.right;
    });
    if (inView.length > 0) onSeen?.(inView);
    // A change arriving under the selection stays marked until the selection moves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range]);

  // A selection is a rectangle of what is on screen, which a filter just changed.
  React.useEffect(() => {
    setActive(null);
    setRangeEnd(null);
    setCommentAnchor(null);
  }, [query, valueFilters]);

  // Grid rows are renumbered by a structure change, so what pointed at them goes.
  const restructure = (change: () => void) => {
    setSort(null);
    setOrder(null);
    setActive(null);
    setRangeEnd(null);
    change();
  };

  const scrollToRow = (row: number) => {
    const bodyIndex = (viewIndexOf.get(row) ?? -1) - pinnedRows;
    if (bodyIndex >= 0) virtualizer.scrollToIndex(bodyIndex, { align: 'auto' });
  };
  const select = (position: CellPosition) => {
    setActive(position);
    setRangeEnd(null);
    setCommentAnchor(null);
    scrollToRow(position.row);
    gridRef.current?.focus({ preventScroll: true });
  };
  const extendTo = (position: CellPosition) => {
    if (!active || active.row < 0) {
      select(position);
      return;
    }
    setRangeEnd(position);
    setCommentAnchor(null);
    scrollToRow(position.row);
  };
  const selectAll = () => {
    if (rows.length === 0) return;
    setActive({ row: viewRows[0], column: 0 });
    setRangeEnd({ row: viewRows[viewRows.length - 1], column: columnCount - 1 });
    setCommentAnchor(null);
  };
  const selectRow = (row: number, extend: boolean) => {
    if (extend && active) {
      setRangeEnd({ row, column: columnCount - 1 });
      return;
    }
    setActive({ row, column: 0 });
    setRangeEnd({ row, column: columnCount - 1 });
    setCommentAnchor(null);
    gridRef.current?.focus({ preventScroll: true });
  };
  const selectColumn = (column: number) => {
    if (rows.length === 0) return;
    setActive({ row: viewRows[0], column });
    setRangeEnd({ row: viewRows[viewRows.length - 1], column });
    setCommentAnchor(null);
    gridRef.current?.focus({ preventScroll: true });
  };
  const startEditing = (position: CellPosition, draft?: string) => {
    if (!editing?.canEdit(position.row, position.column)) return;
    skipBlurCommit.current = false;
    setActive(position);
    setEditor({ ...position, draft: draft ?? editing.inputOf(position.row, position.column) });
  };
  const finishEditing = (commit: boolean) => {
    if (!editor) return;
    skipBlurCommit.current = true;
    if (commit && editor.draft !== editing?.inputOf(editor.row, editor.column)) {
      editing?.commit([{ row: editor.row, column: editor.column, input: editor.draft }]);
    }
    setEditor(null);
    gridRef.current?.focus({ preventScroll: true });
  };
  const stepFrom = (position: CellPosition, rowStep: number, columnStep: number): CellPosition => {
    const viewIndex = position.row < 0 ? -1 : viewIndexOf.get(position.row) ?? 0;
    const nextView = Math.min(viewRows.length - 1, Math.max(position.row < 0 ? -1 : 0, viewIndex + rowStep));
    const nextColumn = Math.min(columnCount - 1, Math.max(0, position.column + columnStep));
    return { row: nextView < 0 ? -1 : viewRows[nextView], column: nextColumn };
  };
  const move = (position: CellPosition, rowStep: number, columnStep: number) => select(stepFrom(position, rowStep, columnStep));

  const selectedCells = (): CellPosition[] => (range
    ? viewRows.slice(range.top, range.bottom + 1).flatMap((row) => Array.from({ length: range.right - range.left + 1 }, (_, offset) => ({ row, column: range.left + offset })))
    : []);

  const pasteAt = (event: React.ClipboardEvent<HTMLDivElement>) => {
    if (!editing || !range || editor) return;
    const text = event.clipboardData.getData('text/plain');
    if (!text) return;
    event.preventDefault();
    const records = fromTsv(text);
    if (records.length === 0) return;
    // One value fills the whole selection, as spreadsheets do.
    const cells: CellText[] = records.length === 1 && records[0].length === 1
      ? selectedCells().map((cell) => ({ ...cell, input: records[0][0] }))
      : records.flatMap((record, rowOffset) => record.map((input, columnOffset) => {
        const viewIndex = range.top + rowOffset;
        return { row: viewRows[viewIndex] ?? rows.length + viewIndex - viewRows.length, column: range.left + columnOffset, input };
      }));
    const allowed = cells.filter((cell) => cell.column < MAX_PASTE_COLUMN && editing.canEdit(cell.row, cell.column));
    if (allowed.length > 0) editing.commit(allowed);
  };

  const openComment = () => {
    const cell = gridRef.current?.querySelector('[data-active-cell]')?.getBoundingClientRect();
    const frame = gridRef.current?.getBoundingClientRect();
    if (frame) setCommentAnchor({ x: (cell?.left ?? frame.left) + (cell?.width ?? frame.width) / 2, y: (cell?.top ?? frame.top + 40) - 8 });
  };
  const headingRow = pinnedRows > 0 ? rows[0] : header;
  const commentQuote = () => {
    if (!range) return '';
    const place = [commentTarget?.place, rangeName].filter(Boolean).join(', ');
    const heading = range.top === 0 && pinnedRows > 0 ? null : headingRow?.slice(range.left, range.right + 1);
    return `${place}:\n${toTsv(heading && heading.some(Boolean) ? [heading, ...rangeRows] : rangeRows)}`;
  };

  const onEditorKey = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    event.stopPropagation();
    if (!editor) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      finishEditing(false);
    } else if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      finishEditing(true);
      move(editor, 1, 0);
    } else if (event.key === 'Tab') {
      event.preventDefault();
      finishEditing(true);
      move(editor, 0, event.shiftKey ? -1 : 1);
    }
  };

  const onGridKey = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const command = event.metaKey || event.ctrlKey;
    if (command && event.key.toLowerCase() === 'z' && editing) {
      event.preventDefault();
      if (event.shiftKey) editing.redo();
      else editing.undo();
      return;
    }
    if (command && event.key.toLowerCase() === 'a') {
      event.preventDefault();
      selectAll();
      return;
    }
    if (!active) return;
    const forward = isRightToLeft(event.currentTarget) ? -1 : 1;
    if (command && event.key.toLowerCase() === 'c') {
      event.preventDefault();
      void copyTextToClipboard(active.row < 0 ? header[active.column] ?? '' : toTsv(rangeRows));
      return;
    }
    if (command || event.altKey) return;
    const steps = new Map<string, [number, number]>([
      ['ArrowUp', [-1, 0]], ['ArrowDown', [1, 0]], ['ArrowLeft', [0, -forward]], ['ArrowRight', [0, forward]], ['Tab', [0, event.shiftKey ? -1 : 1]],
    ]);
    const step = steps.get(event.key);
    if (step && event.shiftKey && event.key !== 'Tab' && active.row >= 0) {
      event.preventDefault();
      extendTo(stepFrom(rangeEnd ?? active, step[0], step[1]));
    } else if (step) {
      event.preventDefault();
      move(active, step[0], step[1]);
    } else if (event.key === 'Enter' || event.key === 'F2') {
      event.preventDefault();
      startEditing(active);
    } else if ((event.key === 'Delete' || event.key === 'Backspace') && editing) {
      event.preventDefault();
      const cells = selectedCells().filter((cell) => editing.canEdit(cell.row, cell.column) && editing.inputOf(cell.row, cell.column) !== '');
      if (cells.length > 0) editing.commit(cells.map((cell) => ({ ...cell, input: '' })));
    } else if (event.key.length === 1 && editing) {
      event.preventDefault();
      startEditing(active, event.key);
    }
  };

  const renderRow = (rowIndex: number, viewIndex: number, stripe: number, measure?: (element: Element | null) => void) => {
                  const row = rows[rowIndex] ?? [];
                  const background = stripe % 2 === 0 ? 'bg-[var(--surface-background)]' : 'bg-[var(--surface-subtle)]/40';
                  const rowLabel = (
                        <td
                          className="sticky start-0 z-10 cursor-pointer truncate border-b border-e border-edge-muted bg-[var(--surface-subtle)] px-2 py-1 text-end text-muted-foreground"
                          dir="ltr"
                          onClick={(event) => selectRow(rowIndex, event.shiftKey)}
                        >
                          {rowLabels?.[rowIndex]}
                        </td>
                  );
                  return (
                    <tr key={rowIndex} data-index={stripe} ref={measure} className={background}>
                      {rowLabels ? (
                        <ContextMenu>
                          <ContextMenuTrigger render={rowLabel} />
                          {editing?.structure ? (
                            <ContextMenuContent className="w-52">
                              <ContextMenuItem onClick={() => restructure(() => editing.structure?.insertRow(rowIndex))}>{t('filesView.artifact.table.insertRow')}</ContextMenuItem>
                              <ContextMenuItem onClick={() => restructure(() => editing.structure?.deleteRow(rowIndex))}>{t('filesView.artifact.table.deleteRow')}</ContextMenuItem>
                            </ContextMenuContent>
                          ) : null}
                        </ContextMenu>
                      ) : null}
                      {columnChars.map((_, column) => {
                        const editingHere = editor?.row === rowIndex && editor.column === column;
                        const isActive = active?.row === rowIndex && active.column === column;
                        const inRange = Boolean(isMultiCell && range && viewIndex >= range.top && viewIndex <= range.bottom && column >= range.left && column <= range.right);
                        return (
                          <td
                            key={column}
                            className={cn(
                              'truncate border-b border-e border-edge-muted px-2 py-1 align-top text-foreground last:border-e-0',
                              changedCells?.has(`${rowIndex}:${column}`) && 'bg-[color-mix(in_srgb,var(--status-success)_22%,transparent)]',
                              inRange && 'bg-[color-mix(in_srgb,var(--interactive-selection)_45%,transparent)]',
                              isActive && activeClass,
                              column < frozenColumns && 'sticky z-[5] bg-[var(--surface-background)]',
                            )}
                            style={column < frozenColumns ? { insetInlineStart: frozenStart(column) } : undefined}
                            title={row[column] ?? ''}
                            data-active-cell={isActive ? '' : undefined}
                            onMouseDown={(event) => {
                              if (event.button !== 0 || editingHere) return;
                              if (event.shiftKey) extendTo({ row: rowIndex, column });
                              else select({ row: rowIndex, column });
                            }}
                            onMouseEnter={(event) => {
                              if (event.buttons === 1 && !editor) extendTo({ row: rowIndex, column });
                            }}
                            onDoubleClick={() => startEditing({ row: rowIndex, column })}
                          >
                            {editingHere ? (
                              <CellEditor
                                value={editor.draft}
                                label={cellLabel(editor)}
                                onChange={(draft) => setEditor({ ...editor, draft })}
                                onKeyDown={onEditorKey}
                                onBlur={() => {
                                  if (skipBlurCommit.current) skipBlurCommit.current = false;
                                  else finishEditing(true);
                                }}
                              />
                            ) : <CellText text={row[column] ?? ''} href={hrefOf?.(rowIndex, column)} />}
                          </td>
                        );
                      })}
                    </tr>
                  );
  };

  const virtualRows = virtualizer.getVirtualItems();
  const paddingTop = virtualRows[0]?.start ?? 0;
  const paddingBottom = virtualRows.length > 0
    ? virtualizer.getTotalSize() - virtualRows[virtualRows.length - 1].end
    : 0;
  const activeClass = 'outline outline-1 -outline-offset-1 outline-[var(--primary-base)]';
  const cellLabel = (position: CellPosition) => `${header[position.column] ?? ''}${position.row < 0 ? '' : ` ${rowLabels?.[position.row] ?? position.row + 2}`}`;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ArtifactMetaBar
        items={[
          ...selectionFacts,
          !isMultiCell && active && active.row >= 0 && describeCell ? describeCell(active.row, active.column) : '',
          summary,
          isFiltered ? t('filesView.artifact.table.filtered', { shown: viewRows.length, total: rows.length }) : '',
          rows.length < totalRows ? t('filesView.artifact.table.truncated', { shown: rows.length, total: totalRows }) : '',
          formatArtifactSize(sizeBytes),
          status ?? '',
        ]}
        actions={(
          <>
            {searchOpen ? (
              <Input
                autoFocus
                inputSize="compact"
                className="w-40"
                value={query}
                aria-label={t('filesView.artifact.table.search')}
                placeholder={t('filesView.artifact.table.search')}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  event.stopPropagation();
                  if (event.key === 'Escape') {
                    setQuery('');
                    setSearchOpen(false);
                    gridRef.current?.focus({ preventScroll: true });
                  }
                }}
              />
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-pressed={searchOpen}
              aria-label={t('filesView.artifact.table.search')}
              title={t('filesView.artifact.table.search')}
              className={searchOpen ? PRESSED_CLASS : undefined}
              onClick={() => {
                if (searchOpen) setQuery('');
                setSearchOpen(!searchOpen);
              }}
            >
              <Icon name="search" className="size-4" />
            </Button>
            {selectionChart ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-pressed={chartOpen}
                aria-label={t('filesView.artifact.table.chart')}
                title={t('filesView.artifact.table.chart')}
                className={chartOpen ? PRESSED_CLASS : undefined}
                onClick={() => setChartOpen(!chartOpen)}
              >
                <Icon name="bar-chart-2" className="size-4" />
              </Button>
            ) : null}
            {range && commentTarget ? (
              <Button type="button" variant="ghost" size="sm" aria-label={t('filesView.artifact.table.comment')} title={t('filesView.artifact.table.comment')} onClick={openComment}>
                <Icon name="double-quotes-l" className="size-4" />
              </Button>
            ) : null}
            {actions}
          </>
        )}
      />
      {chartOpen && selectionChart ? (
        <div className="max-h-80 shrink-0 overflow-auto border-b border-edge-muted p-3">
          <UiBlock source={selectionChart} complete />
        </div>
      ) : null}
      {commentAnchor && commentTarget ? (
        <QuoteCommentMenu
          key={rangeName}
          anchor={commentAnchor}
          quote={commentQuote()}
          fileLabel={commentTarget.fileLabel}
          opened
          onClose={() => setCommentAnchor(null)}
        />
      ) : null}
      {columnCount === 0 ? (
        <div className="p-3 typography-ui text-muted-foreground">{t('filesView.artifact.table.empty')}</div>
      ) : (
        <div ref={gridRef} tabIndex={0} role="grid" aria-rowcount={rows.length} className="flex min-h-0 flex-1 flex-col outline-none" onKeyDown={onGridKey} onPaste={pasteAt}>
          <ScrollableOverlay ref={scrollRef} outerClassName="min-h-0 flex-1">
            {/* A fixed layout only holds with an explicit table width; without it
                one long value widens its column past the cap. */}
            <table
              className="min-w-full table-fixed select-none border-separate border-spacing-0 font-mono typography-meta"
              style={{ width: tableWidth }}
            >
              <colgroup>
                {rowLabels ? <col style={{ width: gutterWidth }} /> : null}
                {columnChars.map((_, column) => (
                  <col key={column} style={{ width: columnWidth(column) }} />
                ))}
              </colgroup>
              <thead className="sticky top-0 z-20 bg-[var(--surface-subtle)]">
                <tr>
                  {rowLabels ? <th scope="col" aria-hidden="true" className="sticky start-0 z-10 border-b border-e border-edge-muted bg-[var(--surface-subtle)]" /> : null}
                  {columnChars.map((_, column) => {
                    const name = header[column] ?? '';
                    const sorted = sort?.column === column ? sort.direction : undefined;
                    const headingEditing = editor?.row === -1 && editor.column === column;
                    const filtered = valueFilters.has(column);
                    const heading = (
                      <th
                        key={column}
                        scope="col"
                        aria-sort={sorted ?? 'none'}
                        className={cn(
                          'relative border-b border-e border-edge-muted p-0 text-start font-medium text-foreground last:border-e-0',
                          column < frozenColumns && 'sticky z-10 bg-[var(--surface-subtle)]',
                          active?.row === -1 && active.column === column && activeClass,
                        )}
                        style={column < frozenColumns ? { insetInlineStart: frozenStart(column) } : undefined}
                        title={name}
                      >
                        {headingEditing ? (
                          <div className="px-2 py-1">
                            <CellEditor
                              value={editor.draft}
                              label={cellLabel(editor)}
                              onChange={(draft) => setEditor({ ...editor, draft })}
                              onKeyDown={onEditorKey}
                              onBlur={() => {
                                if (skipBlurCommit.current) skipBlurCommit.current = false;
                                else finishEditing(true);
                              }}
                            />
                          </div>
                        ) : (
                          <button
                            type="button"
                            aria-label={t('filesView.artifact.table.sortBy', { column: name || String(column + 1) })}
                            className="flex w-full min-w-0 items-center gap-1 px-2 py-1 text-start"
                            onClick={(event) => {
                              if (event.detail > 1) return;
                              if (event.shiftKey) selectColumn(column);
                              else toggleSort(column);
                            }}
                            onDoubleClick={() => {
                              if (sort?.column === column) toggleSort(column);
                              startEditing({ row: -1, column });
                            }}
                          >
                            <span className="min-w-0 truncate">{name}</span>
                            {sorted ? <Icon name={sorted === 'ascending' ? 'arrow-up-s' : 'arrow-down-s'} className="size-3.5 shrink-0" /> : null}
                            {filtered ? <span className="size-1.5 shrink-0 rounded-full bg-[var(--primary-base)]" aria-hidden /> : null}
                          </button>
                        )}
                        <ColumnResizeHandle
                          label={t('filesView.artifact.table.resizeColumn', { column: name || String(column + 1) })}
                          onResize={(width) => setDragged({ column, width })}
                          onResizeEnd={(width) => storeWidths({ ...widths, [column]: width })}
                          onReset={() => {
                            const { [column]: _removed, ...rest } = widths;
                            storeWidths(rest);
                          }}
                        />
                      </th>
                    );
                    return (
                      <ContextMenu key={column}>
                        <ContextMenuTrigger render={heading} />
                        <ContextMenuContent className="w-56">
                          <ContextMenuSub>
                            <ContextMenuSubTrigger>{t('filesView.artifact.table.filterValues')}</ContextMenuSubTrigger>
                            <ContextMenuSubContent className="max-h-80 w-56 overflow-y-auto">
                              {columnValues(column).map((value) => (
                                <ContextMenuItem key={value} closeOnClick={false} onClick={() => toggleValue(column, value)}>
                                  <Icon name="check" className={cn('me-2 size-4', valueFilters.get(column)?.has(value) && 'invisible')} />
                                  <span className="truncate">{value || t('filesView.artifact.table.emptyValue')}</span>
                                </ContextMenuItem>
                              ))}
                            </ContextMenuSubContent>
                          </ContextMenuSub>
                          {filtered ? <ContextMenuItem onClick={() => clearFilter(column)}>{t('filesView.artifact.table.clearFilter')}</ContextMenuItem> : null}
                          <ContextMenuItem onClick={() => setFrozenColumns(frozenColumns === column + 1 ? 0 : column + 1)}>
                            {t(frozenColumns === column + 1 ? 'filesView.artifact.table.unfreeze' : 'filesView.artifact.table.freezeColumns')}
                          </ContextMenuItem>
                          {editing?.structure ? (
                            <>
                              <ContextMenuSeparator />
                              <ContextMenuItem onClick={() => restructure(() => editing.structure?.insertColumn(column))}>{t('filesView.artifact.table.insertColumn')}</ContextMenuItem>
                              <ContextMenuItem onClick={() => restructure(() => editing.structure?.deleteColumn(column))}>{t('filesView.artifact.table.deleteColumn')}</ContextMenuItem>
                            </>
                          ) : null}
                        </ContextMenuContent>
                      </ContextMenu>
                    );
                  })}
                </tr>
                {viewRows.slice(0, pinnedRows).map((rowIndex, index) => renderRow(rowIndex, index, 0))}
              </thead>
              <tbody>
                {paddingTop > 0 ? <tr aria-hidden="true" style={{ height: paddingTop }} /> : null}
                {virtualRows.map((virtualRow) => renderRow(bodyRows[virtualRow.index], virtualRow.index + pinnedRows, virtualRow.index, virtualizer.measureElement))}
                {paddingBottom > 0 ? <tr aria-hidden="true" style={{ height: paddingBottom }} /> : null}
              </tbody>
            </table>
          </ScrollableOverlay>
        </div>
      )}
    </div>
  );
};

/**
 * CSV/TSV in a grid. A change replaces one field in the file's text and goes
 * through the editor's own draft, so it saves, autosaves and guards against
 * outside changes the way typing in the text view does.
 */
export const TableArtifact: React.FC<{
  path: string;
  content: string;
  sizeBytes: number | null;
  /** Absent where the file cannot be written. */
  onContentChange?: (content: string) => void;
}> = ({ path, content, sizeBytes, onContentChange }) => {
  const delimiter = delimiterForPath(path);
  const table = React.useMemo(() => parseDelimitedText(content, delimiter), [content, delimiter]);
  const undoStack = React.useRef<string[]>([]);
  const redoStack = React.useRef<string[]>([]);
  const ownChange = React.useRef(false);
  const [changedCells, setChangedCells] = React.useState<ReadonlySet<string>>(() => new Set());
  React.useEffect(() => {
    // The draft is empty for a moment while the file loads; that is no table to compare with.
    if (table.columnCount === 0) return;
    const cells = new Map(table.rows.flatMap((row, rowIndex) => row.map((value, column): [string, string] => [`${rowIndex}:${column}`, value])));
    if (ownChange.current) {
      ownChange.current = false;
      noteOwnEdit(path, cells);
    } else {
      setChangedCells(traceChanges(path, cells));
    }
  }, [path, table]);
  // Two edits can land before the next render; each builds on the last.
  const latest = React.useRef(content);
  React.useLayoutEffect(() => {
    latest.current = content;
  }, [content]);
  const change = (next: string) => {
    latest.current = next;
    ownChange.current = true;
    onContentChange?.(next);
  };
  // One spare row and column, so a table can grow from the grid. A row past a
  // capped table would land on a record that is not on screen.
  const rows = React.useMemo(() => {
    if (!onContentChange) return table.rows;
    const padded = table.rows.map((row) => [...row, ...Array.from({ length: table.columnCount + 1 - row.length }, () => '')]);
    return table.truncated ? padded : [...padded, Array.from({ length: table.columnCount + 1 }, () => '')];
  }, [table, onContentChange]);
  const header = React.useMemo(() => (onContentChange ? [...table.header, ...Array.from({ length: table.columnCount + 1 - table.header.length }, () => '')] : table.header), [table, onContentChange]);
  const restructure = (next: string) => {
    undoStack.current.push(latest.current);
    redoStack.current = [];
    change(next);
  };
  // Numbered as a spreadsheet opens the file: the heading is row 1.
  const rowLabels = React.useMemo(() => rows.map((_, index) => index + 2), [rows]);
  const editing: TableEditing | undefined = onContentChange ? {
    canEdit: () => true,
    inputOf: (row, column) => (row < 0 ? header[column] : rows[row]?.[column]) ?? '',
    commit: (cells) => {
      undoStack.current.push(latest.current);
      if (undoStack.current.length > MAX_UNDO) undoStack.current.shift();
      redoStack.current = [];
      change(cells.reduce((text, cell) => setDelimitedField(text, delimiter, cell.row + 1, cell.column, cell.input), latest.current));
    },
    undo: () => {
      const previous = undoStack.current.pop();
      if (previous === undefined) return;
      redoStack.current.push(latest.current);
      change(previous);
    },
    redo: () => {
      const next = redoStack.current.pop();
      if (next === undefined) return;
      undoStack.current.push(latest.current);
      change(next);
    },
    structure: {
      insertRow: (row) => restructure(shiftDelimitedRow(latest.current, delimiter, row + 1, 1)),
      deleteRow: (row) => restructure(shiftDelimitedRow(latest.current, delimiter, row + 1, -1)),
      insertColumn: (column) => restructure(shiftDelimitedColumn(latest.current, delimiter, column, 1)),
      deleteColumn: (column) => restructure(shiftDelimitedColumn(latest.current, delimiter, column, -1)),
    },
  } : undefined;
  return (
    <TableGrid
      tableId={path}
      header={header}
      rows={rows}
      rowLabels={rowLabels}
      columnCount={onContentChange ? table.columnCount + 1 : table.columnCount}
      dataColumnCount={table.columnCount}
      totalRows={table.totalRows}
      sizeBytes={sizeBytes}
      editing={editing}
      commentTarget={{ fileLabel: path }}
      changedCells={changedCells}
      onSeen={(keys) => setChangedCells(markSeen(path, keys))}
    />
  );
};
