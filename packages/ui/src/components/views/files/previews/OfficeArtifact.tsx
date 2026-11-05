import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { ContentLoadingState, ContentState } from '@/components/ui/content-state';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/lib/i18n';
import type { WorkbookSheet } from '@/sync/document-attachments';
import { columnName } from '@/sync/document-attachments';
import { ArtifactMetaBar } from './ArtifactMetaBar';
import { BinaryArtifact } from './BinaryArtifact';
import { formatArtifactSize } from './artifactMeta';
import type { OfficePreview } from './officeDocument';
import { TableGrid } from './TableArtifact';

type ReadPreview = (name: string, bytes: Uint8Array<ArrayBuffer>) => Promise<OfficePreview | null>;

const readWithRenderers: ReadPreview = async (name, bytes) => (await import('./officeDocument')).readOfficePreview(name, bytes);

type LoadState =
  | { status: 'loading' }
  | { status: 'read-failed' }
  | { status: 'unreadable' }
  | { status: 'ready'; preview: OfficePreview };

/** Row numbers and column letters, so a cell can be named the way the file names it. */
const sheetGrid = (sheet: WorkbookSheet) => ({
  header: ['', ...Array.from({ length: sheet.columnCount }, (_, column) => columnName(column))],
  rows: sheet.rows.map((row, index) => [String(sheet.rowNumbers[index]), ...row]),
});

const WorkbookView: React.FC<{ sheets: WorkbookSheet[]; sizeBytes: number | null }> = ({ sheets, sizeBytes }) => {
  const { t } = useI18n();
  const [selected, setSelected] = React.useState(0);
  const sheet = sheets[selected] ?? sheets[0];
  const grid = React.useMemo(() => sheetGrid(sheet), [sheet]);
  return (
    <TableGrid
      key={selected}
      header={grid.header}
      rows={grid.rows}
      columnCount={sheet.rows.length > 0 ? sheet.columnCount + 1 : 0}
      dataColumnCount={sheet.columnCount}
      totalRows={sheet.totalRows}
      sizeBytes={sizeBytes}
      actions={sheets.length > 1 ? (
        <Select value={String(selected)} onValueChange={(value) => setSelected(Number(value))}>
          <Tooltip>
            <TooltipTrigger asChild>
              <SelectTrigger className="w-fit max-w-48" aria-label={t('filesView.artifact.office.sheet')}>
                <SelectValue>{sheet.name}</SelectValue>
              </SelectTrigger>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={6}>{t('contextTooltips.files.chooseSheet')}</TooltipContent>
          </Tooltip>
          <SelectContent>
            {sheets.map((entry, index) => (
              <SelectItem key={index} value={String(index)}>{entry.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}
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
  loadBytes: (signal: AbortSignal) => Promise<Uint8Array<ArrayBuffer>>;
  actions?: React.ReactNode;
  /** Replaced in tests; loads the renderers on first use. */
  readPreview?: ReadPreview;
}> = ({ name, path, sizeBytes, loadBytes, actions, readPreview = readWithRenderers }) => {
  const { t } = useI18n();
  const [state, setState] = React.useState<LoadState>({ status: 'loading' });
  const [attempt, setAttempt] = React.useState(0);

  React.useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    setState({ status: 'loading' });
    void (async () => {
      let bytes: Uint8Array<ArrayBuffer>;
      try {
        bytes = await loadBytes(signal);
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
  }, [name, loadBytes, readPreview, attempt]);

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
  if (preview.kind === 'workbook') return <WorkbookView sheets={preview.sheets} sizeBytes={sizeBytes} />;
  const slides = preview.slideCount === null
    ? ''
    : t(preview.slideCount === 1 ? 'filesView.artifact.office.slidesSingle' : 'filesView.artifact.office.slidesPlural', { slides: preview.slideCount });
  return (
    <div className="flex h-full min-h-0 flex-col">
      <ArtifactMetaBar items={[slides, formatArtifactSize(sizeBytes)]} />
      <div className="min-h-0 flex-1 bg-[var(--surface-background)]">
        {/* `color-scheme: normal` keeps the frame see-through under a dark theme. */}
        <iframe
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
