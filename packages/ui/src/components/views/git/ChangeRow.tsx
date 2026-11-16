import React, { useCallback, useMemo } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import { Icon } from "@/components/icon/Icon";
import type { GitStatus } from '@/lib/api/types';
import { useDeviceInfo } from '@/lib/device';
import { longPressHandlers } from '@/lib/longPress';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { describeChange } from './changeStatus';
import { changedPathName } from './changesTree';
import { ChangedPathLabel } from './ChangedPathLabel';
import { DiffCount } from '@/components/ui/diff-count';

/** Line counts of a changed file; the side with nothing to say stays out on a narrow row. */
export const ChangeStats: React.FC<{ insertions: number; deletions: number; hideZero?: boolean }> = ({ insertions, deletions, hideZero = false }) => (
  <DiffCount added={insertions} removed={deletions} hideZero={hideZero} className="typography-micro" />
);

interface ChangeRowProps {
  file: GitStatus['files'][number];
  actionLabel: string;
  actionSymbol: '+' | '-';
  onAction: () => void;
  onViewDiff: () => void;
  onRevert: () => void;
  isReverting: boolean;
  stats?: { insertions: number; deletions: number };
  rowPaddingClassName?: string;
  indentPx?: number;
  /** Place the stage/unstage action at the row start (flat view) instead of the end (tree view). */
  actionAtStart?: boolean;
  /** Tree view: the directory rows above already say where the file lives. */
  nameOnly?: boolean;
  showRevert?: boolean;
}

export const ChangeRow = React.memo<ChangeRowProps>(function ChangeRow({
  file,
  actionLabel,
  actionSymbol,
  onAction,
  onViewDiff,
  onRevert,
  isReverting,
  stats,
  rowPaddingClassName,
  indentPx = 0,
  actionAtStart = false,
  nameOnly = false,
  showRevert = true,
}) {
  const descriptor = useMemo(() => describeChange(file), [file]);
  const { t } = useI18n();
  const { isMobile } = useDeviceInfo();
  const indicatorLabel = t(descriptor.descriptionKey);
  const insertions = stats?.insertions ?? 0;
  const deletions = stats?.deletions ?? 0;

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === ' ') {
        event.preventDefault();
        onAction();
      } else if (event.key === 'Enter') {
        event.preventDefault();
        onViewDiff();
      }
    },
    [onAction, onViewDiff]
  );

  const handleActionClick = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      onAction();
    },
    [onAction]
  );

  const handleRevertClick = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      onRevert();
    },
    [onRevert]
  );

  const actionButton = (
    <button
      type="button"
      onClick={handleActionClick}
      className="flex size-5 shrink-0 items-center justify-center rounded typography-micro font-semibold text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]"
      aria-label={actionLabel}
      data-row-tooltip={t(actionSymbol === '+' ? 'contextTooltips.git.stageFile' : 'contextTooltips.git.unstageFile')}
    >
      {actionSymbol}
    </button>
  );

  const statsLabel = <ChangeStats insertions={insertions} deletions={deletions} hideZero={isMobile} />;

  const revertButton = showRevert ? (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={handleRevertClick}
          disabled={isReverting}
          className={cn(
            // On a phone a long press on the row reverts; the button stays for screen readers.
            isMobile ? 'sr-only' : 'flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50',
          )}
          aria-label={t('gitView.changes.revertFileAria', { path: file.path })}
        >
          {isReverting ? (
            <Icon name="loader-4" className="size-3.5 animate-spin" />
          ) : (
            <Icon name="arrow-go-back" className="size-3.5" />
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent sideOffset={8}>{t('gitView.changes.revertFileTooltip')}</TooltipContent>
    </Tooltip>
  ) : null;

  return (
    <div
      className={cn(
        'group flex items-center gap-2 cursor-pointer',
        rowPaddingClassName ?? 'px-3',
        isMobile ? 'min-h-11 select-none rounded-md active:bg-interactive-hover' : 'py-1.5',
      )}
      role="button"
      tabIndex={0}
      onClick={onViewDiff}
      onKeyDown={handleKeyDown}
      {...(isMobile && showRevert && !isReverting ? longPressHandlers(onRevert) : null)}
      style={indentPx > 0 ? { paddingInlineStart: `${indentPx}px` } : undefined}
    >
        {actionAtStart ? actionButton : null}
        <span
          className="typography-micro font-semibold w-4 text-center uppercase"
          style={{ color: descriptor.color }}
          title={indicatorLabel}
          aria-label={indicatorLabel}
        >
          {descriptor.code}
        </span>
        <FileTypeIcon filePath={file.path} className="h-3.5 w-3.5 shrink-0" />
        {nameOnly ? (
          <span
            className="oc-ui-start-align flex-1 min-w-0 truncate typography-ui-label"
            style={{ direction: 'rtl', unicodeBidi: 'plaintext' }}
            title={file.previousPath ? `${file.previousPath} → ${file.path}` : file.path}
          >
            {file.previousPath ? (
              <span className="text-muted-foreground">{changedPathName(file.previousPath)}{' → '}</span>
            ) : null}
            <span className="text-foreground">{changedPathName(file.path)}</span>
          </span>
        ) : (
          <ChangedPathLabel
            path={file.path}
            from={file.previousPath}
            nameFirst={isMobile}
            className="flex-1 typography-ui-label"
          />
        )}
        {actionAtStart ? (
          <>
            {statsLabel}
            {revertButton}
          </>
        ) : (
          // Tree view: on hover the actions take the place of the stats, so
          // nothing in the row moves. Narrow (touch) layouts have no hover and
          // show both side by side.
          <span className="flex shrink-0 items-center justify-items-end gap-2 md:grid">
            <span
              className={cn(
                'md:col-start-1 md:row-start-1',
                isReverting ? 'md:invisible' : 'md:group-hover:invisible md:group-focus-within:invisible'
              )}
            >
              {statsLabel}
            </span>
            <span
              className={cn(
                'flex items-center gap-2 md:col-start-1 md:row-start-1',
                !isReverting && 'md:invisible md:group-hover:visible md:group-focus-within:visible'
              )}
            >
              {revertButton}
              {actionButton}
            </span>
          </span>
        )}
    </div>
  );
});
