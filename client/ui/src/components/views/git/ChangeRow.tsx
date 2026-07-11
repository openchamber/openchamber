import React, { useCallback, useMemo } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import { Icon } from "@/components/icon/Icon";
import type { GitStatus } from '@/lib/api/types';
import { useI18n } from '@/lib/i18n';

type ChangeDescriptor = {
  code: string;
  color: string;
  description: string;
};

const CHANGE_DESCRIPTORS: Record<string, ChangeDescriptor> = {
  '?': { code: '?', color: 'var(--status-info)', description: 'Untracked file' },
  A: { code: 'A', color: 'var(--status-success)', description: 'New file' },
  D: { code: 'D', color: 'var(--status-error)', description: 'Deleted file' },
  R: { code: 'R', color: 'var(--status-info)', description: 'Renamed file' },
  C: { code: 'C', color: 'var(--status-info)', description: 'Copied file' },
  M: { code: 'M', color: 'var(--status-warning)', description: 'Modified file' },
};

const DEFAULT_DESCRIPTOR = CHANGE_DESCRIPTORS.M;

function getChangeSymbol(file: GitStatus['files'][number]): string {
  const indexCode = file.index?.trim();
  const workingCode = file.working_dir?.trim();

  if (indexCode && indexCode !== '?') return indexCode.charAt(0);
  if (workingCode) return workingCode.charAt(0);

  return indexCode?.charAt(0) || workingCode?.charAt(0) || 'M';
}

function describeChange(file: GitStatus['files'][number]): ChangeDescriptor {
  const symbol = getChangeSymbol(file);
  return CHANGE_DESCRIPTORS[symbol] ?? DEFAULT_DESCRIPTOR;
}

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
  showRevert = true,
}) {
  const descriptor = useMemo(() => describeChange(file), [file]);
  const { t } = useI18n();
  const indicatorLabel = descriptor.description;
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
      title={actionLabel}
    >
      {actionSymbol}
    </button>
  );

  return (
    <div
      className={`group flex items-center gap-2 py-1.5 cursor-pointer ${rowPaddingClassName ?? 'px-3'}`}
      role="button"
      tabIndex={0}
      onClick={onViewDiff}
      onKeyDown={handleKeyDown}
      style={indentPx > 0 ? { paddingLeft: `${indentPx}px` } : undefined}
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
        {(() => {
          const lastSlash = file.path.lastIndexOf('/');
          if (lastSlash === -1) {
            return (
              <span
                className="flex-1 min-w-0 truncate typography-ui-label text-foreground"
                style={{ direction: 'rtl', textAlign: 'left', unicodeBidi: 'plaintext' }}
                title={file.path}
              >
                {file.path}
              </span>
            );
          }
          const dir = file.path.slice(0, lastSlash);
          const name = file.path.slice(lastSlash);
          return (
            <span className="flex-1 min-w-0 flex items-baseline overflow-hidden" title={file.path}>
              <span
                className="min-w-0 truncate typography-ui-label text-muted-foreground"
                  style={{ direction: 'rtl', textAlign: 'left', unicodeBidi: 'plaintext' }}
              >
                {dir}
              </span>
              <span className="flex-shrink-0 typography-ui-label"><span className="text-muted-foreground">/</span><span className="text-foreground">{name.slice(1)}</span></span>
            </span>
          );
        })()}
        <span className="shrink-0 typography-micro">
          <span style={{ color: 'var(--status-success)' }}>+{insertions}</span>
          <span className="text-muted-foreground mx-0.5">/</span>
          <span style={{ color: 'var(--status-error)' }}>-{deletions}</span>
        </span>
        {showRevert ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={handleRevertClick}
                disabled={isReverting}
                className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-50"
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
        ) : null}
        {actionAtStart ? null : actionButton}
    </div>
  );
});
