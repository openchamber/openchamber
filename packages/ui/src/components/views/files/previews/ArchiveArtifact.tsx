import React from 'react';
import { unzip, unzipSync, type UnzipFileInfo } from 'fflate';

import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { ContentLoadingState, ContentState } from '@/components/ui/content-state';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { useI18n } from '@/lib/i18n';
import { getFileExtension, getImageMimeType, isImageFile, looksLikeBinaryText } from '@/lib/toolHelpers';
import { BinaryArtifact } from './BinaryArtifact';
import { ArtifactMetaBar } from './ArtifactMetaBar';
import { formatArtifactSize } from './artifactMeta';

const MAX_ENTRY_BYTES = 25 * 1024 * 1024;
const MAX_TEXT_CHARS = 2_000_000;

type Entry = { name: string; size: number };
type Opened = { entry: Entry; kind: 'text'; text: string } | { entry: Entry; kind: 'image'; url: string } | { entry: Entry; kind: 'binary'; url: string };

const unzipWith = (data: Uint8Array, filter: (info: UnzipFileInfo) => boolean) => new Promise<Record<string, Uint8Array>>((resolve, reject) => {
  // Bun's browser-style Blob workers do not reliably run fflate's async path.
  if ('Bun' in globalThis) {
    resolve(unzipSync(data, { filter }));
    return;
  }
  unzip(data, { filter }, (error, result) => (error ? reject(error) : resolve(result)));
});

/** The entries an archive names, read without unpacking any. */
const listArchive = async (data: Uint8Array): Promise<Entry[]> => {
  const entries: Entry[] = [];
  await unzipWith(data, (info) => {
    if (!info.name.endsWith('/')) entries.push({ name: info.name, size: info.originalSize });
    return false;
  });
  return entries.sort((left, right) => left.name.localeCompare(right.name));
};

const readEntry = async (data: Uint8Array, entry: Entry): Promise<Opened> => {
  const bytes = (await unzipWith(data, (info) => info.name === entry.name))[entry.name];
  const blob = (type: string) => URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type }));
  if (isImageFile(entry.name) && getFileExtension(entry.name) !== 'svg') return { entry, kind: 'image', url: blob(getImageMimeType(entry.name)) };
  const text = new TextDecoder().decode(bytes.subarray(0, MAX_TEXT_CHARS));
  return looksLikeBinaryText(text) ? { entry, kind: 'binary', url: blob('application/octet-stream') } : { entry, kind: 'text', text };
};

/** A zip's files, opened one at a time in memory; nothing is written to disk. */
export const ArchiveArtifact: React.FC<{
  name: string;
  path: string;
  sizeBytes: number | null;
  loadBytes: (path: string, signal: AbortSignal) => Promise<Uint8Array<ArrayBuffer>>;
  actions?: React.ReactNode;
}> = ({ name, path, sizeBytes, loadBytes, actions }) => {
  const { t } = useI18n();
  const [state, setState] = React.useState<{ status: 'loading' } | { status: 'failed' } | { status: 'ready'; data: Uint8Array; entries: Entry[] }>({ status: 'loading' });
  const [opened, setOpened] = React.useState<Opened | null>(null);
  const [tooLarge, setTooLarge] = React.useState(false);

  React.useEffect(() => {
    const controller = new AbortController();
    void loadBytes(path, controller.signal)
      .then(async (data) => setState({ status: 'ready', data, entries: await listArchive(data) }))
      .catch(() => {
        if (!controller.signal.aborted) setState({ status: 'failed' });
      });
    return () => controller.abort();
  }, [path, loadBytes]);

  React.useEffect(() => () => {
    if (opened && opened.kind !== 'text') URL.revokeObjectURL(opened.url);
  }, [opened]);

  if (state.status === 'loading') return <ContentLoadingState label={t('filesView.artifact.state.loading')} />;
  if (state.status === 'failed') return <BinaryArtifact name={name} path={path} sizeBytes={sizeBytes} download={actions} description={t('filesView.artifact.archive.unreadable')} />;

  const open = (entry: Entry) => {
    setTooLarge(entry.size > MAX_ENTRY_BYTES);
    if (entry.size > MAX_ENTRY_BYTES) {
      setOpened(null);
      return;
    }
    void readEntry(state.data, entry).then(setOpened).catch(() => setTooLarge(true));
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ArtifactMetaBar
        items={[t('filesView.artifact.archive.files', { count: state.entries.length }), formatArtifactSize(sizeBytes), opened?.entry.name ?? '']}
        actions={opened ? (
          <Button type="button" variant="ghost" size="sm" aria-label={t('filesView.artifact.archive.back')} title={t('filesView.artifact.archive.back')} onClick={() => setOpened(null)}>
            <Icon name="arrow-left" className="size-4" />
          </Button>
        ) : actions}
      />
      {tooLarge ? <div className="p-3 typography-ui text-muted-foreground">{t('filesView.artifact.archive.entryTooLarge')}</div> : null}
      <ScrollableOverlay outerClassName="min-h-0 flex-1">
        {!opened ? (
          <ul className="flex flex-col p-1">
            {state.entries.map((entry) => (
              <li key={entry.name}>
                <button type="button" className="flex w-full min-w-0 items-center gap-2 rounded px-2 py-1 text-start typography-ui hover:bg-[var(--interactive-hover)]" onClick={() => open(entry)}>
                  <FileTypeIcon filePath={entry.name} className="size-4 shrink-0" />
                  <span className="min-w-0 flex-1 truncate" dir="auto">{entry.name}</span>
                  <span className="shrink-0 typography-meta text-muted-foreground">{formatArtifactSize(entry.size)}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : opened.kind === 'text' ? (
          <pre className="whitespace-pre-wrap p-3 font-mono typography-meta text-foreground" dir="ltr">{opened.text}</pre>
        ) : opened.kind === 'image' ? (
          <img alt={opened.entry.name} src={opened.url} className="m-3 max-w-full" />
        ) : (
          <ContentState
            title={opened.entry.name}
            actions={(
              <Button type="button" variant="outline" size="sm" onClick={() => Object.assign(document.createElement('a'), { href: opened.url, download: opened.entry.name.split('/').pop() }).click()}>
                {t('filesView.editor.saveFile')}
              </Button>
            )}
          />
        )}
      </ScrollableOverlay>
    </div>
  );
};
