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
import type { IconName } from '@/components/icon/icons';
import { useSessionDisplayStore } from '@/stores/useSessionDisplayStore';
import { useSessionMultiSelectStore } from '@/stores/useSessionMultiSelectStore';
import { useI18n } from '@/lib/i18n';
import { updateDesktopSettings } from '@/lib/persistence';
import { SessionSearchInput } from '@/components/session/SessionSearchInput';
import { Button } from '@/components/ui/button';
import { GuestIcon } from '@/components/layout/GuestRailIcon';
import { useGuestPages } from '@/hooks/useGuestSurfaces';
import { guestPackageIconSrc, resolveGuestIconName } from '@/lib/guests/icon';
import { getRuntimeUrlResolver } from '@/lib/runtime-url';
import { useUIStore } from '@/stores/useUIStore';

type Props = {
  hideDirectoryControls: boolean;
  showProjectDisplayControls: boolean;
  showRecentControls: boolean;
  handleOpenDirectoryDialog: () => void;
  onOpenScheduled: () => void;
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
  hasProjects: boolean;
  allSectionsCollapsed: boolean;
  collapseAllSections: () => void;
  expandAllSections: () => void;
};

export function SidebarHeader(props: Props): React.ReactNode {
  const { t } = useI18n();
  const guestPages = useGuestPages();
  const {
    hideDirectoryControls,
    showProjectDisplayControls,
    showRecentControls,
    handleOpenDirectoryDialog,
    onOpenScheduled,
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
    hasProjects,
    allSectionsCollapsed,
    collapseAllSections,
    expandAllSections,
  } = props;

  const selectionModeEnabled = useSessionMultiSelectStore((state) => state.enabled);
  const toggleSelectionMode = useSessionMultiSelectStore((state) => state.toggleMode);

  const showRecentSection = useSessionDisplayStore((state) => state.showRecentSection);
  const toggleRecentSection = useSessionDisplayStore((state) => state.toggleRecentSection);
  const projectSortOrder = useSessionDisplayStore((state) => state.projectSortOrder);
  const setProjectSortOrder = useSessionDisplayStore((state) => state.setProjectSortOrder);
  const worktreeSortOrder = useSessionDisplayStore((state) => state.worktreeSortOrder);
  const setWorktreeSortOrder = useSessionDisplayStore((state) => state.setWorktreeSortOrder);
  const sidebarViewMode = useSessionDisplayStore((state) => state.sidebarViewMode);
  const setSidebarViewMode = useSessionDisplayStore((state) => state.setSidebarViewMode);
  const projectDisplayMode = useSessionDisplayStore((state) => state.projectDisplayMode);
  const setProjectDisplayMode = useSessionDisplayStore((state) => state.setProjectDisplayMode);
  const isSingleProjectMode = showProjectDisplayControls && projectDisplayMode === 'single';
  // VS Code has no mode switch and always renders the projects view.
  const timelineView = showProjectDisplayControls && sidebarViewMode === 'timeline';

  // One toggle for the whole list: it offers "collapse all" while any project or
  // activity section is expanded, "expand all" once everything is collapsed, and
  // stays disabled when there is no project to act on.
  const offerCollapseAll = hasProjects && !allSectionsCollapsed;
  const sectionCollapseLabel = t(offerCollapseAll
    ? 'sessions.sidebar.header.displayMode.collapseAll'
    : 'sessions.sidebar.header.displayMode.expandAll');
  const sectionCollapseIcon: IconName = offerCollapseAll ? 'contract-up-down' : 'expand-up-down';

  const onToggleSectionCollapse = offerCollapseAll ? collapseAllSections : expandAllSections;

  if (hideDirectoryControls) {
    // VS Code: the sidebar is always a single workspace, so project/directory
    // controls stay hidden, but session search is still useful. Show a compact,
    // always-visible search input at the top of the sessions list.
    return (
      <div className="select-none flex-shrink-0 px-2.5 py-1.5">
        <SessionSearchInput
          inputRef={sessionSearchInputRef}
          value={sessionSearchQuery}
          onSearch={setSessionSearchQuery}
          onClose={() => setIsSessionSearchOpen(false)}
          placeholder={t('sessions.sidebar.header.search.placeholder')}
          clearLabel={t('sessions.sidebar.header.search.clear')}
          leadingHint={hasSessionSearchQuery
            ? (searchMatchCount === 1
              ? t('sessions.sidebar.header.search.matchCountSingle', { count: searchMatchCount })
              : t('sessions.sidebar.header.search.matchCountPlural', { count: searchMatchCount }))
            : undefined}
          trailingHint={t('sessions.sidebar.header.search.escapeHint')}
        />
      </div>
    );
  }

  return (
    <div className="select-none flex-shrink-0 px-2.5 py-1">
      <div className="flex h-auto min-h-8 flex-col gap-1">
        {/* h-8 is a minimum, not a fixed height: at a large interface font
            size the rem-sized buttons no longer fit one row, and the two
            clusters wrap onto a second line instead of overflowing the
            sidebar's overflow-x-hidden edge. */}
        <div className="flex min-h-8 flex-wrap items-center justify-between gap-2">
          {/* Quiet toolbar at the top of the list: project/surface entry
              points at left, list controls at right. ml-[3px] compensates the
              icon inset inside the 24px buttons so the first glyph sits 16px
              from the sidebar edge, in line with the titlebar controls. */}
          <div className="ml-[3px] flex min-w-0 items-center gap-1.5">
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
                  onClick={onOpenArchive}
                  className={cn(headerActionButtonClass, 'text-muted-foreground hover:text-foreground hover:bg-transparent')}
                  aria-label={t('sessions.sidebar.nav.archive')}
                >
                  <Icon name="archive" className={headerActionIconClass} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={4}><p>{t('sessions.sidebar.nav.archive')}</p></TooltipContent>
            </Tooltip>
            {guestPages.length > 0 && <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="xs" className="w-6 text-muted-foreground" aria-label={t('sessions.sidebar.header.actions.extensionPages')}>
                  <Icon name="apps" className={headerActionIconClass} />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuLabel>{t('sessions.sidebar.header.actions.extensionPages')}</DropdownMenuLabel>
                {guestPages.map((guest) => <DropdownMenuItem key={guest.id} onSelect={() => useUIStore.getState().setOpenGuestPage(guest.id)}>
                  <GuestIcon icon={resolveGuestIconName(guest.icon)} iconSrc={guestPackageIconSrc(guest.id, guest.icon, getRuntimeUrlResolver().authenticatedAsset)} className="size-4" />
                  <span>{guest.pageTitle ?? guest.name}</span>
                </DropdownMenuItem>)}
              </DropdownMenuContent>
            </DropdownMenu>}
          </div>

          <div className="flex min-w-0 items-center gap-1.5">
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

            {!timelineView && !isSingleProjectMode ? (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={onToggleSectionCollapse}
                    disabled={!hasProjects}
                    className={cn(headerActionButtonClass, 'text-muted-foreground hover:text-foreground hover:bg-transparent disabled:opacity-40')}
                    aria-label={sectionCollapseLabel}
                  >
                    <Icon name={sectionCollapseIcon} className={headerActionIconClass} />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="bottom" sideOffset={4}><p>{sectionCollapseLabel}</p></TooltipContent>
              </Tooltip>
            ) : null}

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
                {showProjectDisplayControls ? (
                  <>
                    <DropdownMenuLabel>{t('sessions.sidebar.header.viewMode.label')}</DropdownMenuLabel>
                    {([
                      ['projects', 'sessions.sidebar.header.viewMode.projects'],
                      ['timeline', 'sessions.sidebar.header.viewMode.timeline'],
                    ] as const).map(([mode, labelKey]) => (
                      <DropdownMenuItem
                        key={mode}
                        onClick={() => {
                          setSidebarViewMode(mode);
                          void updateDesktopSettings({ sidebarViewMode: mode });
                        }}
                        className="flex items-center justify-between"
                      >
                        <span>{t(labelKey)}</span>
                        {sidebarViewMode === mode ? <Icon name="check" className="h-4 w-4 text-primary" /> : null}
                      </DropdownMenuItem>
                    ))}
                    {timelineView ? null : <DropdownMenuSeparator />}
                  </>
                ) : null}
                {timelineView ? null : <>
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
                {/* VS Code groups by workspace only; it has no worktree groups to sort. */}
                {showProjectDisplayControls ? <>
                <DropdownMenuLabel>{t('sessions.sidebar.header.actions.sortWorktrees')}</DropdownMenuLabel>
                {([
                  ['recent', 'sessions.sidebar.header.worktreeSort.recent'],
                  ['manual', 'sessions.sidebar.header.projectSort.manual'],
                  ['a-z', 'sessions.sidebar.header.projectSort.aToZ'],
                ] as const).map(([order, labelKey]) => (
                  <DropdownMenuItem
                    key={order}
                    onClick={() => {
                      setWorktreeSortOrder(order);
                      void updateDesktopSettings({ sidebarWorktreeSortOrder: order });
                    }}
                    className="flex items-center justify-between"
                  >
                    <span>{t(labelKey)}</span>
                    {worktreeSortOrder === order ? <Icon name="check" className="h-4 w-4 text-primary" /> : null}
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                </> : null}
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
                </>}
                {!timelineView && showRecentControls && !isSingleProjectMode ? (
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
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        {isSessionSearchOpen ? (
          <div className="pb-1">
            <SessionSearchInput
              inputRef={sessionSearchInputRef}
              value={sessionSearchQuery}
              onSearch={setSessionSearchQuery}
              onClose={() => setIsSessionSearchOpen(false)}
              placeholder={t('sessions.sidebar.header.search.placeholder')}
              clearLabel={t('sessions.sidebar.header.search.clear')}
              leadingHint={hasSessionSearchQuery
                ? (searchMatchCount === 1
                  ? t('sessions.sidebar.header.search.matchCountSingle', { count: searchMatchCount })
                  : t('sessions.sidebar.header.search.matchCountPlural', { count: searchMatchCount }))
                : undefined}
              trailingHint={t('sessions.sidebar.header.search.escapeHint')}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}
