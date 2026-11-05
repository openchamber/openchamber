import React from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';

import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { useI18n } from '@/lib/i18n';
import { ArtifactMetaBar } from './ArtifactMetaBar';
import { formatArtifactSize } from './artifactMeta';
import { delimiterForPath, parseDelimitedText } from './delimitedText';

const ROW_HEIGHT_ESTIMATE = 25;
const MIN_COLUMN_CHARS = 4;
const MAX_COLUMN_CHARS = 64;

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

/**
 * A table as a grid: a sticky header row and monospace cells. Only the rows in
 * view are rendered: a wide export at the row cap is hundreds of thousands of
 * cells, which froze the app when they all went into the DOM at once.
 */
export const TableGrid: React.FC<{
  header: string[];
  rows: string[][];
  columnCount: number;
  /** Columns the meta line counts, when the grid adds one of its own. */
  dataColumnCount?: number;
  totalRows: number;
  sizeBytes: number | null;
  actions?: React.ReactNode;
}> = ({ header, rows, columnCount, dataColumnCount = columnCount, totalRows, sizeBytes, actions }) => {
  const { t } = useI18n();
  const columnChars = React.useMemo(
    () => measureColumnChars(header, rows, columnCount),
    [header, rows, columnCount],
  );
  const totalColumnChars = columnChars.reduce((sum, chars) => sum + chars, 0);
  const scrollRef = React.useRef<HTMLElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT_ESTIMATE,
    overscan: 12,
  });
  const summary = totalRows === 1
    ? t('filesView.artifact.table.rowsSingle', { rows: totalRows, columns: dataColumnCount })
    : t('filesView.artifact.table.rowsPlural', { rows: totalRows, columns: dataColumnCount });
  const virtualRows = virtualizer.getVirtualItems();
  const paddingTop = virtualRows[0]?.start ?? 0;
  const paddingBottom = virtualRows.length > 0
    ? virtualizer.getTotalSize() - virtualRows[virtualRows.length - 1].end
    : 0;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ArtifactMetaBar
        items={[
          summary,
          rows.length < totalRows ? t('filesView.artifact.table.truncated', { shown: rows.length, total: totalRows }) : '',
          formatArtifactSize(sizeBytes),
        ]}
        actions={actions}
      />
      {columnCount === 0 ? (
        <div className="p-3 typography-ui text-muted-foreground">{t('filesView.artifact.table.empty')}</div>
      ) : (
        <ScrollableOverlay ref={scrollRef} outerClassName="min-h-0 flex-1">
          {/* A fixed layout only holds with an explicit table width; without it
              one long value widens its column past the cap. */}
          <table
            className="min-w-full table-fixed border-separate border-spacing-0 font-mono typography-meta"
            style={{ width: `calc(${totalColumnChars}ch + ${columnChars.length} * (1rem + 1px))` }}
          >
            <colgroup>
              {columnChars.map((chars, column) => (
                <col key={column} style={{ width: `calc(${chars}ch + 1rem + 1px)` }} />
              ))}
            </colgroup>
            <thead className="sticky top-0 z-10 bg-[var(--surface-subtle)]">
              <tr>
                {columnChars.map((_, column) => (
                  <th
                    key={column}
                    scope="col"
                    className="truncate border-b border-e border-edge-muted px-2 py-1 text-start font-medium text-foreground last:border-e-0"
                    title={header[column] ?? ''}
                  >
                    {header[column] ?? ''}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {paddingTop > 0 ? <tr aria-hidden="true" style={{ height: paddingTop }} /> : null}
              {virtualRows.map((virtualRow) => {
                const row = rows[virtualRow.index] ?? [];
                return (
                  <tr
                    key={virtualRow.index}
                    data-index={virtualRow.index}
                    ref={virtualizer.measureElement}
                    className={virtualRow.index % 2 === 0 ? 'bg-[var(--surface-background)]' : 'bg-[var(--surface-subtle)]/40'}
                  >
                    {columnChars.map((_, column) => (
                      <td
                        key={column}
                        className="truncate border-b border-e border-edge-muted px-2 py-1 align-top text-foreground last:border-e-0"
                        title={row[column] ?? ''}
                      >
                        {row[column] ?? ''}
                      </td>
                    ))}
                  </tr>
                );
              })}
              {paddingBottom > 0 ? <tr aria-hidden="true" style={{ height: paddingBottom }} /> : null}
            </tbody>
          </table>
        </ScrollableOverlay>
      )}
    </div>
  );
};

/**
 * CSV/TSV in a grid, with a hard cap on rows so a large export renders at all.
 * The cap is stated in the meta line, not hidden, because "2,000 rows" and "the
 * first 2,000 rows" mean different things to someone checking a result.
 */
export const TableArtifact: React.FC<{
  path: string;
  content: string;
  sizeBytes: number | null;
}> = ({ path, content, sizeBytes }) => {
  const table = React.useMemo(() => parseDelimitedText(content, delimiterForPath(path)), [content, path]);
  return (
    <TableGrid
      header={table.header}
      rows={table.rows}
      columnCount={table.columnCount}
      totalRows={table.totalRows}
      sizeBytes={sizeBytes}
    />
  );
};
