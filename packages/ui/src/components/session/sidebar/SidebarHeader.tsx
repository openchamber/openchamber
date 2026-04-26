import React from 'react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  RiCheckLine,
  RiCheckboxMultipleLine,
  RiChatNewLine,
  RiEqualizer2Line,
  RiFolderAddLine,
  RiLayoutLeftLine,
  RiSearchLine,
  RiCloseLine,
  RiContractUpDownLine,
  RiExpandUpDownLine,
  RiCalendarScheduleLine,
} from '@remixicon/react';
import { cn } from '@/lib/utils';
import { ArrowsMerge } from '@/components/icons/ArrowsMerge';
import { useSessionDisplayStore } from '@/stores/useSessionDisplayStore';
import { useI18n } from '@/lib/i18n';

type Props = {
  hideDirectoryControls: boolean;
  handleOpenDirectoryDialog: () => void;
  handleNewSession: () => void;
  canOpenMultiRun: boolean;
  openMultiRunLauncher: () => void;
  headerActionIconClass: string;
  reserveHeaderActionsSpace: boolean;
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
  openScheduledTasksDialog: () => void;
  selectionModeEnabled: boolean;
  onToggleSelectionMode: () => void;
  showSidebarToggle?: boolean;
  onToggleSidebar?: () => void;
};

export function SidebarHeader(props: Props): React.ReactNode {
  const { t } = useI18n();
  const {
    hideDirectoryControls,
    handleOpenDirectoryDialog,
    handleNewSession,
    canOpenMultiRun,
    openMultiRunLauncher,
    headerActionIconClass,
    reserveHeaderActionsSpace,
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
    openScheduledTasksDialog,
    selectionModeEnabled,
    onToggleSelectionMode,
    showSidebarToggle = false,
    onToggleSidebar,
  } = props;

  const displayMode = useSessionDisplayStore((state) => state.displayMode);
  const setDisplayMode = useSessionDisplayStore((state) => state.setDisplayMode);

  if (hideDirectoryControls) {
    return null;
  }

  return (
    <div
      className={cn(
        'select-none flex-shrink-0',
        showSidebarToggle ? 'pl-3 pr-3' : 'px-2.5 py-1',
      )}
    >
      {reserveHeaderActionsSpace ? (
        <div
          className={cn(
            'flex h-auto flex-col gap-1',
            showSidebarToggle ? 'min-h-[var(--oc-header-height,56px)] justify-center' : 'min-h-8',
          )}
        >
          <div className="flex h-8 items-center justify-between gap-2">
            <div className="flex items-center gap-1.5">
              {showSidebarToggle && onToggleSidebar ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={onToggleSidebar}
                      className="inline-flex h-8 w-8 items-center justify-center rounded-md typography-ui-label font-medium text-foreground transition-colors hover:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:pointer-events-none disabled:opacity-50"
                      aria-label={t('sessions.sidebar.header.actions.closeSessions')}
                    >
                      <RiLayoutLeftLine className="h-[18px] w-[18px]" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" sideOffset={4}><p>{t('sessions.sidebar.header.actions.closeSessions')}</p></TooltipContent>
                </Tooltip>
              ) : null}
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={handleOpenDirectoryDialog}
                    className={headerActionButtonClass}
                    aria-label={t('sessions.sidebar.header.actions.addProject')}
                  >
                    <RiFolderAddLine className={headerActionIconClass} />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom" sideOffset={4}><p>{t('sessions.sidebar.header.actions.addProject')}</p></TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={handleNewSession}
                    className={headerActionButtonClass}
                    aria-label={t('sessions.sidebar.header.actions.newSession')}
                  >
                    <RiChatNewLine className={headerActionIconClass} />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom" sideOffset={4}><p>{t('sessions.sidebar.header.actions.newSession')}</p></TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={openMultiRunLauncher}
                    className={headerActionButtonClass}
                    aria-label={t('sessions.sidebar.header.actions.newMultiRun')}
                    disabled={!canOpenMultiRun}
                  >
                    <ArrowsMerge className={headerActionIconClass} />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom" sideOffset={4}><p>{t('sessions.sidebar.header.actions.newMultiRun')}</p></TooltipContent>
              </Tooltip>
            </div>

            <div className="flex items-center gap-1.5">
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={openScheduledTasksDialog}
                    className={headerActionButtonClass}
                    aria-label={t('sessions.sidebar.header.actions.scheduledTasks')}
                  >
                    <RiCalendarScheduleLine className={headerActionIconClass} />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom" sideOffset={4}><p>{t('sessions.sidebar.header.actions.scheduledTasks')}</p></TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => setIsSessionSearchOpen((prev) => !prev)}
                    className={headerActionButtonClass}
                    aria-label={t('sessions.sidebar.header.actions.searchSessions')}
                    aria-expanded={isSessionSearchOpen}
                  >
                    <RiSearchLine className={headerActionIconClass} />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom" sideOffset={4}><p>{t('sessions.sidebar.header.actions.searchSessions')}</p></TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={onToggleSelectionMode}
                    className={cn(headerActionButtonClass, selectionModeEnabled && 'bg-interactive-hover text-primary')}
                    aria-label={selectionModeEnabled
                      ? t('sessions.sidebar.header.actions.exitSelection')
                      : t('sessions.sidebar.header.actions.selectSessions')}
                    aria-pressed={selectionModeEnabled}
                  >
                    <RiCheckboxMultipleLine className={headerActionIconClass} />
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
                        className={headerActionButtonClass}
                        aria-label={t('sessions.sidebar.header.actions.sessionDisplayMode')}
                      >
                        <RiEqualizer2Line className={headerActionIconClass} />
                      </button>
                    </DropdownMenuTrigger>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" sideOffset={4}><p>{t('sessions.sidebar.header.displayMode.label')}</p></TooltipContent>
                </Tooltip>
                <DropdownMenuContent align="end" className="min-w-[160px]">
                  <DropdownMenuItem
                    onClick={() => setDisplayMode('default')}
                    className="flex items-center justify-between"
                  >
                    <span>{t('sessions.sidebar.header.displayMode.default')}</span>
                    {displayMode === 'default' ? <RiCheckLine className="h-4 w-4 text-primary" /> : null}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => setDisplayMode('minimal')}
                    className="flex items-center justify-between"
                  >
                    <span>{t('sessions.sidebar.header.displayMode.minimal')}</span>
                    {displayMode === 'minimal' ? <RiCheckLine className="h-4 w-4 text-primary" /> : null}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={collapseAllProjects} className="flex items-center gap-2">
                    <RiContractUpDownLine className="h-4 w-4" />
                    <span>{t('sessions.sidebar.header.displayMode.collapseAll')}</span>
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={expandAllProjects} className="flex items-center gap-2">
                    <RiExpandUpDownLine className="h-4 w-4" />
                    <span>{t('sessions.sidebar.header.displayMode.expandAll')}</span>
                  </DropdownMenuItem>
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
                <RiSearchLine className="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
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
                    <RiCloseLine className="h-3.5 w-3.5" />
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
