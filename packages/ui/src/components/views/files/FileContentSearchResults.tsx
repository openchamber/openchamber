import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import type { FileContentSearchMatch } from '@/lib/api/types';
import { useI18n } from '@/lib/i18n';
import { matchSegments } from '@/lib/search/matchSegments';
import { cn } from '@/lib/utils';
import { MatchHighlight } from '@/components/ui/MatchHighlight';

import { fileTreeRowStateClassName } from './fileTreeRow';
import { fileContentMatchKey, type FileContentSearchState } from './useFileContentSearch';

type Props = {
  state: FileContentSearchState;
  /** The one result marked as open; other lines of the same file stay plain. */
  activeMatchKey: string | null;
  onOpen: (match: FileContentSearchMatch, options?: { pin?: boolean }) => void;
  onDragStart?: (event: React.DragEvent<HTMLButtonElement>, match: FileContentSearchMatch) => void;
  onDragEnd?: (event: React.DragEvent<HTMLButtonElement>, match: FileContentSearchMatch) => void;
};

const Note: React.FC<{ className?: string; children: React.ReactNode }> = ({ className, children }) => (
  <li className={cn('px-2 py-1 typography-meta text-muted-foreground', className)}>{children}</li>
);

const splitRelativePath = (relativePath: string): { name: string; directory: string } => {
  const slash = relativePath.lastIndexOf('/');
  return slash === -1
    ? { name: relativePath, directory: '' }
    : { name: relativePath.slice(slash + 1), directory: relativePath.slice(0, slash) };
};

/**
 * Find-in-files results as rows of a files tree list: one card per matching
 * line, the file on top and the line with its matches marked below. Renders
 * `<li>` elements, so it sits inside the tree's own `<ul>`.
 */
export const FileContentSearchResults: React.FC<Props> = ({ state, activeMatchKey, onOpen, onDragStart, onDragEnd }) => {
  const { t } = useI18n();

  switch (state.status) {
    case 'idle':
      return null;
    case 'searching':
      return (
        <li className="flex items-center gap-1.5 px-2 py-1 typography-meta text-muted-foreground">
          <Icon name="loader-4" className="h-4 w-4 animate-spin" />
          {t('sidebarFilesTree.state.searching')}
        </li>
      );
    case 'unavailable':
      return <Note>{t('sidebarFilesTree.contentSearch.unavailable')}</Note>;
    case 'invalid-pattern':
      return (
        <Note className="flex flex-col gap-0.5">
          <span className="text-[var(--status-error)]">{t('sidebarFilesTree.contentSearch.invalidPattern')}</span>
          <span className="font-mono typography-micro" dir="ltr">{state.message}</span>
        </Note>
      );
    case 'failed':
      return <Note className="text-[var(--status-error)]">{t('sidebarFilesTree.contentSearch.failed', { message: state.message })}</Note>;
    case 'results':
      break;
  }

  if (state.matches.length === 0) {
    // A search cut short by the deadline found nothing yet; that is not "no matches".
    return state.stopped === 'deadline'
      ? <Note>{t('sidebarFilesTree.contentSearch.deadline')}</Note>
      : <Note>{t('sidebarFilesTree.contentSearch.empty')}</Note>;
  }

  return (
    <>
      {state.matches.map((match) => {
        const { name, directory } = splitRelativePath(match.relativePath);
        const key = fileContentMatchKey(match);
        const isActive = activeMatchKey === key;
        return (
          <li key={key} data-file-tree-path={match.path}>
            <button
              type="button"
              onClick={() => onOpen(match)}
              onDoubleClick={() => onOpen(match, { pin: true })}
              draggable={Boolean(onDragStart)}
              onDragStart={onDragStart ? (event) => onDragStart(event, match) : undefined}
              onDragEnd={onDragEnd ? (event) => onDragEnd(event, match) : undefined}
              className={cn(
                'flex w-full flex-col gap-0.5 rounded-md px-2 py-1 text-start transition-colors',
                fileTreeRowStateClassName(isActive)
              )}
              title={`${match.relativePath}:${match.line}`}
            >
              <span className="flex w-full min-w-0 items-center gap-1.5">
                <FileTypeIcon filePath={match.path} className="size-3.5 flex-shrink-0" />
                <span className="min-w-0 flex-shrink truncate typography-meta" dir="auto">{name}</span>
                {directory ? (
                  <span
                    className="oc-ui-start-align min-w-0 flex-1 truncate typography-micro text-muted-foreground"
                    style={{ direction: 'rtl' }}
                  >
                    {/* Left-to-right marks keep a leading "." in place inside the rtl box. */}
                    {`‎${directory}‎`}
                  </span>
                ) : <span className="flex-1" />}
                <span className="flex-shrink-0 typography-micro tabular-nums text-muted-foreground">{match.line}</span>
              </span>
              <span className="block w-full min-w-0 truncate font-mono typography-micro text-muted-foreground" dir="ltr">
                {match.cutStart ? '…' : null}
                <MatchHighlight segments={matchSegments(match.text, match.ranges)} />
              </span>
            </button>
          </li>
        );
      })}
      {state.stopped === 'limit' ? (
        <Note>{t('sidebarFilesTree.contentSearch.limit', { count: state.matches.length })}</Note>
      ) : state.stopped === 'deadline' ? (
        <Note>{t('sidebarFilesTree.contentSearch.deadline')}</Note>
      ) : null}
    </>
  );
};
