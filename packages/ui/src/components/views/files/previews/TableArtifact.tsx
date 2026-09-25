import React from 'react';

import { useI18n } from '@/lib/i18n';
import { ArtifactMetaBar } from './ArtifactMetaBar';
import { formatArtifactSize } from './artifactMeta';
import { delimiterForPath, parseDelimitedText } from './delimitedText';

/**
 * CSV/TSV as a grid: a sticky header row, monospace cells, and a hard cap on
 * rows so a large export renders at all. The cap is stated in the meta line,
 * not hidden, because "2,000 rows" and "the first 2,000 rows" mean different
 * things to someone checking a result.
 */
export const TableArtifact: React.FC<{
  path: string;
  content: string;
  sizeBytes: number | null;
}> = ({ path, content, sizeBytes }) => {
  const { t } = useI18n();
  const table = React.useMemo(() => parseDelimitedText(content, delimiterForPath(path)), [content, path]);
  const summary = table.totalRows === 1
    ? t('filesView.artifact.table.rowsSingle', { rows: table.totalRows, columns: table.columnCount })
    : t('filesView.artifact.table.rowsPlural', { rows: table.totalRows, columns: table.columnCount });
  const columns = Array.from({ length: table.columnCount }, (_, index) => index);

  return (
    <div className="flex h-full min-h-0 flex-col">
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
        <div className="min-h-0 flex-1 overflow-auto">
          <table className="min-w-full border-separate border-spacing-0 font-mono typography-meta">
            <thead className="sticky top-0 z-10 bg-[var(--surface-subtle)]">
              <tr>
                {columns.map((column) => (
                  <th
                    key={column}
                    scope="col"
                    className="whitespace-nowrap border-b border-r border-border/40 px-2 py-1 text-left font-medium text-foreground last:border-r-0"
                  >
                    {table.header[column] ?? ''}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((row, rowIndex) => (
                <tr key={rowIndex} className="odd:bg-[var(--surface-background)] even:bg-[var(--surface-subtle)]/40">
                  {columns.map((column) => (
                    <td
                      key={column}
                      className="max-w-[32rem] truncate border-b border-r border-border/30 px-2 py-1 align-top text-foreground last:border-r-0"
                      title={row[column] ?? ''}
                    >
                      {row[column] ?? ''}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
