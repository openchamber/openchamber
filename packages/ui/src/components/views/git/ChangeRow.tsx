import React, { useCallback, useMemo } from 'react';
import {
  RiCheckboxLine,
  RiCheckboxBlankLine,
  RiArrowGoBackLine,
  RiLoader4Line,
} from '@remixicon/react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import type { GitStatus } from '@/lib/api/types';
import { useLanguage } from '@/hooks/useLanguage';

type ChangeDescriptor = {
  code: string;
  color: string;
  description: string;
};

const getChangeDescriptors = (t: (key: string, params?: Record<string, unknown>) => string): Record<string, ChangeDescriptor> => ({
  '?': { code: '?', color: 'var(--status-info)', description: t('changeRow.untrackedFile') },
  A: { code: 'A', color: 'var(--status-success)', description: t('changeRow.newFile') },
  D: { code: 'D', color: 'var(--status-error)', description: t('changeRow.deletedFile') },
  R: { code: 'R', color: 'var(--status-info)', description: t('changeRow.renamedFile') },
  C: { code: 'C', color: 'var(--status-info)', description: t('changeRow.copiedFile') },
  M: { code: 'M', color: 'var(--status-warning)', description: t('changeRow.modifiedFile') },
});

function getChangeSymbol(file: GitStatus['files'][number]): string {
  const indexCode = file.index?.trim();
  const workingCode = file.working_dir?.trim();

  if (indexCode && indexCode !== '?') return indexCode.charAt(0);
  if (workingCode) return workingCode.charAt(0);

  return indexCode?.charAt(0) || workingCode?.charAt(0) || 'M';
}

function describeChange(
  file: GitStatus['files'][number],
  changeDescriptors: Record<string, ChangeDescriptor>,
): ChangeDescriptor {
  const symbol = getChangeSymbol(file);
  return changeDescriptors[symbol] ?? changeDescriptors.M;
}

interface ChangeRowProps {
  file: GitStatus['files'][number];
  checked: boolean;
  onToggle: () => void;
  onViewDiff: () => void;
  onRevert: () => void;
  isReverting: boolean;
  stats?: { insertions: number; deletions: number };
}

export const ChangeRow = React.memo<ChangeRowProps>(function ChangeRow({
  file,
  checked,
  onToggle,
  onViewDiff,
  onRevert,
  isReverting,
  stats,
}) {
  const { t } = useLanguage();
  const changeDescriptors = useMemo(() => getChangeDescriptors(t), [t]);
  const descriptor = useMemo(() => describeChange(file, changeDescriptors), [changeDescriptors, file]);
  const indicatorLabel = descriptor.description;
  const insertions = stats?.insertions ?? 0;
  const deletions = stats?.deletions ?? 0;

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === ' ') {
        event.preventDefault();
        onToggle();
      } else if (event.key === 'Enter') {
        event.preventDefault();
        onViewDiff();
      }
    },
    [onToggle, onViewDiff]
  );

  const handleToggleClick = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      onToggle();
    },
    [onToggle]
  );

  const handleRevertClick = useCallback(
    (event: React.MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      onRevert();
    },
    [onRevert]
  );

  return (
    <div
      className="group flex items-center gap-2 px-3 py-1.5 hover:bg-sidebar/40 cursor-pointer"
      role="button"
      tabIndex={0}
      onClick={onViewDiff}
      onKeyDown={handleKeyDown}
    >
        <button
          type="button"
          onClick={handleToggleClick}
          aria-pressed={checked}
          aria-label={t('changeRow.selectFile', { path: file.path })}
          className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        >
          {checked ? (
            <RiCheckboxLine className="size-4 text-primary" />
          ) : (
            <RiCheckboxBlankLine className="size-4" />
          )}
        </button>
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
                style={{ direction: 'rtl', textAlign: 'left' }}
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
                style={{ direction: 'rtl', textAlign: 'left' }}
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
        <Tooltip delayDuration={200}>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={handleRevertClick}
              disabled={isReverting}
              className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-50"
              aria-label={t('changeRow.revertChangesForFile', { path: file.path })}
            >
              {isReverting ? (
                <RiLoader4Line className="size-3.5 animate-spin" />
              ) : (
                <RiArrowGoBackLine className="size-3.5" />
              )}
            </button>
          </TooltipTrigger>
          <TooltipContent sideOffset={8}>{t('changeRow.revertChanges')}</TooltipContent>
        </Tooltip>
    </div>
  );
});
