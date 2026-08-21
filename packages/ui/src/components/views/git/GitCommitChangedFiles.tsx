import React from 'react';
import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import { Button } from '@/components/ui/button';
import type { GitCommitChangedFile } from '@/lib/api/types';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { GitCommitChangesSnapshot } from './gitCommitDetailsController';

export type GitCommitChangedFilesSnapshot = GitCommitChangesSnapshot;

interface GitCommitChangedFilesProps {
  snapshot: GitCommitChangedFilesSnapshot;
  selectedPath?: string | null;
  onSelectFile?: (file: GitCommitChangedFile) => void;
  onRetry?: () => void;
}

const getFileRowLabel = (file: GitCommitChangedFile) => file.originalPath ? `${file.originalPath} → ${file.path}` : file.path;

const getFileName = (path: string) => {
  const segments = path.split('/').filter(Boolean);
  return segments.at(-1) ?? path;
};

const getDirectoryPath = (path: string) => {
  const segments = path.split('/').filter(Boolean);
  return segments.slice(0, -1).join('/');
};

const getStatusClassName = (status: GitCommitChangedFile['status']) => cn(
  'shrink-0 typography-micro font-semibold',
  status === 'A' && 'text-[var(--status-success)]',
  status === 'M' && 'text-[var(--status-warning)]',
  status === 'D' && 'text-[var(--status-error)]',
  status === 'R' && 'text-[var(--status-info)]',
);

const stopEvent = <T extends { preventDefault(): void; stopPropagation(): void }>(event: T) => {
  event.preventDefault();
  event.stopPropagation();
};

export function GitCommitChangedFiles({
  snapshot,
  selectedPath = null,
  onSelectFile,
  onRetry,
}: GitCommitChangedFilesProps) {
  const { t } = useI18n();

  const handleRetry = React.useCallback((event: React.MouseEvent<HTMLButtonElement>) => {
    stopEvent(event);
    onRetry?.();
  }, [onRetry]);

  const handleSelectFile = React.useCallback((file: GitCommitChangedFile) => (event: React.MouseEvent<HTMLButtonElement>) => {
    stopEvent(event);
    onSelectFile?.(file);
  }, [onSelectFile]);

  const handleFileKeyDown = React.useCallback((file: GitCommitChangedFile) => (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') {
      return;
    }

    stopEvent(event);
    onSelectFile?.(file);
  }, [onSelectFile]);

  const renderFileRow = React.useCallback((file: GitCommitChangedFile) => {
    const isSelected = selectedPath === file.path;
    const label = getFileRowLabel(file);
    const fileName = getFileName(file.path);
    const directoryPath = file.originalPath ? `${file.originalPath} → ${file.path}` : getDirectoryPath(file.path);

    return (
      <div key={`file:${file.path}`} role="listitem">
        <Button
          type="button"
          variant="ghost"
          size="xs"
          data-git-commit-changed-file-row={file.path}
          aria-label={t('gitView.changes.selectFileAria', { path: file.path })}
          aria-pressed={isSelected}
          className={cn(
            'flex h-auto w-full items-center gap-2 rounded-md px-2 py-1.5 text-left',
            isSelected
              ? 'bg-interactive-selection text-interactive-selection-foreground hover:bg-interactive-selection'
              : 'hover:bg-interactive-hover',
          )}
          onClick={handleSelectFile(file)}
          onKeyDown={handleFileKeyDown(file)}
        >
          <FileTypeIcon filePath={file.path} className="size-3.5 shrink-0" />
          <span className="min-w-0 flex flex-1 items-baseline gap-2 overflow-hidden" title={label}>
            <span
              data-git-commit-changed-file-name={file.path}
              className="shrink-0 truncate text-foreground"
            >
              {fileName}
            </span>
            {directoryPath ? (
              <span
                data-git-commit-changed-file-directory={file.path}
                className="min-w-0 truncate text-muted-foreground"
              >
                {directoryPath}
              </span>
            ) : null}
          </span>
          <span data-git-commit-changed-file-status={file.path} className={getStatusClassName(file.status)}>{file.status}</span>
        </Button>
      </div>
    );
  }, [handleFileKeyDown, handleSelectFile, selectedPath, t]);

  const renderList = React.useMemo(() => {
    if (snapshot.status !== 'ready') {
      return null;
    }

    return snapshot.files.map((file) => renderFileRow(file));
  }, [renderFileRow, snapshot]);

  let content: React.ReactNode;
  if (snapshot.status === 'idle' || snapshot.status === 'loading') {
    content = <p className="px-2 py-2 typography-micro text-muted-foreground">{t('gitView.history.loadingFiles')}</p>;
  } else if (snapshot.status === 'error') {
    content = (
      <Button
        type="button"
        variant="ghost"
        size="xs"
        data-git-commit-changed-files-retry="true"
        className="h-auto justify-start px-2 py-2 text-left text-muted-foreground hover:bg-interactive-hover"
        onClick={handleRetry}
      >
        {t('gitView.history.diffError')}
      </Button>
    );
  } else if (snapshot.status === 'empty') {
    content = <p className="px-2 py-2 typography-micro text-muted-foreground">{t('gitView.history.noFiles')}</p>;
  } else {
    content = renderList;
  }

  return snapshot.status === 'ready' ? (
    <div data-git-commit-changed-files="flat" role="list" aria-label={t('gitView.changes.changedFilesAria')}>
      {content}
    </div>
  ) : (
    <div data-git-commit-changed-files="flat">
      {content}
    </div>
  );
}
