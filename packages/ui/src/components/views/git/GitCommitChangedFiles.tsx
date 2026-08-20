import React from 'react';
import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import type { GitCommitChangedFile } from '@/lib/api/types';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import {
  buildChangesTree,
  flattenChangesTree,
  TREE_INDENT_PX,
} from './changesTree';
import type { GitCommitChangesSnapshot } from './gitCommitDetailsController';

export type GitCommitChangedFilesSnapshot = GitCommitChangesSnapshot;

interface GitCommitChangedFilesProps {
  snapshot: GitCommitChangedFilesSnapshot;
  view?: 'list' | 'tree';
  selectedPath?: string | null;
  expandedDirectories?: ReadonlySet<string>;
  onToggleDirectory?: (path: string) => void;
  onSelectFile?: (file: GitCommitChangedFile) => void;
  onRetry?: () => void;
}

const getFileRowLabel = (file: GitCommitChangedFile) => file.originalPath ? `${file.originalPath} → ${file.path}` : file.path;

const getDirectoryControlId = (path: string) => `git-commit-changed-files-directory-${path.replace(/[^a-zA-Z0-9_-]+/g, '-')}`;

const getDirectoryPaths = (files: GitCommitChangedFile[]): Set<string> => {
  const paths = new Set<string>();

  for (const file of files) {
    const segments = file.path.split('/').filter(Boolean);
    let current = '';
    for (const segment of segments.slice(0, -1)) {
      current = current ? `${current}/${segment}` : segment;
      paths.add(current);
    }
  }

  return paths;
};

const stopEvent = <T extends { preventDefault(): void; stopPropagation(): void }>(event: T) => {
  event.preventDefault();
  event.stopPropagation();
};

export function GitCommitChangedFiles({
  snapshot,
  view = 'tree',
  selectedPath = null,
  expandedDirectories,
  onToggleDirectory,
  onSelectFile,
  onRetry,
}: GitCommitChangedFilesProps) {
  const { t } = useI18n();

  const normalizedExpandedDirectories = React.useMemo(() => {
    if (expandedDirectories) {
      return new Set(expandedDirectories);
    }

    if (snapshot.status !== 'ready') {
      return new Set<string>();
    }

    return getDirectoryPaths(Array.from(snapshot.files));
  }, [expandedDirectories, snapshot]);

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

  const handleToggleDirectory = React.useCallback((path: string) => (event: React.MouseEvent<HTMLButtonElement>) => {
    stopEvent(event);
    onToggleDirectory?.(path);
  }, [onToggleDirectory]);

  const renderFileRow = React.useCallback((file: GitCommitChangedFile, depth: number) => {
    const isSelected = selectedPath === file.path;
    const label = getFileRowLabel(file);

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
            'flex h-auto w-full items-center justify-start gap-2 rounded-md px-2 py-1.5 text-left',
            isSelected
              ? 'bg-interactive-selection text-interactive-selection-foreground hover:bg-interactive-selection'
              : 'hover:bg-interactive-hover',
          )}
          style={depth > 0 ? { paddingLeft: `${depth * TREE_INDENT_PX + 8}px` } : undefined}
          onClick={handleSelectFile(file)}
          onKeyDown={handleFileKeyDown(file)}
        >
          <span
            className={cn(
              'inline-flex w-5 shrink-0 items-center justify-center rounded border px-1 typography-micro font-semibold',
              file.status === 'A' && 'border-[var(--status-success-border)] bg-[var(--status-success-background)] text-[var(--status-success-foreground)]',
              file.status === 'M' && 'border-[var(--status-warning-border)] bg-[var(--status-warning-background)] text-[var(--status-warning-foreground)]',
              file.status === 'D' && 'border-[var(--status-error-border)] bg-[var(--status-error-background)] text-[var(--status-error-foreground)]',
              file.status === 'R' && 'border-[var(--status-info-border)] bg-[var(--status-info-background)] text-[var(--status-info-foreground)]',
            )}
          >
            {file.status}
          </span>
          <FileTypeIcon filePath={file.path} className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 overflow-hidden" title={label}>
            {file.originalPath ? (
              <span className="flex min-w-0 items-center gap-1 overflow-hidden">
                <span className="truncate text-muted-foreground">{file.originalPath}</span>
                <Icon name="arrow-right" className="size-3 shrink-0 text-muted-foreground" />
                <span className="truncate text-foreground">{file.path}</span>
              </span>
            ) : (
              <span className="truncate text-foreground">{file.path}</span>
            )}
          </span>
          <span className="shrink-0 typography-micro">
            {file.isBinary ? (
              <span className="text-muted-foreground">{t('gitView.history.binary')}</span>
            ) : (
              <>
                <span className="text-[var(--status-success)]">+{file.insertions}</span>
                <span className="mx-0.5 text-muted-foreground">/</span>
                <span className="text-[var(--status-error)]">-{file.deletions}</span>
              </>
            )}
          </span>
        </Button>
      </div>
    );
  }, [handleFileKeyDown, handleSelectFile, selectedPath, t]);

  const renderTree = React.useMemo(() => {
    if (snapshot.status !== 'ready') {
      return null;
    }

    const rows = flattenChangesTree(buildChangesTree(Array.from(snapshot.files)), normalizedExpandedDirectories);

    return rows.map((row) => {
      if (row.kind === 'file') {
        return renderFileRow(row.file, row.depth);
      }

      const isExpanded = normalizedExpandedDirectories.has(row.directory.path);
      const controlId = getDirectoryControlId(row.directory.path);
      const toggleLabel = isExpanded
        ? t('gitView.changes.collapseDirectoryAria', { path: row.directory.path })
        : t('gitView.changes.expandDirectoryAria', { path: row.directory.path });

      return (
        <div key={row.key} role="listitem" id={isExpanded ? controlId : undefined} data-git-commit-changed-directory-row={row.directory.path}>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            data-git-commit-changed-directory-toggle={row.directory.path}
            aria-label={toggleLabel}
            aria-expanded={isExpanded}
            aria-controls={isExpanded ? controlId : undefined}
            className="flex h-auto w-full items-center justify-start gap-2 rounded-md px-2 py-1.5 text-left hover:bg-interactive-hover"
            style={{ paddingLeft: `${row.depth * TREE_INDENT_PX + 8}px` }}
            onClick={handleToggleDirectory(row.directory.path)}
          >
            <Icon name={isExpanded ? 'arrow-down-s' : 'arrow-right-s'} className="size-3 shrink-0 text-muted-foreground" />
            <span className="truncate text-foreground">{row.directory.name}</span>
            <span className="shrink-0 text-muted-foreground typography-micro">{row.directory.files.length}</span>
          </Button>
        </div>
      );
    });
  }, [handleToggleDirectory, normalizedExpandedDirectories, renderFileRow, snapshot, t]);

  const renderList = React.useMemo(() => {
    if (snapshot.status !== 'ready') {
      return null;
    }

    return snapshot.files.map((file) => renderFileRow(file, 0));
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
    content = view === 'tree' ? renderTree : renderList;
  }

  return snapshot.status === 'ready' ? (
    <div data-git-commit-changed-files={view} role="list" aria-label={t('gitView.changes.changedFilesAria')}>
      {content}
    </div>
  ) : (
    <div data-git-commit-changed-files={view}>
      {content}
    </div>
  );
}
