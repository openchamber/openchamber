import React from 'react';

import { Button } from '@/components/ui/button';
import { ContentLoadingState } from '@/components/ui/content-state';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useI18n } from '@/lib/i18n';
import { getFileExtension } from '@/lib/toolHelpers';
import { BinaryArtifact } from './BinaryArtifact';
import { DEFAULT_TABLE_ROW_CAP } from './delimitedText';
import { isSqliteFile, openSqlite, quoteSqlName, readParquet, runSqlite, sqliteTables, type DataTable } from './dataFiles';
import { TableGrid } from './TableArtifact';

type LoadBytes = (path: string, signal: AbortSignal) => Promise<Uint8Array<ArrayBuffer>>;
type SqliteDatabase = Awaited<ReturnType<typeof openSqlite>>;

const SqliteView: React.FC<{ path: string; database: SqliteDatabase; sizeBytes: number | null; status?: string }> = ({ path, database, sizeBytes, status }) => {
  const { t } = useI18n();
  const tables = React.useMemo(() => sqliteTables(database), [database]);
  const [table, setTable] = React.useState(tables[0] ?? '');
  const [query, setQuery] = React.useState('');
  const [queryOpen, setQueryOpen] = React.useState(false);
  const [result, setResult] = React.useState<DataTable | null>(null);
  const [error, setError] = React.useState('');

  const show = (statement: string) => {
    try {
      setResult(runSqlite(database, statement, DEFAULT_TABLE_ROW_CAP));
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  React.useEffect(() => {
    if (table) show(`SELECT * FROM ${quoteSqlName(table)}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [table]);

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
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') show(query);
            }}
          />
          <div className="flex items-center gap-2">
            <Button type="button" size="sm" onClick={() => show(query)} disabled={!query.trim()}>{t('filesView.artifact.data.run')}</Button>
            {error ? <span className="min-w-0 truncate typography-meta text-[color:var(--status-error)]" title={error}>{error}</span> : null}
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
          actions={(
            <>
              <Button type="button" variant="ghost" size="sm" aria-pressed={queryOpen} onClick={() => setQueryOpen(!queryOpen)}>{t('filesView.artifact.data.query')}</Button>
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

/** SQLite databases and Parquet files as tables. Both are read-only copies in memory. */
export const DataFileArtifact: React.FC<{
  name: string;
  path: string;
  sizeBytes: number | null;
  loadBytes: LoadBytes;
  actions?: React.ReactNode;
}> = ({ name, path, sizeBytes, loadBytes, actions }) => {
  const { t } = useI18n();
  const [state, setState] = React.useState<{ status: 'loading' } | { status: 'failed' } | { status: 'sqlite'; database: SqliteDatabase; staleWal: boolean } | { status: 'parquet'; table: DataTable }>({ status: 'loading' });

  React.useEffect(() => {
    const controller = new AbortController();
    let database: SqliteDatabase | null = null;
    void (async () => {
      try {
        const bytes = await loadBytes(path, controller.signal);
        if (getFileExtension(path) === 'parquet') {
          setState({ status: 'parquet', table: await readParquet(bytes, DEFAULT_TABLE_ROW_CAP) });
          return;
        }
        if (!isSqliteFile(bytes)) throw new Error('Not a SQLite database');
        const wal = await loadBytes(`${path}-wal`, controller.signal).catch(() => null);
        database = await openSqlite(bytes);
        if (controller.signal.aborted) database.close();
        else setState({ status: 'sqlite', database, staleWal: Boolean(wal && wal.length > 0) });
      } catch {
        if (!controller.signal.aborted) setState({ status: 'failed' });
      }
    })();
    return () => {
      controller.abort();
      database?.close();
    };
  }, [path, loadBytes]);

  if (state.status === 'loading') return <ContentLoadingState label={t('filesView.artifact.state.loading')} />;
  if (state.status === 'failed') return <BinaryArtifact name={name} path={path} sizeBytes={sizeBytes} download={actions} description={t('filesView.artifact.data.unreadable')} />;
  if (state.status === 'sqlite') return <SqliteView path={path} database={state.database} sizeBytes={sizeBytes} status={state.staleWal ? t('filesView.artifact.data.walPending') : undefined} />;
  return (
    <TableGrid
      tableId={path}
      header={state.table.columns}
      rows={state.table.rows}
      columnCount={state.table.columns.length}
      totalRows={state.table.totalRows}
      sizeBytes={sizeBytes}
      commentTarget={{ fileLabel: path }}
    />
  );
};
