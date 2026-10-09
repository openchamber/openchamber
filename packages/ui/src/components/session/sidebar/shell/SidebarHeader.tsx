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
  /** The issues and pull requests board; absent where it is not offered. */
  onOpenSourceBoard?: () => void;
  headerActionIconClass: string;
  headerActionButtonClass: string;
  isSessionSearchOpen: boolean;
  setIsSessionSearchOpen: (open: boolean | ((prev: boolean) => boolean)) => void;
  sessionSearchInputRef: React.RefObject<HTMLInputElement | null>;
  sessionSearchQuery: string;
  setSessionSearchQuery: (value: string) => void;
  hasSessionSearchQuery: boolean;
  searchMatchCount: number;
  collapseAll: () => void;
  expandAll: () => void;
};

/**
 * Whether every extension page gets its own button next to the built-in pages
 * without pushing into the list controls. All or nothing: once they stop
 * fitting, they all move into one menu, so a page never hops between the row
 * and the menu as the sidebar resizes. The measured parts don't change with
 * the answer, so it cannot flip back and forth on its own.
 */
function useGuestPagesFitInline(
  rowRef: React.RefObject<HTMLDivElement | null>,
  builtinPagesRef: React.RefObject<HTMLDivElement | null>,
  listControlsRef: React.RefObject<HTMLDivElement | null>,
  count: number,
): boolean {
  const [fits, setFits] = React.useState(true);
  React.useLayoutEffect(() => {
    const row = rowRef.current;
    const builtinPages = builtinPagesRef.current;
    const listControls = listControlsRef.current;
    if (!row || !builtinPages || !listControls || count === 0) return;
    const measure = () => {
      const button = builtinPages.lastElementChild;
      const buttonWidth = button ? button.getBoundingClientRect().width : 0;
      const gap = Number.parseFloat(getComputedStyle(builtinPages).columnGap) || 0;
      const rowGap = Number.parseFloat(getComputedStyle(row).columnGap) || 0;
      const needed = builtinPages.getBoundingClientRect().width + count * (gap + buttonWidth);
      const available = row.getBoundingClientRect().right - builtinPages.getBoundingClientRect().left
        - listControls.getBoundingClientRect().width - rowGap;
      setFits(needed <= available);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(row);
    observer.observe(builtinPages);
    observer.observe(listControls);
    return () => observer.disconnect();
  }, [rowRef, builtinPagesRef, listControlsRef, count]);
  return fits;
}

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
    onOpenSourceBoard,
    headerActionIconClass,
    headerActionButtonClass,
    isSessionSearchOpen,
    setIsSessionSearchOpen,
    sessionSearchInputRef,
    sessionSearchQuery,
    setSessionSearchQuery,
    hasSessionSearchQuery,
    searchMatchCount,
    collapseAll,
    expandAll,
  } = props;

  const rowRef = React.useRef<HTMLDivElement>(null);
  const builtinPagesRef = React.useRef<HTMLDivElement>(null);
  const listControlsRef = React.useRef<HTMLDivElement>(null);
  const guestPagesInline = useGuestPagesFitInline(rowRef, builtinPagesRef, listControlsRef, guestPages.length);

  const selectionModeEnabled = useSessionMultiSelectStore((state) => state.enabled);
  const toggleSelectionMode = useSessionMultiSelectStore((state) => state.toggleMode);

  const showRecentSection = useSessionDisplayStore((state) => state.showRecentSection);
  const toggleRecentSection = useSessionDisplayStore((state) => state.toggleRecentSection);
  const showChatsSection = useSessionDisplayStore((state) => state.showChatsSection);
  const setShowChatsSection = useSessionDisplayStore((state) => state.setShowChatsSection);
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
        <div ref={rowRef} className="flex min-h-8 flex-wrap items-center justify-between gap-2">
          {/* Quiet toolbar at the top of the list: the pages the sidebar opens
              at left, most used first; controls for the list itself at right.
              ml-[3px] compensates the icon inset inside the 24px buttons so the
              first glyph sits 16px from the sidebar edge, in line with the
              titlebar controls. */}
          <div className="ml-[3px] flex min-w-0 items-center gap-1.5">
            <div ref={builtinPagesRef} className="flex items-center gap-1.5">
              {onOpenSourceBoard ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={onOpenSourceBoard}
                      className={cn(headerActionButtonClass, 'text-muted-foreground hover:text-foreground hover:bg-transparent')}
                      aria-label={t('sourceBoard.title')}
                    >
                      <Icon name="todo" className={headerActionIconClass} />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" sideOffset={4}><p>{t('sourceBoard.title')}</p></TooltipContent>
                </Tooltip>
              ) : null}

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
            </div>
            {guestPagesInline ? guestPages.map((guest) => {
              const title = guest.pageTitle ?? guest.name;
              return (
                <Tooltip key={guest.id}>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      onClick={() => useUIStore.getState().setOpenGuestPage(guest.id)}
                      className={cn(headerActionButtonClass, 'text-muted-foreground hover:text-foreground hover:bg-transparent')}
                      aria-label={title}
                    >
                      <GuestIcon icon={resolveGuestIconName(guest.icon)} iconSrc={guestPackageIconSrc(guest.id, guest.icon, getRuntimeUrlResolver().authenticatedAsset)} className={headerActionIconClass} />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom" sideOffset={4}><p>{title}</p></TooltipContent>
                </Tooltip>
              );
            }) : guestPages.length > 0 && <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="xs" className="w-6 text-muted-foreground" aria-label={t('sessions.sidebar.header.actions.extensionPages')}>
                  <Icon name="puzzle" className={headerActionIconClass} />
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

          <div ref={listControlsRef} className="flex min-w-0 items-center gap-1.5">
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
                  onClick={handleOpenDirectoryDialog}
                  className={cn(headerActionButtonClass, 'text-muted-foreground hover:text-foreground hover:bg-transparent')}
                  aria-label={t('sessions.sidebar.header.actions.addProject')}
                >
                  <Icon name="folder-add" className={headerActionIconClass} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={4}><p>{t('sessions.sidebar.header.actions.addProject')}</p></TooltipContent>
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
                {showRecentControls ? (
                  <DropdownMenuItem
                    onClick={() => {
                      setShowChatsSection(!showChatsSection);
                      void updateDesktopSettings({ sidebarShowChatsSection: !showChatsSection });
                    }}
                    className="flex items-center justify-between"
                  >
                    <span>{t('sessions.sidebar.header.displayMode.showChats')}</span>
                    {showChatsSection ? <Icon name="check" className="h-4 w-4 text-primary" /> : null}
                  </DropdownMenuItem>
                ) : null}
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
                {!timelineView && !isSingleProjectMode ? (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={collapseAll} className="flex items-center gap-2">
                      <Icon name="contract-up-down" className="h-4 w-4" />
                      <span>{t('sessions.sidebar.header.displayMode.collapseAll')}</span>
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={expandAll} className="flex items-center gap-2">
                      <Icon name="expand-up-down" className="h-4 w-4" />
                      <span>{t('sessions.sidebar.header.displayMode.expandAll')}</span>
                    </DropdownMenuItem>
                  </>
                ) : null}
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={toggleSelectionMode} className="flex items-center gap-2">
                  <Icon name="checkbox-multiple" className="h-4 w-4" />
                  <span>{selectionModeEnabled
                    ? t('sessions.sidebar.header.actions.exitSelection')
                    : t('sessions.sidebar.header.actions.selectSessions')}</span>
                </DropdownMenuItem>
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
