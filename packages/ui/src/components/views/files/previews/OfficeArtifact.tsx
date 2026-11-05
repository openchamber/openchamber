import React from 'react';
import { z } from 'zod';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { ContentLoadingState, ContentState } from '@/components/ui/content-state';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/lib/i18n';
import { openExternalUrl } from '@/lib/url';
import { toast } from '@/components/ui';
import { ArtifactMetaBar } from './ArtifactMetaBar';
import { BinaryArtifact } from './BinaryArtifact';
import { formatArtifactSize } from './artifactMeta';
import type { OfficePreview } from './officeDocument';
import { DEFAULT_TABLE_ROW_CAP } from './delimitedText';
import { isOpenableLink, OFFICE_LINK_MESSAGE } from './officeFrame';
import { TableGrid, type TableEditing } from './TableArtifact';
import { cellKey, type BookSheet, type CellValue, type WorkbookDocument } from './workbook/model';
import { cellInput, sheetGrid, WorkbookSession, type EditOutcome, type LoadEngineModel } from './workbook/workbookSession';

const MAX_UNDO = 100;
const officeLinkMessage = z.object({ type: z.literal(OFFICE_LINK_MESSAGE), url: z.string() });

type ReadPreview = (name: string, bytes: Uint8Array<ArrayBuffer>) => Promise<OfficePreview | null>;

const readWithRenderers: ReadPreview = async (name, bytes) => (await import('./officeDocument')).readOfficePreview(name, bytes);

const loadEngine: LoadEngineModel = async () => (await import('./workbook/ironcalc')).loadIronCalc();

type LoadState =
  | { status: 'loading' }
  | { status: 'read-failed' }
  | { status: 'unreadable' }
  | { status: 'ready'; preview: OfficePreview };

type SaveStatus = 'idle' | 'saving' | 'saved' | 'failed';
type CellEdit = { sheet: number; row: number; column: number; value: CellValue | null };

const sameBytes = (left: Uint8Array, right: Uint8Array): boolean => (
  left.byteLength === right.byteLength && left.every((value, index) => value === right[index])
);

/** A first row of nothing but text names the columns, so it stays on top of a sort. */
const hasHeadingRow = (sheet: BookSheet, rows: number): boolean => {
  if (rows < 2) return false;
  const first = Array.from(sheet.cells.values()).filter((cell) => cell.row === 1);
  return first.length > 1 && first.every((cell) => cell.kind === 'text' && !cell.formula);
};

const hyperlinkFormula = (formula: string | undefined): string | undefined => formula?.match(/^HYPERLINK\(\s*"([^"]+)"/i)?.[1];

const WorkbookView: React.FC<{
  name: string;
  path: string;
  document: WorkbookDocument;
  bytes: Uint8Array<ArrayBuffer>;
  sizeBytes: number | null;
  readBytes: () => Promise<Uint8Array<ArrayBuffer>>;
  /** Absent where the file cannot be written. */
  onSave?: (bytes: Uint8Array<ArrayBuffer>) => Promise<boolean>;
  onChangedOnDisk: () => void;
  loadModel?: LoadEngineModel;
}> = ({ name, path, document, bytes, sizeBytes, readBytes, onSave, onChangedOnDisk, loadModel = loadEngine }) => {
  const { t } = useI18n();
  const [session] = React.useState(() => new WorkbookSession(document, name, bytes, loadModel));
  const [selected, setSelected] = React.useState(0);
  const [version, setVersion] = React.useState(0);
  const [saveStatus, setSaveStatus] = React.useState<SaveStatus>('idle');
  const onDisk = React.useRef(bytes);
  const queue = React.useRef<Promise<void>>(Promise.resolve());
  const undoStack = React.useRef<CellEdit[]>([]);
  const redoStack = React.useRef<CellEdit[]>([]);

  const sheet = session.document.sheets[selected] ?? session.document.sheets[0];
  const editable = Boolean(onSave) && !sheet.protected;
  const grid = React.useMemo(
    () => sheetGrid(sheet, DEFAULT_TABLE_ROW_CAP, editable),
    // `version` stands for the cells of this sheet, which change in place.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sheet, editable, version],
  );
  React.useEffect(() => {
    queue.current = queue.current.then(async () => {
      if (await session.fillMissingResults().catch(() => false)) setVersion((value) => value + 1);
    });
  }, [session]);

  const cellAt = (row: number, column: number) => sheet.cells.get(cellKey(grid.rowNumbers[row], column));

  const persist = async (next: Uint8Array<ArrayBuffer>): Promise<boolean> => {
    if (!onSave) return false;
    setSaveStatus('saving');
    try {
      const current = await readBytes();
      if (!sameBytes(current, onDisk.current)) {
        toast.error(t('filesView.artifact.office.changedOnDisk'));
        onChangedOnDisk();
        return false;
      }
      if (!await onSave(next)) throw new Error('write failed');
      onDisk.current = next;
      setSaveStatus('saved');
      return true;
    } catch {
      setSaveStatus('failed');
      return false;
    }
  };

  // Everything that reads or changes the workbook, its history or the file
  // runs here in order, so a retry or an undo never overtakes an edit.
  const enqueue = (task: () => Promise<void>) => {
    queue.current = queue.current.then(task).catch(() => {
      // The session is back on the last good file, so the view must follow it.
      setSaveStatus('failed');
      setVersion((value) => value + 1);
    });
  };

  const finishEdit = async (outcome: EditOutcome, record: (previous: CellValue | null) => void) => {
    if (outcome.status === 'invalid-formula') toast.error(t('filesView.artifact.office.invalidFormula'));
    if (outcome.status !== 'changed') return;
    record(outcome.previous);
    setVersion((value) => value + 1);
    await persist(outcome.bytes);
  };

  const stepHistory = (from: React.RefObject<CellEdit[]>, to: React.RefObject<CellEdit[]>) => {
    enqueue(async () => {
      const edit = from.current.pop();
      if (!edit) return;
      setSelected(edit.sheet);
      await finishEdit(await session.restore(edit.sheet, edit.row, edit.column, edit.value), (value) => to.current.push({ ...edit, value }));
    });
  };

  const editing: TableEditing | undefined = editable ? {
    canEdit: (row, column) => row >= 0 && !session.isLocked(selected, grid.rowNumbers[row], column),
    inputOf: (row, column) => cellInput(cellAt(row, column)),
    commit: (row, column, input) => {
      const target = { sheet: selected, row: grid.rowNumbers[row], column };
      enqueue(async () => {
        await finishEdit(await session.edit(target.sheet, target.row, target.column, input), (value) => {
          redoStack.current = [];
          undoStack.current.push({ ...target, value });
          if (undoStack.current.length > MAX_UNDO) undoStack.current.shift();
        });
      });
    },
    undo: () => stepHistory(undoStack, redoStack),
    redo: () => stepHistory(redoStack, undoStack),
  } : undefined;

  const statusText = saveStatus === 'idle' ? '' : t(`filesView.artifact.office.${saveStatus}`);
  const pending = session.unsupportedFormulas;
  const pendingText = pending === 0 ? '' : t(pending === 1 ? 'filesView.artifact.office.externalResultsSingle' : 'filesView.artifact.office.externalResultsPlural', { count: pending });

  return (
    <TableGrid
      key={selected}
      tableId={`${path}#${sheet.name}`}
      header={grid.header}
      rows={grid.rows}
      rowLabels={grid.rowNumbers}
      columnCount={grid.columnCount}
      dataColumnCount={grid.dataColumnCount}
      totalRows={grid.totalRows}
      sizeBytes={sizeBytes}
      pinnedRows={hasHeadingRow(sheet, grid.rows.length) ? 1 : 0}
      hrefOf={(row, column) => {
        const cell = cellAt(row, column);
        return cell?.href ?? hyperlinkFormula(cell?.formula);
      }}
      editing={editing}
      describeCell={(row, column) => {
        const reference = `${grid.header[column]}${grid.rowNumbers[row]}`;
        if (session.isLocked(selected, grid.rowNumbers[row], column)) return `${reference} ${t('filesView.artifact.office.locked')}`;
        const formula = cellAt(row, column)?.formula;
        return formula ? `${reference} =${formula}` : reference;
      }}
      status={[statusText, pendingText].filter(Boolean).join(' · ')}
      actions={(
        <>
          {saveStatus === 'failed' ? (
            <Button type="button" variant="outline" size="sm" onClick={() => enqueue(async () => { await persist(session.currentBytes); })}>
              {t('filesView.artifact.state.retry')}
            </Button>
          ) : null}
          {session.document.sheets.length > 1 ? (
            <Select value={String(selected)} onValueChange={(value) => setSelected(Number(value))}>
              <SelectTrigger className="w-fit max-w-48" aria-label={t('filesView.artifact.office.sheet')}>
                <SelectValue>{sheet.name}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {session.document.sheets.map((entry, index) => (
                  <SelectItem key={index} value={String(index)}>{entry.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
        </>
      )}
    />
  );
};

/**
 * A Word, Excel or PowerPoint document, or its OpenDocument counterpart, as a
 * read-only preview. The bytes are read through the runtime's transport, so it
 * works wherever the file can be read, relay and phones included, and a file
 * that cannot be drawn says so and keeps its download.
 */
export const OfficeArtifact: React.FC<{
  name: string;
  path: string;
  sizeBytes: number | null;
  loadBytes: (path: string, signal: AbortSignal) => Promise<Uint8Array<ArrayBuffer>>;
  actions?: React.ReactNode;
  /** Writes an edited workbook; absent where the file cannot be written. */
  onSave?: (path: string, bytes: Uint8Array<ArrayBuffer>) => Promise<boolean>;
  /** Replaced in tests; load the renderers and the formula engine on first use. */
  readPreview?: ReadPreview;
  loadModel?: LoadEngineModel;
}> = ({ name, path, sizeBytes, loadBytes, actions, onSave, readPreview = readWithRenderers, loadModel }) => {
  const { t } = useI18n();
  const [state, setState] = React.useState<LoadState>({ status: 'loading' });
  const [attempt, setAttempt] = React.useState(0);
  const frameRef = React.useRef<HTMLIFrameElement>(null);

  // The frame has no way out, so its links arrive here, from that frame only.
  React.useEffect(() => {
    const onMessage = (event: MessageEvent<unknown>) => {
      const frame = frameRef.current;
      if (!frame || event.source !== frame.contentWindow) return;
      const link = officeLinkMessage.safeParse(event.data);
      if (link.success && isOpenableLink(link.data.url)) void openExternalUrl(link.data.url);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  React.useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    setState({ status: 'loading' });
    void (async () => {
      let bytes: Uint8Array<ArrayBuffer>;
      try {
        bytes = await loadBytes(path, signal);
      } catch {
        if (!signal.aborted) setState({ status: 'read-failed' });
        return;
      }
      if (signal.aborted) return;
      try {
        const preview = await readPreview(name, bytes);
        if (!signal.aborted) setState(preview ? { status: 'ready', preview } : { status: 'unreadable' });
      } catch {
        if (!signal.aborted) setState({ status: 'unreadable' });
      }
    })();
    return () => controller.abort();
  }, [name, path, loadBytes, readPreview, attempt]);

  if (state.status === 'loading') {
    return <ContentLoadingState label={t('filesView.artifact.state.loading')} />;
  }
  if (state.status === 'read-failed') {
    return (
      <ContentState
        icon={<Icon name="error-warning" className="size-10 text-[color:var(--status-error)]" />}
        title={t('filesView.artifact.state.readFailed', { name })}
        actions={(
          <Tooltip>
            <TooltipTrigger asChild>
              <Button type="button" variant="outline" size="sm" onClick={() => setAttempt((value) => value + 1)}>
                <Icon name="refresh" className="me-2 size-4" />
                {t('filesView.artifact.state.retry')}
              </Button>
            </TooltipTrigger>
            <TooltipContent sideOffset={6}>{t('contextTooltips.files.retryFile')}</TooltipContent>
          </Tooltip>
        )}
      />
    );
  }
  if (state.status === 'unreadable') {
    return (
      <BinaryArtifact
        name={name}
        path={path}
        sizeBytes={sizeBytes}
        download={actions}
        description={t('filesView.artifact.office.unreadable')}
      />
    );
  }

  const { preview } = state;
  if (preview.kind === 'workbook') {
    return (
      <WorkbookView
        name={name}
        path={path}
        document={preview.document}
        bytes={preview.bytes}
        sizeBytes={sizeBytes}
        readBytes={() => loadBytes(path, AbortSignal.timeout(60_000))}
        onSave={onSave ? (next) => onSave(path, next) : undefined}
        onChangedOnDisk={() => setAttempt((value) => value + 1)}
        loadModel={loadModel}
      />
    );
  }
  const slides = preview.slideCount === null
    ? ''
    : t(preview.slideCount === 1 ? 'filesView.artifact.office.slidesSingle' : 'filesView.artifact.office.slidesPlural', { slides: preview.slideCount });
  return (
    <div className="flex h-full min-h-0 flex-col">
      <ArtifactMetaBar items={[slides, formatArtifactSize(sizeBytes)]} />
      <div className="min-h-0 flex-1 bg-[var(--surface-background)]">
        {/* `color-scheme: normal` keeps the frame see-through under a dark theme. */}
        <iframe
          ref={frameRef}
          srcDoc={preview.html}
          sandbox="allow-scripts"
          title={name}
          className="block h-full w-full border-0"
          style={{ colorScheme: 'normal' }}
        />
      </div>
    </div>
  );
};
