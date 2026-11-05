import React from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';

import { Icon } from '@/components/icon/Icon';
import { ColumnResizeHandle } from '@/components/ui/ColumnResizeHandle';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { copyTextToClipboard } from '@/lib/clipboard';
import { loadColumnWidths, saveColumnWidths, type ColumnWidths } from '@/lib/columnWidthMemory';
import { isRightToLeft, useI18n } from '@/lib/i18n';
import { openExternalUrl } from '@/lib/url';
import { cn } from '@/lib/utils';
import { ArtifactMetaBar } from './ArtifactMetaBar';
import { formatArtifactSize } from './artifactMeta';
import { delimiterForPath, parseDelimitedText, setDelimitedField } from './delimitedText';
import { cellParts, sortedRowOrder, type SortDirection } from './tableCells';

const ROW_HEIGHT_ESTIMATE = 25;
const MIN_COLUMN_CHARS = 4;
const MAX_COLUMN_CHARS = 64;
const MAX_UNDO = 100;

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

export type TableEditing = {
  /** `row` is an index into the grid's rows, or -1 for the heading. */
  canEdit: (row: number, column: number) => boolean;
  inputOf: (row: number, column: number) => string;
  commit: (row: number, column: number, input: string) => void;
  undo: () => void;
  redo: () => void;
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
  /** Save state and other facts for the meta line. */
  status?: string;
  actions?: React.ReactNode;
}> = ({ tableId, header, rows, rowLabels, columnCount, dataColumnCount = columnCount, totalRows, sizeBytes, pinnedRows = 0, hrefOf, editing, describeCell, status, actions }) => {
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
  const viewRows = React.useMemo(() => {
    if (!order) return Array.from({ length: rows.length }, (_, index) => index);
    // A row added after sorting joins the end.
    return [...order, ...Array.from({ length: Math.max(0, rows.length - order.length) }, (_, index) => order.length + index)];
  }, [order, rows.length]);
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
    count: viewRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT_ESTIMATE,
    overscan: 12,
  });
  const summary = totalRows === 1
    ? t('filesView.artifact.table.rowsSingle', { rows: totalRows, columns: dataColumnCount })
    : t('filesView.artifact.table.rowsPlural', { rows: totalRows, columns: dataColumnCount });

  const [active, setActive] = React.useState<CellPosition | null>(null);
  const [editor, setEditor] = React.useState<Editor | null>(null);
  const skipBlurCommit = React.useRef(false);

  const select = (position: CellPosition) => {
    setActive(position);
    if (position.row >= 0) virtualizer.scrollToIndex(viewRows.indexOf(position.row), { align: 'auto' });
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
    if (commit && editor.draft !== editing?.inputOf(editor.row, editor.column)) editing?.commit(editor.row, editor.column, editor.draft);
    setEditor(null);
    gridRef.current?.focus({ preventScroll: true });
  };
  const move = (position: CellPosition, rowStep: number, columnStep: number) => {
    const viewIndex = position.row < 0 ? -1 : viewRows.indexOf(position.row);
    const nextView = Math.min(viewRows.length - 1, Math.max(position.row < 0 ? -1 : 0, viewIndex + rowStep));
    const nextColumn = Math.min(columnCount - 1, Math.max(0, position.column + columnStep));
    select({ row: nextView < 0 ? -1 : viewRows[nextView], column: nextColumn });
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
    if (!active) return;
    const forward = isRightToLeft(event.currentTarget) ? -1 : 1;
    if (command && event.key.toLowerCase() === 'c') {
      event.preventDefault();
      void copyTextToClipboard(active.row < 0 ? header[active.column] ?? '' : rows[active.row]?.[active.column] ?? '');
      return;
    }
    if (command || event.altKey) return;
    const steps = new Map<string, [number, number]>([
      ['ArrowUp', [-1, 0]], ['ArrowDown', [1, 0]], ['ArrowLeft', [0, -forward]], ['ArrowRight', [0, forward]], ['Tab', [0, event.shiftKey ? -1 : 1]],
    ]);
    const step = steps.get(event.key);
    if (step) {
      event.preventDefault();
      move(active, step[0], step[1]);
    } else if (event.key === 'Enter' || event.key === 'F2') {
      event.preventDefault();
      startEditing(active);
    } else if ((event.key === 'Delete' || event.key === 'Backspace') && editing?.canEdit(active.row, active.column)) {
      event.preventDefault();
      if (editing.inputOf(active.row, active.column) !== '') editing.commit(active.row, active.column, '');
    } else if (event.key.length === 1 && editing) {
      event.preventDefault();
      startEditing(active, event.key);
    }
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
          active && active.row >= 0 && describeCell ? describeCell(active.row, active.column) : '',
          summary,
          rows.length < totalRows ? t('filesView.artifact.table.truncated', { shown: rows.length, total: totalRows }) : '',
          formatArtifactSize(sizeBytes),
          status ?? '',
        ]}
        actions={actions}
      />
      {columnCount === 0 ? (
        <div className="p-3 typography-ui text-muted-foreground">{t('filesView.artifact.table.empty')}</div>
      ) : (
        <div ref={gridRef} tabIndex={0} role="grid" aria-rowcount={rows.length} className="flex min-h-0 flex-1 flex-col outline-none" onKeyDown={onGridKey}>
          <ScrollableOverlay ref={scrollRef} outerClassName="min-h-0 flex-1">
            {/* A fixed layout only holds with an explicit table width; without it
                one long value widens its column past the cap. */}
            <table
              className="min-w-full table-fixed border-separate border-spacing-0 font-mono typography-meta"
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
                    return (
                      <th
                        key={column}
                        scope="col"
                        aria-sort={sorted ?? 'none'}
                        className={cn(
                          'relative border-b border-e border-edge-muted p-0 text-start font-medium text-foreground last:border-e-0',
                          active?.row === -1 && active.column === column && activeClass,
                        )}
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
                              toggleSort(column);
                            }}
                            onDoubleClick={() => {
                              if (sort?.column === column) toggleSort(column);
                              startEditing({ row: -1, column });
                            }}
                          >
                            <span className="min-w-0 truncate">{name}</span>
                            {sorted ? <Icon name={sorted === 'ascending' ? 'arrow-up-s' : 'arrow-down-s'} className="size-3.5 shrink-0" /> : null}
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
                  })}
                </tr>
              </thead>
              <tbody>
                {paddingTop > 0 ? <tr aria-hidden="true" style={{ height: paddingTop }} /> : null}
                {virtualRows.map((virtualRow) => {
                  const rowIndex = viewRows[virtualRow.index];
                  const row = rows[rowIndex] ?? [];
                  const background = virtualRow.index % 2 === 0 ? 'bg-[var(--surface-background)]' : 'bg-[var(--surface-subtle)]/40';
                  return (
                    <tr key={rowIndex} data-index={virtualRow.index} ref={virtualizer.measureElement} className={background}>
                      {rowLabels ? (
                        <td className="sticky start-0 z-10 truncate border-b border-e border-edge-muted bg-[var(--surface-subtle)] px-2 py-1 text-end text-muted-foreground" dir="ltr">
                          {rowLabels[rowIndex]}
                        </td>
                      ) : null}
                      {columnChars.map((_, column) => {
                        const editingHere = editor?.row === rowIndex && editor.column === column;
                        const isActive = active?.row === rowIndex && active.column === column;
                        return (
                          <td
                            key={column}
                            className={cn(
                              'truncate border-b border-e border-edge-muted px-2 py-1 align-top text-foreground last:border-e-0',
                              isActive && activeClass,
                            )}
                            title={row[column] ?? ''}
                            onClick={() => select({ row: rowIndex, column })}
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
                })}
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
  // Two edits can land before the next render; each builds on the last.
  const latest = React.useRef(content);
  React.useLayoutEffect(() => {
    latest.current = content;
  }, [content]);
  const change = (next: string) => {
    latest.current = next;
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
  const editing: TableEditing | undefined = onContentChange ? {
    canEdit: () => true,
    inputOf: (row, column) => (row < 0 ? header[column] : rows[row]?.[column]) ?? '',
    commit: (row, column, input) => {
      undoStack.current.push(latest.current);
      if (undoStack.current.length > MAX_UNDO) undoStack.current.shift();
      redoStack.current = [];
      change(setDelimitedField(latest.current, delimiter, row + 1, column, input));
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
  } : undefined;
  return (
    <TableGrid
      tableId={path}
      header={header}
      rows={rows}
      columnCount={onContentChange ? table.columnCount + 1 : table.columnCount}
      dataColumnCount={table.columnCount}
      totalRows={table.totalRows}
      sizeBytes={sizeBytes}
      editing={editing}
    />
  );
};
