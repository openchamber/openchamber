import React from 'react';
import { z } from 'zod';

import { QuoteCommentMenu } from '@/components/comments/QuoteCommentMenu';
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
import { isOpenableLink, OFFICE_LINK_MESSAGE, OFFICE_SELECTION_MESSAGE } from './officeFrame';
import { TableGrid, type TableEditing } from './TableArtifact';
import { cellKey, type StructureChange } from './workbook/model';
import { patchSheetView, type SheetView, type WorkbookBook } from './documentClient';
import type { BookChange, BookEdit } from './documentProtocol';
import type { CellRestore } from './workbook/workbookSession';

const MAX_UNDO = 100;
const officeFrameMessage = z.discriminatedUnion('type', [
  z.object({ type: z.literal(OFFICE_LINK_MESSAGE), url: z.string() }),
  z.object({
    type: z.literal(OFFICE_SELECTION_MESSAGE),
    text: z.string(),
    place: z.string(),
    x: z.number(),
    y: z.number(),
  }),
]);

type ReadPreview = (name: string, path: string, bytes: Uint8Array<ArrayBuffer>) => Promise<OfficePreview | null>;

const readWithRenderers: ReadPreview = async (name, path, bytes) => (await import('./officeDocument')).readOfficePreview(name, path, bytes);

type LoadState =
  | { status: 'loading' }
  | { status: 'read-failed' }
  | { status: 'unreadable' }
  | { status: 'ready'; preview: OfficePreview };

type SaveStatus = 'idle' | 'saving' | 'saved' | 'failed';
type CellEdit = { sheet: number; cells: CellRestore[] } | { sheet: number; bytes: Uint8Array<ArrayBuffer> };

const sameBytes = (left: Uint8Array, right: Uint8Array): boolean => {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.length; index += 1) if (left[index] !== right[index]) return false;
  return true;
};

const hyperlinkFormula = (formula: string | undefined): string | undefined => formula?.match(/^HYPERLINK\(\s*"([^"]+)"/i)?.[1];

const WorkbookView: React.FC<{
  path: string;
  book: WorkbookBook;
  bytes: Uint8Array<ArrayBuffer>;
  sizeBytes: number | null;
  readBytes: () => Promise<Uint8Array<ArrayBuffer>>;
  /** Absent where the file cannot be written. */
  onSave?: (bytes: Uint8Array<ArrayBuffer>) => Promise<boolean>;
  onChangedOnDisk: () => void;
  /** Stays with the owner, who closes the book only once this has drained. */
  queue: React.RefObject<Promise<void>>;
}> = ({ path, book, bytes, sizeBytes, readBytes, onSave, onChangedOnDisk, queue }) => {
  const { t } = useI18n();
  const { sheets } = book.opened;
  const [selected, setSelected] = React.useState(0);
  const [view, setView] = React.useState<SheetView | null>(null);
  const [layoutRevision, setLayoutRevision] = React.useState(0);
  const [layoutFailed, setLayoutFailed] = React.useState(false);
  const [unsupported, setUnsupported] = React.useState(book.opened.unsupported);
  const [saveStatus, setSaveStatus] = React.useState<SaveStatus>('idle');
  const onDisk = React.useRef(bytes);
  const latest = React.useRef(bytes);
  const undoStack = React.useRef<CellEdit[]>([]);
  const redoStack = React.useRef<CellEdit[]>([]);
  const [changedCells, setChangedCells] = React.useState<ReadonlySet<string>>(() => new Set(book.opened.unseen));

  const sheet = sheets[selected] ?? sheets[0];
  const editable = Boolean(onSave) && !sheet.protected;
  // Changes arrive between renders, and the cells they name must meet the view of now.
  const viewRef = React.useRef<SheetView | null>(null);
  const showView = (next: SheetView) => {
    viewRef.current = next;
    setView(next);
  };

  React.useEffect(() => {
    let current = true;
    void book.layout(selected, editable).then((next) => {
      if (current) showView(next);
    }, () => {
      if (current) setLayoutFailed(true);
    });
    return () => {
      current = false;
    };
  }, [book, selected, editable, layoutRevision]);

  const reloadView = () => setLayoutRevision((value) => value + 1);

  // A pasted block can run past the last row on screen.
  const rowNumberOf = (row: number) => (view
    ? view.rowNumbers[row] ?? (view.rowNumbers.at(-1) ?? 0) + row - view.rowNumbers.length + 1
    : 0);
  const noteAt = (row: number, column: number) => (view ? view.notes.get(cellKey(view.rowNumbers[row], column)) : undefined);

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
      reloadView();
    });
  };

  const applyChange = async ({ bytes: next, patches, unsupported: count }: BookChange) => {
    setUnsupported(count);
    latest.current = next;
    const updated = viewRef.current && patches ? patchSheetView(viewRef.current, patches) : null;
    if (updated) showView(updated);
    else reloadView();
    await persist(next);
  };

  const finishEdit = async (outcome: BookEdit, record: (previous: CellRestore[]) => void) => {
    if (outcome.status === 'invalid-formula') toast.error(t('filesView.artifact.office.invalidFormula'));
    if (outcome.status !== 'changed') {
      // What was typed already shows, so the sheet has to say what it holds.
      reloadView();
      return;
    }
    record(outcome.previous);
    await applyChange(outcome);
  };

  const stepHistory = (from: React.RefObject<CellEdit[]>, to: React.RefObject<CellEdit[]>) => {
    enqueue(async () => {
      const edit = from.current.pop();
      if (!edit) return;
      setSelected(edit.sheet);
      if ('bytes' in edit) {
        const { previousBytes, ...change } = await book.restoreBytes(edit.bytes);
        to.current.push({ sheet: edit.sheet, bytes: previousBytes });
        await applyChange(change);
        return;
      }
      await finishEdit(await book.restore(edit.sheet, edit.cells), (cells) => to.current.push({ sheet: edit.sheet, cells }));
    });
  };

  const restructure = (change: StructureChange) => {
    enqueue(async () => {
      const { previousBytes, ...outcome } = await book.restructure(change);
      redoStack.current = [];
      undoStack.current.push({ sheet: change.sheet, bytes: previousBytes });
      await applyChange(outcome);
    });
  };

  const isLocked = (row: number, column: number) => sheet.protected || Boolean(view?.lockedCells.has(cellKey(rowNumberOf(row), column)));

  const editing: TableEditing | undefined = editable && view ? {
    canEdit: (row, column) => row >= 0 && !isLocked(row, column),
    inputOf: (row, column) => noteAt(row, column)?.input ?? view.rows[row]?.[column] ?? '',
    commit: (cells) => {
      const sheetIndex = selected;
      const inputs = cells.map(({ row, column, input }) => ({ row: rowNumberOf(row), column, input }));
      // Proving a write reads the whole file back, so what was typed shows first.
      const typed = patchSheetView(view, inputs.map(({ row, column, input }) => ({
        sheet: sheetIndex,
        row,
        column,
        display: input,
        note: view.notes.get(cellKey(row, column)) ?? null,
      })), true);
      if (typed) showView(typed);
      enqueue(async () => {
        await finishEdit(await book.edit(sheetIndex, inputs), (previous) => {
          redoStack.current = [];
          undoStack.current.push({ sheet: sheetIndex, cells: previous });
          if (undoStack.current.length > MAX_UNDO) undoStack.current.shift();
        });
      });
    },
    undo: () => stepHistory(undoStack, redoStack),
    redo: () => stepHistory(redoStack, undoStack),
    structure: view.canRestructure ? {
      insertRow: (row) => restructure({ sheet: selected, axis: 'row', at: rowNumberOf(row), delta: 1 }),
      deleteRow: (row) => restructure({ sheet: selected, axis: 'row', at: rowNumberOf(row), delta: -1 }),
      insertColumn: (column) => restructure({ sheet: selected, axis: 'column', at: column, delta: 1 }),
      deleteColumn: (column) => restructure({ sheet: selected, axis: 'column', at: column, delta: -1 }),
    } : undefined,
  } : undefined;

  const gridChanges = React.useMemo(() => {
    const shown = new Set<string>();
    if (!view || changedCells.size === 0) return shown;
    for (let row = 0; row < view.rowNumbers.length; row += 1) {
      for (let column = 0; column < view.columnCount; column += 1) {
        if (changedCells.has(`${selected}:${cellKey(view.rowNumbers[row], column)}`)) shown.add(`${row}:${column}`);
      }
    }
    return shown;
  }, [view, changedCells, selected]);

  const statusText = saveStatus === 'idle' ? '' : t(`filesView.artifact.office.${saveStatus}`);
  const pendingText = unsupported === 0 ? '' : t(unsupported === 1 ? 'filesView.artifact.office.externalResultsSingle' : 'filesView.artifact.office.externalResultsPlural', { count: unsupported });

  if (layoutFailed) {
    return (
      <ContentState
        title={t('filesView.artifact.office.unreadable')}
        actions={<Button type="button" variant="outline" size="sm" onClick={onChangedOnDisk}>{t('filesView.artifact.state.retry')}</Button>}
      />
    );
  }
  if (!view || view.sheet !== selected) return <ContentLoadingState label={t('filesView.artifact.state.loading')} />;

  return (
    <TableGrid
      key={selected}
      tableId={`${path}#${sheet.name}`}
      header={view.header}
      rows={view.rows}
      rowLabels={view.rowNumbers}
      columnCount={view.columnCount}
      dataColumnCount={view.dataColumnCount}
      totalRows={view.totalRows}
      sizeBytes={sizeBytes}
      pinnedRows={view.headingRow ? 1 : 0}
      hrefOf={(row, column) => {
        const note = noteAt(row, column);
        return note?.href ?? hyperlinkFormula(note?.formula);
      }}
      editing={editing}
      changedCells={gridChanges}
      onSeen={(keys) => {
        void book.seen(keys.map((key) => {
          const [row, column] = key.split(':').map(Number);
          return `${selected}:${cellKey(view.rowNumbers[row], column)}`;
        })).then((unseen) => setChangedCells(new Set(unseen)));
      }}
      commentTarget={{ fileLabel: path, place: sheets.length > 1 ? `Sheet "${sheet.name}"` : undefined }}
      describeCell={(row, column) => {
        const reference = `${view.header[column]}${view.rowNumbers[row]}`;
        if (isLocked(row, column)) return `${reference} ${t('filesView.artifact.office.locked')}`;
        const formula = noteAt(row, column)?.formula;
        return formula ? `${reference} =${formula}` : reference;
      }}
      status={[statusText, pendingText].filter(Boolean).join(' · ')}
      statusHint={unsupported === 0 ? undefined : t('filesView.artifact.office.externalResultsHint')}
      actions={(
        <>
          {saveStatus === 'failed' ? (
            <Button type="button" variant="outline" size="sm" onClick={() => enqueue(async () => { await persist(latest.current); })}>
              {t('filesView.artifact.state.retry')}
            </Button>
          ) : null}
          {sheets.length > 1 ? (
            <Select value={String(selected)} onValueChange={(value) => setSelected(Number(value))}>
              <SelectTrigger className="w-fit max-w-48" aria-label={t('filesView.artifact.office.sheet')}>
                <SelectValue>{sheet.name}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {sheets.map((entry, index) => (
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
  /** Replaced in tests; loads the renderers on first use. */
  readPreview?: ReadPreview;
}> = ({ name, path, sizeBytes, loadBytes, actions, onSave, readPreview = readWithRenderers }) => {
  const { t } = useI18n();
  const [state, setState] = React.useState<LoadState>({ status: 'loading' });
  const [attempt, setAttempt] = React.useState(0);
  const work = React.useRef<Promise<void>>(Promise.resolve());
  const frameRef = React.useRef<HTMLIFrameElement>(null);
  const [selection, setSelection] = React.useState<{ quote: string; x: number; y: number } | null>(null);
  const closeSelection = React.useCallback(() => setSelection(null), []);

  // The frame has no way out, so its links arrive here, from that frame only.
  React.useEffect(() => {
    const onMessage = (event: MessageEvent<unknown>) => {
      const frame = frameRef.current;
      if (!frame || event.source !== frame.contentWindow) return;
      const message = officeFrameMessage.safeParse(event.data);
      if (!message.success) return;
      if (message.data.type === OFFICE_LINK_MESSAGE) {
        if (isOpenableLink(message.data.url)) void openExternalUrl(message.data.url);
        return;
      }
      const { text, place, x, y } = message.data;
      const box = frame.getBoundingClientRect();
      setSelection(text ? { quote: place ? `${place}:\n${text}` : text, x: box.left + x, y: box.top + Math.max(0, y) - 10 } : null);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  React.useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    let book: WorkbookBook | undefined;
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
        const preview = await readPreview(name, path, bytes);
        if (preview?.kind === 'workbook') book = preview.book;
        if (signal.aborted) book?.close();
        else setState(preview ? { status: 'ready', preview } : { status: 'unreadable' });
      } catch {
        if (!signal.aborted) setState({ status: 'unreadable' });
      }
    })();
    return () => {
      controller.abort();
      // An edit may still be on its way to the file.
      void work.current.finally(() => book?.close());
    };
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
        path={path}
        book={preview.book}
        bytes={preview.bytes}
        sizeBytes={sizeBytes}
        readBytes={() => loadBytes(path, AbortSignal.timeout(60_000))}
        onSave={onSave ? (next) => onSave(path, next) : undefined}
        onChangedOnDisk={() => setAttempt((value) => value + 1)}
        queue={work}
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
      {selection ? (
        <QuoteCommentMenu
          key={selection.quote}
          anchor={selection}
          quote={selection.quote}
          fileLabel={path}
          onClose={closeSelection}
        />
      ) : null}
    </div>
  );
};
