import React from 'react';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useConfirmDialog } from '@/components/ui/confirm-dialog';
import { MultiFileDiffEntry } from '../diffView/MultiFileDiffEntry';
import { GitDiffFindBar } from './GitDiffFindBar';
import { useWorkingFocus } from './useWorkingFocus';
import { toFileEntry, useWorkingDiffNavigation } from './useWorkingDiffNavigation';
import type { WorkingFocusRequest } from './useUnifiedGitPanel';
import type { DiffData } from '../diffView/types';
import type { GitStatus } from '@/lib/api/types';
import { ChangesPanel, type ChangesGroupConfig } from './ChangesPanel';
import { GitSidebarColumn } from './GitSidebarColumn';
import { DelegatedTooltip } from '@/components/ui/row-tooltip';
import { useSettledFlag } from '@/hooks/useSettledFlag';
import { ProgressiveRows } from './ProgressiveRows';
import type { DiffCommentOrigin } from '@/lib/diffCommentOrigin';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

const WORKING_ORIGIN: DiffCommentOrigin = { kind: 'working-tree' };
const STAGED_ORIGIN: DiffCommentOrigin = { kind: 'working-tree', staged: true };

const StageActionButton: React.FC<{
  symbol: '+' | '-';
  label: string;
  tooltip: string;
  onClick: () => void;
}> = ({ symbol, label, tooltip, onClick }) => (
  <button
    type="button"
    onClick={(event) => {
      event.stopPropagation();
      onClick();
    }}
    aria-label={label}
    data-row-tooltip={tooltip}
    className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-interactive-hover hover:text-foreground"
  >
    <Icon name={symbol === '+' ? 'add' : 'subtract'} className="size-3.5" />
  </button>
);

export type WorkingEntrySelection = {
  groupId: 'staged' | 'unstaged';
  path: string;
};

interface UnifiedWorkingChangesBodyProps {
  directory: string;
  visible: boolean;
  isWide: boolean;
  groups: ChangesGroupConfig[];
  diffStats: GitStatus['diffStats'];
  revertingPaths: Set<string>;
  isRevertingAll: boolean;
  hasPendingIndexMutation: boolean;
  onRevertAll: (paths: string[]) => Promise<void> | void;
  onRevertDirectory: (paths: string[]) => Promise<void> | void;
  getLayoutForFile: (path: string) => 'inline' | 'side-by-side';
  diffWrapLines: boolean;
  diffHideWhitespace: boolean;
  workingTreeRevision: number;
  fileRefreshNonce: ReadonlyMap<string, number>;
  focusRequest: WorkingFocusRequest | null;
  expandedKeys: Set<string>;
  onToggleExpandedKey: (key: string, expanded: boolean) => void;
  selectedEntry: WorkingEntrySelection | null;
  onSelectEntry: (selection: WorkingEntrySelection) => void;
  openingEditorFilePath: string | null;
  onOpenInEditor: (filePath: string, diffData: DiffData | null, staged: boolean) => void;
  commitSlot: React.ReactNode;
}

const makeEntryKey = (groupId: string, path: string): string => `${groupId}:${path}`;

export const UnifiedWorkingChangesBody: React.FC<UnifiedWorkingChangesBodyProps> = ({
  directory,
  visible,
  isWide,
  groups,
  diffStats,
  revertingPaths,
  isRevertingAll,
  hasPendingIndexMutation,
  onRevertAll,
  onRevertDirectory,
  getLayoutForFile,
  diffWrapLines,
  diffHideWhitespace,
  workingTreeRevision,
  fileRefreshNonce,
  focusRequest,
  expandedKeys,
  onToggleExpandedKey,
  selectedEntry,
  onSelectEntry,
  openingEditorFilePath,
  onOpenInEditor,
  commitSlot,
}) => {
  const { t } = useI18n();
  const [collapsedGroups, setCollapsedGroups] = React.useState<Set<string>>(() => new Set());
  const confirmDialog = useConfirmDialog();

  const sidebarGroups = React.useMemo(() => groups.map((group) => ({
    ...group,
    onViewDiff: (path: string) => onSelectEntry({ groupId: group.id as WorkingEntrySelection['groupId'], path }),
  })), [groups, onSelectEntry]);

  const visibleGroups = React.useMemo(
    () => groups.filter((group) => group.entries.length > 0),
    [groups],
  );

  const resolvedSelection = React.useMemo<WorkingEntrySelection | null>(() => {
    if (selectedEntry) {
      const group = visibleGroups.find((g) => g.id === selectedEntry.groupId);
      if (group?.entries.some((f) => f.path === selectedEntry.path)) {
        return selectedEntry;
      }
      const otherGroup = visibleGroups.find((g) => g.entries.some((f) => f.path === selectedEntry.path));
      if (otherGroup) {
        return { groupId: otherGroup.id as 'staged' | 'unstaged', path: selectedEntry.path };
      }
    }
    const firstGroup = visibleGroups[0];
    const firstFile = firstGroup?.entries[0];
    if (!firstGroup || !firstFile) return null;
    return { groupId: firstGroup.id as 'staged' | 'unstaged', path: firstFile.path };
  }, [selectedEntry, visibleGroups]);

  const toggleGroup = React.useCallback((groupId: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  }, []);

  const requestRevertFile = React.useCallback(async (group: ChangesGroupConfig, path: string) => {
    const confirmed = await confirmDialog.confirm({
      title: t('gitView.changes.revertFileDialogTitle'),
      message: t('gitView.changes.revertFileDescription', { path }),
      action: t('gitView.changes.revertFileConfirm'),
      destructive: true,
    });
    if (confirmed) group.onRevertFile(path);
  }, [confirmDialog, t]);

  const requestRevertAll = React.useCallback(async () => {
    const allPaths = Array.from(new Set(visibleGroups.flatMap((g) => g.entries.map((f) => f.path))));
    if (allPaths.length === 0) return;
    const confirmed = await confirmDialog.confirm({
      title: t('gitView.changes.revertAllDialogTitle'),
      message: allPaths.length === 1
        ? t('gitView.changes.revertAllDescriptionSingle', { count: 1 })
        : t('gitView.changes.revertAllDescriptionPlural', { count: allPaths.length }),
      action: t('gitView.changes.revertAll'),
      destructive: true,
    });
    if (confirmed) await onRevertAll(allPaths);
  }, [confirmDialog, onRevertAll, t, visibleGroups]);

  const revealGroup = React.useCallback((groupId: string) => {
    setCollapsedGroups((prev) => {
      if (!prev.has(groupId)) return prev;
      const next = new Set(prev);
      next.delete(groupId);
      return next;
    });
  }, []);
  const expandKey = React.useCallback((key: string) => onToggleExpandedKey(key, true), [onToggleExpandedKey]);
  const { registerSectionRef, focus, revealEntry, cancel } = useWorkingFocus({
    focusRequest,
    groups: visibleGroups,
    directory,
    revealGroup,
    expand: expandKey,
    select: onSelectEntry,
  });
  const contentRevisionOf = (path: string) => workingTreeRevision + (fileRefreshNonce.get(path) ?? 0);
  const noopRegisterRef = React.useCallback(() => {}, []);

  const findRootRef = React.useRef<HTMLDivElement | null>(null);
  const { diffFind, findFocusNonce, findPropsFor } = useWorkingDiffNavigation({
    directory,
    visible,
    groups: visibleGroups,
    diffStats,
    getLayoutForFile,
    diffHideWhitespace,
    workingTreeRevision,
    fileRefreshNonce,
    currentEntry: isWide ? resolvedSelection : selectedEntry,
    focus,
    expandEntry: revealEntry,
    cancelScrollHold: cancel,
    rootRef: findRootRef,
  });

  const wideSettled = useSettledFlag(isWide);
  const wideDiffRef = React.useRef<HTMLDivElement | null>(null);
  const narrowListRef = React.useRef<HTMLDivElement | null>(null);

  const renderGroupHeader = (group: ChangesGroupConfig) => {
    const isCollapsed = collapsedGroups.has(group.id);
    const paths = group.entries.map((entry) => entry.path);
    return (
      <div className="flex h-8 items-center gap-1.5 px-2.5 select-none">
        <StageActionButton
          symbol={group.actionSymbol}
          label={group.actionAllLabel}
          tooltip={group.actionAllLabel}
          onClick={() => group.onActionAll(paths)}
        />
        <button
          type="button"
          onClick={() => toggleGroup(group.id)}
          className="flex min-w-0 items-center gap-1.5 rounded px-1 py-0.5 text-start hover:bg-interactive-hover"
        >
          <span className="typography-ui-label font-semibold text-foreground">{group.title}</span>
          <span className="typography-micro tabular-nums text-muted-foreground">{group.entries.length}</span>
          <Icon
            name={isCollapsed ? 'arrow-right-s' : 'arrow-down-s'}
            className="size-3.5 text-muted-foreground"
          />
        </button>
      </div>
    );
  };

  const renderRevertAllButton = () => {
    const hasUnstaged = visibleGroups.some((g) => g.showRevertActions !== false && g.entries.length > 0);
    if (!hasUnstaged) return null;
    return (
      <div className="flex justify-end px-3 pt-2 pb-1">
        <Button
          type="button"
          variant="ghost"
          size="xs"
          disabled={isRevertingAll}
          onClick={() => void requestRevertAll()}
          className="gap-1.5 text-[var(--status-error)] hover:bg-[var(--status-error-background)] hover:text-[var(--status-error)]"
        >
          <Icon name={isRevertingAll ? 'loader-4' : 'arrow-go-back'} className={cn('size-3.5', isRevertingAll && 'animate-spin')} />
          {t('gitView.changes.revertAll')}
        </Button>
      </div>
    );
  };

  const activeGroup = resolvedSelection
    ? visibleGroups.find((g) => g.id === resolvedSelection.groupId) ?? null
    : null;
  const activeRawFile = activeGroup && resolvedSelection
    ? activeGroup.entries.find((f) => f.path === resolvedSelection.path) ?? null
    : null;
  const activeFileEntry = activeGroup && activeRawFile
    ? toFileEntry(activeRawFile, activeGroup.statsScope, diffStats)
    : null;
  const activeIsStaged = activeGroup?.statsScope === 'staged';

  const wideBody = (
    <div className="flex min-h-0 flex-1 overflow-hidden" aria-busy={hasPendingIndexMutation || undefined}>
      <GitSidebarColumn>
        <div className="min-h-0 flex-1 overflow-hidden ps-1.5 pt-1">
          <ChangesPanel
            groups={sidebarGroups}
            diffStats={diffStats}
            revertingPaths={revertingPaths}
            isRevertingAll={isRevertingAll}
            onRevertAll={onRevertAll}
            onRevertDirectory={onRevertDirectory}
            memoryKey={`changes:${getRuntimeKey()}:${directory}`}
            memoryReady
            selectedKey={resolvedSelection ? `${resolvedSelection.groupId}:${resolvedSelection.path}` : null}
            alwaysTree
            headerBackgroundClassName="bg-background"
            scrollSurface="var(--background)"
          />
        </div>
        <div className="shrink-0 border-t border-edge-muted bg-background px-3">
          {commitSlot}
        </div>
      </GitSidebarColumn>

      <div ref={wideDiffRef} className="flex min-w-0 flex-1 flex-col overflow-hidden bg-background">
        <DelegatedTooltip containerRef={wideDiffRef} sideOffset={6} />
        {activeFileEntry && activeGroup ? (
          <ScrollableOverlay outerClassName="flex-1 min-h-0" disableHorizontal preventOverscroll data-diff-virtual-root>
            <div data-diff-virtual-content>
            <MultiFileDiffEntry
              key={`${activeGroup.id}:${activeFileEntry.path}`}
              visible={visible}
              directory={directory}
              file={activeFileEntry}
              layout={getLayoutForFile(activeFileEntry.path)}
              wrapLines={diffWrapLines}
              hideWhitespace={diffHideWhitespace}
              isSelected={false}
              isExpanded
              isMounted={wideSettled}
              hideExpandChevron
              onSelect={() => {}}
              onExpandedChange={() => {}}
              registerSectionRef={noopRegisterRef}
              showOpenInEditorAction
              isOpeningInEditor={openingEditorFilePath === activeFileEntry.path}
              onOpenInEditor={(path, data) => onOpenInEditor(path, data, activeIsStaged)}
              staged={activeIsStaged}
              commentOrigin={activeIsStaged ? STAGED_ORIGIN : WORKING_ORIGIN}
              hunkActionsEnabled
              contentRevision={contentRevisionOf(activeFileEntry.path)}
              {...findPropsFor(activeGroup.id as WorkingEntrySelection['groupId'], activeFileEntry.path)}
              leadingAction={
                <StageActionButton
                  symbol={activeGroup.actionSymbol}
                  label={activeGroup.getActionLabel(activeFileEntry.path)}
                  tooltip={t(activeGroup.actionSymbol === '+' ? 'contextTooltips.git.stageFile' : 'contextTooltips.git.unstageFile')}
                  onClick={() => activeGroup.onActionFile(activeFileEntry.path)}
                />
              }
              extraFileActions={
                activeGroup.showRevertActions !== false ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        disabled={revertingPaths.has(activeFileEntry.path)}
                        onClick={(e) => {
                          e.stopPropagation();
                          void requestRevertFile(activeGroup, activeFileEntry.path);
                        }}
                        aria-label={t('gitView.changes.revertFileAria', { path: activeFileEntry.path })}
                        className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-interactive-hover hover:text-[var(--status-error)]"
                      >
                        <Icon
                          name={revertingPaths.has(activeFileEntry.path) ? 'loader-4' : 'arrow-go-back'}
                          className={cn('size-3.5', revertingPaths.has(activeFileEntry.path) && 'animate-spin')}
                        />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="top" sideOffset={6}>{t('gitView.changes.revertFileConfirm')}</TooltipContent>
                  </Tooltip>
                ) : null
              }
            />
            </div>
          </ScrollableOverlay>
        ) : null}
      </div>
    </div>
  );

  let expandedRows = 0;
  let rowIndex = 0;
  for (const group of visibleGroups) {
    if (collapsedGroups.has(group.id)) continue;
    for (const file of group.entries) {
      rowIndex += 1;
      if (expandedKeys.has(makeEntryKey(group.id, file.path))) expandedRows = rowIndex;
    }
  }

  const narrowBody = (
    <div ref={narrowListRef} className="flex min-h-0 flex-1 flex-col overflow-hidden" aria-busy={hasPendingIndexMutation || undefined}>
      <DelegatedTooltip containerRef={narrowListRef} sideOffset={6} />
      <ScrollableOverlay
        outerClassName="flex-1 min-h-0"
        className="pb-3"
        disableHorizontal
        preventOverscroll
        data-diff-virtual-root
      >
        <div data-diff-virtual-content>
        <div aria-hidden className="h-1" />
        <ProgressiveRows minimum={expandedRows}>{(limit) => {
        let rowBudget = limit;
        return visibleGroups.map((group) => {
          const isCollapsed = collapsedGroups.has(group.id);
          const shownEntries = isCollapsed ? [] : group.entries.slice(0, Math.max(0, rowBudget));
          rowBudget -= shownEntries.length;
          const isStaged = group.statsScope === 'staged';
          const showRevert = group.showRevertActions !== false;

          return (
            <div key={group.id} className="mb-1">
              {renderGroupHeader(group)}
              {!isCollapsed && (
                <div className="flex flex-col">
                  {shownEntries.map((file) => {
                    const entryKey = makeEntryKey(group.id, file.path);
                    const fileEntry = toFileEntry(file, group.statsScope, diffStats);
                    const isExpanded = expandedKeys.has(entryKey);
                    const isReverting = revertingPaths.has(file.path);

                    return (
                      <MultiFileDiffEntry
                        key={entryKey}
                        visible={visible}
                        directory={directory}
                        file={fileEntry}
                        layout={getLayoutForFile(file.path)}
                        wrapLines={diffWrapLines}
                        hideWhitespace={diffHideWhitespace}
                        isSelected={false}
                        isExpanded={isExpanded}
                        isMounted={isExpanded}
                        onSelect={() => {}}
                        onExpandedChange={(_path, nextExpanded) => {
                          onToggleExpandedKey(entryKey, nextExpanded);
                          if (nextExpanded) onSelectEntry({ groupId: group.id as WorkingEntrySelection['groupId'], path: file.path });
                        }}
                        registerSectionRef={registerSectionRef[group.id === 'staged' ? 'staged' : 'unstaged']}
                        showOpenInEditorAction
                        isOpeningInEditor={openingEditorFilePath === file.path}
                        onOpenInEditor={(path, data) => onOpenInEditor(path, data, isStaged)}
                        staged={isStaged}
                        commentOrigin={isStaged ? STAGED_ORIGIN : WORKING_ORIGIN}
                        hunkActionsEnabled
                        contentRevision={contentRevisionOf(file.path)}
                        {...findPropsFor(group.id as WorkingEntrySelection['groupId'], file.path)}
                        leadingAction={
                          <StageActionButton
                            symbol={group.actionSymbol}
                            label={group.getActionLabel(file.path)}
                            tooltip={t(group.actionSymbol === '+' ? 'contextTooltips.git.stageFile' : 'contextTooltips.git.unstageFile')}
                            onClick={() => group.onActionFile(file.path)}
                          />
                        }
                        extraFileActions={
                          showRevert ? (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <button
                                  type="button"
                                  disabled={isReverting}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    void requestRevertFile(group, file.path);
                                  }}
                                  aria-label={t('gitView.changes.revertFileAria', { path: file.path })}
                                  className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-interactive-hover hover:text-[var(--status-error)]"
                                >
                                  <Icon name={isReverting ? 'loader-4' : 'arrow-go-back'} className={cn('size-3.5', isReverting && 'animate-spin')} />
                                </button>
                              </TooltipTrigger>
                              <TooltipContent side="top" sideOffset={6}>{t('gitView.changes.revertFileConfirm')}</TooltipContent>
                            </Tooltip>
                          ) : null
                        }
                      />
                    );
                  })}
                </div>
              )}
            </div>
          );
        });
        }}</ProgressiveRows>
        {renderRevertAllButton()}
        </div>
      </ScrollableOverlay>
      <div className="shrink-0 border-t border-edge-muted bg-background px-4">
        {commitSlot}
      </div>
    </div>
  );

  return (
    <>
      {confirmDialog.dialog}
      <div ref={findRootRef} data-find-surface="" className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
        <GitDiffFindBar find={diffFind} focusNonce={findFocusNonce} />
        {isWide ? wideBody : narrowBody}
      </div>
    </>
  );
};
