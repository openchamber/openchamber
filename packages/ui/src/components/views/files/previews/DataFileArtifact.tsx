import React from 'react';

import { PRESSED_CLASS } from '@/components/ui/action-toolbar';
import { Button } from '@/components/ui/button';
import { ContentLoadingState } from '@/components/ui/content-state';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useI18n } from '@/lib/i18n';
import { getFileExtension, isDataFile } from '@/lib/toolHelpers';
import { BinaryArtifact } from './BinaryArtifact';
import { quoteSqlName } from './dataFiles';
import { DEFAULT_TABLE_ROW_CAP, delimiterForPath } from './delimitedText';
import { collectRows, documentTransport, newDocumentId } from './documentClient';
import { TableGrid } from './TableArtifact';

type LoadBytes = (path: string, signal: AbortSignal) => Promise<Uint8Array<ArrayBuffer>>;
type Table = { columns: string[]; rows: string[][]; totalRows: number; columnCount?: number };
type Sort = { column: number; direction: 'ascending' | 'descending' };

const sortedQuery = (query: string, columns: string[], sort: Sort | null): string => {
  if (!sort) return query;
  const inner = query.trim().replace(/;\s*$/, '');
  return `SELECT * FROM (${inner}) ORDER BY ${quoteSqlName(columns[sort.column])} ${sort.direction === 'ascending' ? 'ASC' : 'DESC'}`;
};

const SqliteView: React.FC<{ path: string; database: string; tables: string[]; sizeBytes: number | null; status?: string }> = ({ path, database, tables, sizeBytes, status }) => {
  const { t } = useI18n();
  const [table, setTable] = React.useState(tables[0] ?? '');
  const [query, setQuery] = React.useState('');
  const [queryOpen, setQueryOpen] = React.useState(false);
  const [result, setResult] = React.useState<Table | null>(null);
  const [error, setError] = React.useState('');
  const [running, setRunning] = React.useState(false);
  const shownQuery = React.useRef('');
  const generation = React.useRef(0);

  const show = React.useCallback(async (statement: string, sort: Sort | null = null) => {
    generation.current += 1;
    const own = generation.current;
    setRunning(true);
    const collected = collectRows();
    try {
      const call = await documentTransport();
      const columns = result?.columns ?? [];
      const { columns: names, totalRows } = await call('sqlite.query', { database, query: sortedQuery(statement, columns, sort), rowCap: DEFAULT_TABLE_ROW_CAP }, collected.add);
      if (own !== generation.current) return;
      shownQuery.current = statement;
      setResult({ columns: names, rows: collected.rows, totalRows });
      setError('');
    } catch (cause) {
      if (own === generation.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (own === generation.current) setRunning(false);
    }
  }, [database, result?.columns]);

  React.useEffect(() => {
    if (table) void show(`SELECT * FROM ${quoteSqlName(table)}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [table]);

  // The text stays for the next time the field opens.
  const closeQuery = () => {
    setQueryOpen(false);
    if (result) setError('');
  };

  if (!result && !error) return <ContentLoadingState label={t('filesView.artifact.state.loading')} />;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {queryOpen ? (
        <div className="flex flex-col gap-2 border-b border-edge-muted p-2">
          <Textarea
            value={query}
            rows={3}
            aria-label={t('filesView.artifact.data.query')}
            placeholder={`SELECT * FROM ${table ? quoteSqlName(table) : '...'}`}
            className="font-mono"
            dir="ltr"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') void show(query);
              if (event.key === 'Escape') {
                event.stopPropagation();
                closeQuery();
              }
            }}
          />
          <div className="flex items-center gap-2">
            <Button type="button" size="sm" onClick={() => void show(query)} disabled={!query.trim() || running}>{t('filesView.artifact.data.run')}</Button>
            <span className="min-w-0 flex-1 truncate typography-meta text-[color:var(--status-error)]" title={error}>{error}</span>
            <Button type="button" variant="ghost" size="sm" onClick={closeQuery}>{t('settings.common.actions.cancel')}</Button>
          </div>
        </div>
      ) : null}
      <div className="min-h-0 flex-1">
        <TableGrid
          key={`${table}:${result?.columns.join(',')}`}
          tableId={`${path}#${table}`}
          header={result?.columns ?? []}
          rows={result?.rows ?? []}
          columnCount={result?.columns.length ?? 0}
          totalRows={result?.totalRows ?? 0}
          sizeBytes={sizeBytes}
          commentTarget={{ fileLabel: path, place: `Table "${table}"` }}
          status={status}
          // Rows past the cap are not here, so only the database can sort them in.
          onSort={result && result.totalRows > result.rows.length ? (sort) => void show(shownQuery.current, sort) : undefined}
          actions={(
            <>
              <Button type="button" variant="ghost" size="sm" aria-pressed={queryOpen} className={queryOpen ? PRESSED_CLASS : undefined} onClick={() => (queryOpen ? closeQuery() : setQueryOpen(true))}>{t('filesView.artifact.data.query')}</Button>
              {tables.length > 1 ? (
                <Select value={table} onValueChange={(value) => setTable(String(value))}>
                  <SelectTrigger className="w-fit max-w-48" aria-label={t('filesView.artifact.data.table')}>
                    <SelectValue>{table}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {tables.map((name) => <SelectItem key={name} value={name}>{name}</SelectItem>)}
                  </SelectContent>
                </Select>
              ) : null}
            </>
          )}
        />
      </div>
    </div>
  );
};

type Opened =
  | { status: 'loading' }
  | { status: 'failed' }
  | { status: 'sqlite'; database: string; tables: string[]; staleWal: boolean }
  | { status: 'table'; table: Table };

/**
 * SQLite, Parquet and text tables too large for the editor, read-only, as copies
 * in memory in the document worker.
 */
export const DataFileArtifact: React.FC<{
  name: string;
  path: string;
  sizeBytes: number | null;
  loadBytes: LoadBytes;
  actions?: React.ReactNode;
}> = ({ name, path, sizeBytes, loadBytes, actions }) => {
  const { t } = useI18n();
  const [state, setState] = React.useState<Opened>({ status: 'loading' });

  React.useEffect(() => {
    const controller = new AbortController();
    let database: string | null = null;
    void (async () => {
      try {
        const bytes = await loadBytes(path, controller.signal);
        const call = await documentTransport();
        const collected = collectRows();
        const extension = getFileExtension(path);
        if (extension === 'parquet' || !isDataFile(path)) {
          const end = extension === 'parquet'
            ? await call('parquet.read', { bytes, rowCap: DEFAULT_TABLE_ROW_CAP }, collected.add)
            : await call('delimited.read', { bytes, delimiter: delimiterForPath(path), rowCap: DEFAULT_TABLE_ROW_CAP }, collected.add);
          if (!controller.signal.aborted) setState({ status: 'table', table: { ...end, rows: collected.rows } });
          return;
        }
        const wal = await loadBytes(`${path}-wal`, controller.signal).catch(() => null);
        const id = newDocumentId();
        const { tables } = await call('sqlite.open', { database: id, bytes });
        if (controller.signal.aborted) {
          void call('sqlite.close', { database: id });
          return;
        }
        database = id;
        setState({ status: 'sqlite', database: id, tables, staleWal: Boolean(wal && wal.length > 0) });
      } catch {
        if (!controller.signal.aborted) setState({ status: 'failed' });
      }
    })();
    return () => {
      controller.abort();
      if (database) void documentTransport().then((call) => call('sqlite.close', { database: database ?? '' }));
    };
  }, [path, loadBytes]);

  if (state.status === 'loading') return <ContentLoadingState label={t('filesView.artifact.state.loading')} />;
  if (state.status === 'failed') return <BinaryArtifact name={name} path={path} sizeBytes={sizeBytes} download={actions} description={t('filesView.artifact.data.unreadable')} />;
  if (state.status === 'sqlite') {
    return <SqliteView path={path} database={state.database} tables={state.tables} sizeBytes={sizeBytes} status={state.staleWal ? t('filesView.artifact.data.walPending') : undefined} />;
  }
  return (
    <TableGrid
      tableId={path}
      header={state.table.columns}
      rows={state.table.rows}
      columnCount={state.table.columnCount ?? state.table.columns.length}
      totalRows={state.table.totalRows}
      sizeBytes={sizeBytes}
      commentTarget={{ fileLabel: path }}
    />
  );
};
