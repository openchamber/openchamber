import React from 'react';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { PierreDiffViewer } from '@/components/views/PierreDiffViewer';
import { useI18n } from '@/lib/i18n';
import type { GitCommitChangedFile } from '@/lib/api/types';
import { getLanguageFromExtension } from '@/lib/toolHelpers';
import type {
  GitCommitDetailsController as GitCommitPreviewController,
} from './gitCommitDetailsController';

interface GitCommitDiffPreviewProps {
  controller: GitCommitPreviewController;
  closeMode: 'back' | 'close';
  autoFocusCloseButton: boolean;
  announceOverlayOpen: boolean;
}

const formatPreviewBytes = (bytes: number): string => {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${bytes} B`;
};

const getStatusLabelKey = (status: GitCommitChangedFile['status']) => {
  switch (status) {
    case 'A':
      return 'diffView.change.new';
    case 'D':
      return 'diffView.change.deleted';
    case 'R':
      return 'diffView.change.renamed';
    default:
      return 'diffView.change.modified';
  }
};

const renderDiffViewer = (file: GitCommitChangedFile, original: string, modified: string) => (
  <div className="min-h-0 flex-1 overflow-hidden rounded-lg border border-border/60 bg-[var(--surface-background)]">
    <PierreDiffViewer
      original={original}
      modified={modified}
      language={getLanguageFromExtension(file.path) || 'text'}
      fileName={file.path}
      renderSideBySide={false}
      layout="inline"
      enableComments={false}
    />
  </div>
);

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

export const GitCommitDiffPreview: React.FC<GitCommitDiffPreviewProps> = ({
  controller,
  closeMode,
  autoFocusCloseButton,
  announceOverlayOpen,
}) => {
  const { t } = useI18n();
  const subscribe = React.useCallback((listener: () => void) => controller.subscribePreview(listener), [controller]);
  const getSnapshot = React.useCallback(() => controller.getPreviewSnapshot(), [controller]);
  const snapshot = React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const closeButtonRef = React.useRef<HTMLButtonElement | null>(null);

  React.useLayoutEffect(() => {
    if (!autoFocusCloseButton || snapshot.status === 'idle') {
      return;
    }
    closeButtonRef.current?.focus();
  }, [autoFocusCloseButton, snapshot]);

  if (snapshot.status === 'idle') {
    return null;
  }

  const file = snapshot.file;
  const statusLabel = t(getStatusLabelKey(file.status));
  const closeLabel = closeMode === 'back' ? t('contextPanel.browser.back') : t('gitView.common.close');
  const titlePath = file.path;
  const subtitlePath = file.status === 'R' && file.originalPath ? file.originalPath : null;

  return (
    <section
      id="git-commit-diff-preview"
      data-git-commit-diff-preview="true"
      data-close-mode={closeMode}
      data-auto-focus-close={autoFocusCloseButton ? 'true' : 'false'}
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
      <header
        data-git-commit-diff-preview-header="true"
        className="flex items-start gap-3 border-b border-border/60 px-4 py-3"
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="rounded-full bg-interactive-selection px-2 py-0.5 text-xs font-medium text-interactive-selection-foreground">
              {statusLabel}
            </span>
            <code className="min-w-0 truncate font-mono text-sm text-foreground">{titlePath}</code>
          </div>
          {subtitlePath ? (
            <p className="mt-1 truncate text-xs text-muted-foreground">{subtitlePath}</p>
          ) : null}
        </div>
        <Button
          ref={closeButtonRef}
          type="button"
          size="xs"
          variant={closeMode === 'back' ? 'outline' : 'ghost'}
          data-git-commit-diff-preview-close="true"
          data-preview-close={closeMode}
          onClick={() => controller.clearSelection()}
        >
          <Icon name={closeMode === 'back' ? 'arrow-left-s' : 'close'} className="size-3" />
          {closeLabel}
        </Button>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-3 px-4 py-3">
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

        {snapshot.status === 'ready' ? renderDiffViewer(file, snapshot.original ?? '', snapshot.modified ?? '') : null}
      </div>
    </section>
  );
};
