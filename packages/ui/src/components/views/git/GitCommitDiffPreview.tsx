import React from 'react';
import { Button } from '@/components/ui/button';
import { DiffView } from '@/components/views/DiffView';
import { useI18n } from '@/lib/i18n';
import type {
  GitCommitDetailsController as GitCommitPreviewController,
} from './gitCommitDetailsController';

interface GitCommitDiffPreviewProps {
  controller: GitCommitPreviewController;
  announceOverlayOpen: boolean;
}

type PreviewSnapshot = ReturnType<GitCommitPreviewController['getPreviewSnapshot']>;
type ReadyPreviewSnapshot = Extract<PreviewSnapshot, { status: 'ready' }>;

const formatPreviewBytes = (bytes: number): string => {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${bytes} B`;
};

const isPresentObjectId = (value: string | null | undefined): value is string => value !== null && value !== undefined && value.trim() !== '';

const renderObjectIds = (values: Array<string | null | undefined>) => {
  const presentValues = values.filter(isPresentObjectId);
  if (presentValues.length === 0) {
    return null;
  }

  return (
    <div className="mt-3 flex flex-wrap gap-2 text-xs text-muted-foreground">
      {presentValues.map((value) => (
        <code key={value} className="rounded bg-muted/70 px-2 py-1 font-mono text-foreground">
          {value}
        </code>
      ))}
    </div>
  );
};

const ReadySnapshotDiffView: React.FC<{ snapshot: ReadyPreviewSnapshot }> = React.memo(({ snapshot }) => {
  const file = snapshot.file;
  const snapshotSource = React.useMemo(() => ({
    directory: snapshot.comparison.directory,
    files: [{
      path: file.path,
      status: file.status,
      insertions: file.insertions,
      deletions: file.deletions,
      isBinary: file.isBinary,
      original: snapshot.original ?? '',
      modified: snapshot.modified ?? '',
    }],
  }), [
    file.deletions,
    file.insertions,
    file.isBinary,
    file.path,
    file.status,
    snapshot.comparison.directory,
    snapshot.modified,
    snapshot.original,
  ]);

  return (
    <DiffView
      snapshotSource={snapshotSource}
      hideStackedFileSidebar
      showOpenInEditorAction={false}
      flushContent
    />
  );
});

export const GitCommitDiffPreview: React.FC<GitCommitDiffPreviewProps> = ({
  controller,
  announceOverlayOpen,
}) => {
  const { t } = useI18n();

  const subscribe = React.useCallback((listener: () => void) => controller.subscribePreview(listener), [controller]);
  const getSnapshot = React.useCallback(() => controller.getPreviewSnapshot(), [controller]);
  const snapshot = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  if (snapshot.status === 'idle') {
    return null;
  }

  const file = snapshot.file;

  return (
    <section
      id="git-commit-diff-preview"
      data-git-commit-diff-preview="true"
      data-announce-open={announceOverlayOpen ? 'true' : 'false'}
      className="flex h-full min-h-0 flex-col rounded-xl border border-border/60 bg-[var(--surface-elevated)]"
    >
      {announceOverlayOpen ? (
        <p
          data-git-commit-diff-preview-announcement="true"
          role="status"
          aria-live="polite"
          className="sr-only"
        >
          {t('gitView.preview.overlayAnnouncement')}
        </p>
      ) : null}

      <div className="flex min-h-0 flex-1 flex-col gap-3">
        {snapshot.status === 'loading' ? (
          <div className="rounded-lg border border-dashed border-border/60 bg-[var(--surface-background)] px-3 py-2 text-sm text-muted-foreground">
            {t('gitView.history.loadingDiff')}
          </div>
        ) : null}

        {snapshot.status === 'binary' ? (
          <div className="rounded-lg border border-border/60 bg-[var(--surface-background)] px-3 py-3 text-sm text-muted-foreground">
            <p className="font-medium text-foreground">{t('filesView.editor.cannotPreviewBinary')}</p>
            {renderObjectIds([file.originalObjectId, file.objectId])}
          </div>
        ) : null}

        {snapshot.status === 'gitlink' ? (
          <div className="rounded-lg border border-border/60 bg-[var(--surface-background)] px-3 py-3 text-sm text-muted-foreground">
            <p className="font-medium text-foreground">{t('gitView.preview.submodulePointer')}</p>
            {renderObjectIds([snapshot.originalObjectId, snapshot.objectId])}
          </div>
        ) : null}

        {snapshot.status === 'confirm-large' ? (
          <div className="rounded-lg border border-border/60 bg-[var(--surface-background)] px-3 py-3 text-sm text-muted-foreground">
            <p className="font-medium text-foreground">{t('gitView.history.largeDiffTitle', { count: snapshot.changedLines })}</p>
            <p className="mt-1">{t('gitView.history.largeDiffDescription')}</p>
            <Button type="button" size="xs" variant="ghost" className="mt-3 px-0 text-primary hover:bg-transparent hover:underline" onClick={() => controller.confirmLargePreview()}>
              {t('gitView.history.renderDiffAnyway')}
            </Button>
          </div>
        ) : null}

        {snapshot.status === 'too-large' ? (
          <div className="rounded-lg border border-border/60 bg-[var(--surface-background)] px-3 py-3 text-sm text-muted-foreground">
            <p className="font-medium text-foreground">{t('gitView.integrate.previewUnavailable')}</p>
            <p className="mt-1">
              {t('gitView.preview.tooLargeDescription', {
                totalSize: formatPreviewBytes(snapshot.totalBytes),
                maxSize: formatPreviewBytes(snapshot.maxBytes),
              })}
            </p>
          </div>
        ) : null}

        {snapshot.status === 'error' ? (
          <div className="rounded-lg border border-[var(--status-error-border)]/60 bg-[var(--status-error-background)]/20 px-3 py-3 text-sm text-[var(--status-error-foreground)]">
            <p>{t('gitView.history.diffError')}</p>
            <Button type="button" size="xs" variant="outline" className="mt-3" onClick={() => controller.retryPreview()}>
              {t('diffView.actions.retry')}
            </Button>
          </div>
        ) : null}

        {snapshot.status === 'ready' ? (
          <ReadySnapshotDiffView snapshot={snapshot} />
        ) : null}
      </div>
    </section>
  );
};
