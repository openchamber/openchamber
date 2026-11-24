import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { FileTypeIcon } from '@/components/icons/FileTypeIcon';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { GitStatus } from '@/lib/api/types';
import { FileTreeChevron, FileTreeIndentGuides, FileTreeRowEnd, FileTreeStatusLetter } from '../files/FileTreeRowParts';
import { fileTreeRowMenuFillClassName, fileTreeRowPaddingLeft, fileTreeRowStateClassName } from '../files/fileTreeRow';
import { describeChange } from './changeStatus';
import { changedPathName } from './changesTree';

const GROUP_HOVER_ROW = 'group-hover:bg-interactive-hover group-hover:text-foreground group-hover:[--oc-file-tree-row-fill:var(--interactive-hover)]';

const ROW_STYLE: React.CSSProperties = { blockSize: 'calc(max(1lh, 1rem) + 0.5rem)' };

const LaneButton: React.FC<{
  label: string;
  tooltip: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}> = ({ label, tooltip, onClick, disabled = false, children }) => (
  <button
    type="button"
    onClick={(event) => {
      event.stopPropagation();
      onClick();
    }}
    disabled={disabled}
    className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)] disabled:cursor-not-allowed disabled:opacity-50"
    aria-label={label}
    data-row-tooltip={tooltip}
  >
    {children}
  </button>
);

type RowActions = {
  stageLabel: string;
  stageTooltip: string;
  stageIcon: 'add' | 'subtract';
  onStage: () => void;
  revert: { label: string; tooltip: string; onRevert: () => void; reverting: boolean } | null;
};

const ActionLane: React.FC<{ actions: RowActions; isActive: boolean }> = ({ actions, isActive }) => {
  const { revert } = actions;
  return (
    <div
      className={cn(
        'oc-file-tree-row-end justify-end gap-0.5 pe-1 transition-opacity',
        revert ? '-ms-[3.375rem] w-[3.375rem]' : '-ms-7 w-7',
        revert?.reverting ? 'opacity-100' : 'opacity-0 focus-within:opacity-100 group-hover:opacity-100',
        fileTreeRowMenuFillClassName(isActive),
      )}
    >
      {revert ? (
        <LaneButton label={revert.label} tooltip={revert.tooltip} onClick={revert.onRevert} disabled={revert.reverting}>
          <Icon name={revert.reverting ? 'loader-4' : 'arrow-go-back'} className={cn('size-3.5', revert.reverting && 'animate-spin')} />
        </LaneButton>
      ) : null}
      <LaneButton label={actions.stageLabel} tooltip={actions.stageTooltip} onClick={actions.onStage}>
        <Icon name={actions.stageIcon} className="size-3.5" />
      </LaneButton>
    </div>
  );
};

export const ChangesTreeFileRow: React.FC<{
  file: GitStatus['files'][number];
  depth: number;
  isSelected: boolean;
  onView: () => void;
  actions: RowActions;
}> = ({ file, depth, isSelected, onView, actions }) => {
  const { t } = useI18n();
  const descriptor = describeChange(file);
  return (
    <div className="group relative flex items-center typography-meta" style={ROW_STYLE}>
      <FileTreeIndentGuides depth={depth} />
      <button
        type="button"
        onClick={onView}
        onKeyDown={(event) => {
          if (event.key !== ' ') return;
          event.preventDefault();
          actions.onStage();
        }}
        aria-current={isSelected ? 'true' : undefined}
        className={cn(
          'oc-file-tree-row flex w-full items-center gap-1.5 rounded-md py-1 text-start',
          isSelected ? cn(fileTreeRowStateClassName(true), 'transition-none') : cn('text-foreground/90', GROUP_HOVER_ROW),
        )}
        style={{ paddingInlineStart: fileTreeRowPaddingLeft(depth) }}
        title={file.path}
      >
        <FileTypeIcon filePath={file.path} className="ms-0.5 size-3.5 flex-shrink-0" />
        <span className="oc-file-tree-row-name typography-meta">{changedPathName(file.path)}</span>
        <FileTreeRowEnd className="pe-2">
          <FileTreeStatusLetter code={descriptor.code} color={descriptor.color} label={t(descriptor.descriptionKey)} />
        </FileTreeRowEnd>
      </button>
      <ActionLane actions={actions} isActive={isSelected} />
    </div>
  );
};

export const ChangesTreeDirectoryRow: React.FC<{
  path: string;
  label: string;
  depth: number;
  fileCount: number;
  expanded: boolean;
  onToggle: () => void;
  actions: RowActions;
}> = ({ path, label, depth, fileCount, expanded, onToggle, actions }) => {
  const { t } = useI18n();
  return (
    <div className="group relative flex items-center typography-meta" style={ROW_STYLE}>
      <FileTreeIndentGuides depth={depth} />
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-label={expanded
          ? t('gitView.changes.collapseDirectoryAria', { path })
          : t('gitView.changes.expandDirectoryAria', { path })}
        className={cn('oc-file-tree-row flex w-full items-center gap-1 rounded-md py-1 text-start text-muted-foreground', GROUP_HOVER_ROW)}
        style={{ paddingInlineStart: fileTreeRowPaddingLeft(depth) }}
        title={path}
      >
        <FileTreeChevron expanded={expanded} />
        <span className="oc-file-tree-row-name typography-meta">{label}</span>
        <FileTreeRowEnd className="pe-2">
          {expanded ? null : <span className="typography-micro tabular-nums text-muted-foreground">{fileCount}</span>}
        </FileTreeRowEnd>
      </button>
      <ActionLane actions={actions} isActive={false} />
    </div>
  );
};
