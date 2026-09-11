import React from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { Icon } from "@/components/icon/Icon";
import { ArrowsMerge } from '@/components/icons/ArrowsMerge';
import { useSessionDisplayStore } from '@/stores/useSessionDisplayStore';
import { useSessionMultiSelectStore } from '@/stores/useSessionMultiSelectStore';
import { useI18n } from '@/lib/i18n';
import { updateDesktopSettings } from '@/lib/persistence';

type Props = {
  hideDirectoryControls: boolean;
  showProjectDisplayControls: boolean;
  showRecentControls: boolean;
  handleOpenDirectoryDialog: () => void;
  onOpenScheduled: () => void;
  onOpenMultiRun: () => void;
  canOpenMultiRun: boolean;
  onOpenArchive: () => void;
  headerActionIconClass: string;
  headerActionButtonClass: string;
  isSessionSearchOpen: boolean;
  setIsSessionSearchOpen: (open: boolean | ((prev: boolean) => boolean)) => void;
  sessionSearchInputRef: React.RefObject<HTMLInputElement | null>;
  sessionSearchQuery: string;
  setSessionSearchQuery: (value: string) => void;
  hasSessionSearchQuery: boolean;
  searchMatchCount: number;
  collapseAllProjects: () => void;
  expandAllProjects: () => void;
};

export function SidebarHeader(props: Props): React.ReactNode {
  const { t } = useI18n();
  const {
    hideDirectoryControls,
    showProjectDisplayControls,
    showRecentControls,
    handleOpenDirectoryDialog,
    onOpenScheduled,
    onOpenMultiRun,
    canOpenMultiRun,
    onOpenArchive,
    headerActionIconClass,
    headerActionButtonClass,
    isSessionSearchOpen,
    setIsSessionSearchOpen,
    sessionSearchInputRef,
    sessionSearchQuery,
    setSessionSearchQuery,
    hasSessionSearchQuery,
    searchMatchCount,
    collapseAllProjects,
    expandAllProjects,
  } = props;

  const selectionModeEnabled = useSessionMultiSelectStore((state) => state.enabled);
  const toggleSelectionMode = useSessionMultiSelectStore((state) => state.toggleMode);

  const showRecentSection = useSessionDisplayStore((state) => state.showRecentSection);
  const toggleRecentSection = useSessionDisplayStore((state) => state.toggleRecentSection);
  const projectSortOrder = useSessionDisplayStore((state) => state.projectSortOrder);
  const setProjectSortOrder = useSessionDisplayStore((state) => state.setProjectSortOrder);
  const sessionGroupingMode = useSessionDisplayStore((state) => state.sessionGroupingMode);
  const setSessionGroupingMode = useSessionDisplayStore((state) => state.setSessionGroupingMode);
  const stickyZoneHeaders = useSessionDisplayStore((state) => state.stickyZoneHeaders);
  const toggleStickyZoneHeaders = useSessionDisplayStore((state) => state.toggleStickyZoneHeaders);
  const projectDisplayMode = useSessionDisplayStore((state) => state.projectDisplayMode);
  const setProjectDisplayMode = useSessionDisplayStore((state) => state.setProjectDisplayMode);
  const isSingleProjectMode = showProjectDisplayControls && projectDisplayMode === 'single';

  if (hideDirectoryControls) {
    return null;
  }

  return (
    <div className="select-none flex-shrink-0 px-2.5 py-1">
      <div className="flex h-auto min-h-8 flex-col gap-1">
        <div className="flex h-8 items-center justify-between gap-2">
          {/* Quiet toolbar under the New-session CTA: project/surface entry
              points at left, list controls at right. ml-[3px] compensates the
              icon inset inside the 24px buttons so the first glyph lines up
              with the New-session icon above (16px from the sidebar edge). */}
          <div className="ml-[3px] flex items-center gap-1.5">
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={handleOpenDirectoryDialog}
                  className={cn(headerActionButtonClass, 'text-muted-foreground hover:text-foreground hover:bg-transparent')}
                  aria-label={t('sessions.sidebar.header.actions.addProject')}
                >
                  <Icon name="folder-add" className={headerActionIconClass} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={4}><p>{t('sessions.sidebar.header.actions.addProject')}</p></TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={onOpenScheduled}
                  className={cn(headerActionButtonClass, 'text-muted-foreground hover:text-foreground hover:bg-transparent')}
                  aria-label={t('sessions.sidebar.header.actions.scheduledTasks')}
                >
                  <Icon name="calendar-schedule" className={headerActionIconClass} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={4}><p>{t('sessions.sidebar.header.actions.scheduledTasks')}</p></TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={onOpenMultiRun}
                  className={cn(headerActionButtonClass, 'text-muted-foreground hover:text-foreground hover:bg-transparent')}
                  aria-label={t('sessions.sidebar.header.actions.newMultiRun')}
                  disabled={!canOpenMultiRun}
                >
                  <ArrowsMerge className={headerActionIconClass} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={4}><p>{t('sessions.sidebar.header.actions.newMultiRun')}</p></TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={onOpenArchive}
                  className={cn(headerActionButtonClass, 'text-muted-foreground hover:text-foreground hover:bg-transparent')}
                  aria-label={t('sessions.sidebar.nav.archive')}
                >
                  <Icon name="archive" className={headerActionIconClass} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={4}><p>{t('sessions.sidebar.nav.archive')}</p></TooltipContent>
            </Tooltip>
          </div>

          <div className="flex items-center gap-1.5">
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={() => setIsSessionSearchOpen((prev) => !prev)}
                  className={cn(headerActionButtonClass, 'text-muted-foreground hover:text-foreground hover:bg-transparent')}
                  aria-label={t('sessions.sidebar.header.actions.searchSessions')}
                  aria-expanded={isSessionSearchOpen}
                >
                  <Icon name="search" className={headerActionIconClass} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={4}><p>{t('sessions.sidebar.header.actions.searchSessions')}</p></TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={toggleSelectionMode}
                  className={cn(headerActionButtonClass, 'text-muted-foreground hover:text-foreground hover:bg-transparent', selectionModeEnabled && 'bg-interactive-hover text-primary')}
                  aria-label={selectionModeEnabled
                    ? t('sessions.sidebar.header.actions.exitSelection')
                    : t('sessions.sidebar.header.actions.selectSessions')}
                  aria-pressed={selectionModeEnabled}
                >
                  <Icon name="checkbox-multiple" className={headerActionIconClass} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={4}>
                <p>{selectionModeEnabled
                  ? t('sessions.sidebar.header.actions.exitSelection')
                  : t('sessions.sidebar.header.actions.selectSessions')}</p>
              </TooltipContent>
            </Tooltip>

            <DropdownMenu>
              <Tooltip>
                <TooltipTrigger asChild>
                  <DropdownMenuTrigger asChild>
                    <button
                      type="button"
                      className={cn(headerActionButtonClass, 'text-muted-foreground hover:text-foreground hover:bg-transparent')}
                      aria-label={t('sessions.sidebar.header.displayMode.label')}
                    >
                      <Icon name="equalizer-2" className={headerActionIconClass} />
                    </button>
                  </DropdownMenuTrigger>
                </TooltipTrigger>
                <TooltipContent side="bottom" sideOffset={4}><p>{t('sessions.sidebar.header.displayMode.label')}</p></TooltipContent>
              </Tooltip>
              <DropdownMenuContent align="end" className="min-w-[180px]">
                <DropdownMenuLabel>{t('sessions.sidebar.header.actions.sortProjects')}</DropdownMenuLabel>
                {([
                  ['manual', 'sessions.sidebar.header.projectSort.manual'],
                  ['a-z', 'sessions.sidebar.header.projectSort.aToZ'],
                  ['z-a', 'sessions.sidebar.header.projectSort.zToA'],
                  ['date-added', 'sessions.sidebar.header.projectSort.dateAdded'],
                  ['recent', 'sessions.sidebar.header.projectSort.recent'],
                ] as const).map(([order, labelKey]) => (
                  <DropdownMenuItem
                    key={order}
                    onClick={() => {
                      setProjectSortOrder(order);
                      void updateDesktopSettings({ sidebarProjectSortOrder: order });
                    }}
                    className="flex items-center justify-between"
                  >
                    <span>{t(labelKey)}</span>
                    {projectSortOrder === order ? <Icon name="check" className="h-4 w-4 text-primary" /> : null}
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                {showProjectDisplayControls ? (
                  <>
                    <DropdownMenuLabel>{t('sessions.sidebar.header.projectDisplay.label')}</DropdownMenuLabel>
                    {([
                      ['all', 'sessions.sidebar.header.projectDisplay.all'],
                      ['single', 'sessions.sidebar.header.projectDisplay.single'],
                    ] as const).map(([mode, labelKey]) => (
                      <DropdownMenuItem
                        key={mode}
                        onClick={() => {
                          setProjectDisplayMode(mode);
                          void updateDesktopSettings({ sidebarProjectDisplayMode: mode });
                        }}
                        className="flex items-center justify-between"
                      >
                        <span>{t(labelKey)}</span>
                        {projectDisplayMode === mode ? <Icon name="check" className="h-4 w-4 text-primary" /> : null}
                      </DropdownMenuItem>
                    ))}
                    <DropdownMenuSeparator />
                  </>
                ) : null}
                <DropdownMenuLabel>{t('sessions.sidebar.header.grouping.label')}</DropdownMenuLabel>
                {([
                  ['by-worktree', 'sessions.sidebar.header.grouping.byWorktree'],
                  ['flat', 'sessions.sidebar.header.grouping.flat'],
                ] as const).map(([mode, labelKey]) => (
                  <DropdownMenuItem
                    key={mode}
                    onClick={() => {
                      setSessionGroupingMode(mode);
                      void updateDesktopSettings({ sidebarSessionGroupingMode: mode });
                    }}
                    className="flex items-center justify-between"
                  >
                    <span>{t(labelKey)}</span>
                    {sessionGroupingMode === mode ? <Icon name="check" className="h-4 w-4 text-primary" /> : null}
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                {showRecentControls && !isSingleProjectMode ? (
                  <DropdownMenuItem
                    onClick={() => {
                      toggleRecentSection();
                      void updateDesktopSettings({ sidebarShowRecentSection: !showRecentSection });
                    }}
                    className="flex items-center justify-between"
                  >
                    <span>{t('sessions.sidebar.header.displayMode.showRecent')}</span>
                    {showRecentSection ? <Icon name="check" className="h-4 w-4 text-primary" /> : null}
                  </DropdownMenuItem>
                ) : null}
                <DropdownMenuItem
                  onClick={toggleStickyZoneHeaders}
                  className="flex items-center justify-between"
                >
                  <span>{t('sessions.sidebar.header.displayMode.stickyHeaders')}</span>
                  {stickyZoneHeaders ? <Icon name="check" className="h-4 w-4 text-primary" /> : null}
                </DropdownMenuItem>
                {!isSingleProjectMode ? (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={collapseAllProjects} className="flex items-center gap-2">
                      <Icon name="contract-up-down" className="h-4 w-4" />
                      <span>{t('sessions.sidebar.header.displayMode.collapseAll')}</span>
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={expandAllProjects} className="flex items-center gap-2">
                      <Icon name="expand-up-down" className="h-4 w-4" />
                      <span>{t('sessions.sidebar.header.displayMode.expandAll')}</span>
                    </DropdownMenuItem>
                  </>
                ) : null}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        {isSessionSearchOpen ? (
          <div className="pb-1">
            <div className="mb-1 flex items-center justify-between px-0.5 typography-micro text-muted-foreground/80">
              {hasSessionSearchQuery ? (
                <span>{searchMatchCount === 1
                  ? t('sessions.sidebar.header.search.matchCountSingle', { count: searchMatchCount })
                  : t('sessions.sidebar.header.search.matchCountPlural', { count: searchMatchCount })}</span>
              ) : <span />}
              <span>{t('sessions.sidebar.header.search.escapeHint')}</span>
            </div>
            <div className="relative">
              <Icon name="search" className="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input
                ref={sessionSearchInputRef}
                value={sessionSearchQuery}
                onChange={(event) => setSessionSearchQuery(event.target.value)}
                placeholder={t('sessions.sidebar.header.search.placeholder')}
                className="h-8 w-full rounded-md border border-border bg-transparent pl-8 pr-8 typography-ui-label text-foreground outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    event.stopPropagation();
                    if (hasSessionSearchQuery) {
                      setSessionSearchQuery('');
                    } else {
                      setIsSessionSearchOpen(false);
                    }
                  }
                }}
              />
              {sessionSearchQuery.length > 0 ? (
                <button
                  type="button"
                  onClick={() => setSessionSearchQuery('')}
                  className="absolute right-1 top-1/2 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:bg-interactive-hover/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                  aria-label={t('sessions.sidebar.header.search.clear')}
                >
                  <Icon name="close" className="h-3.5 w-3.5" />
                </button>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
