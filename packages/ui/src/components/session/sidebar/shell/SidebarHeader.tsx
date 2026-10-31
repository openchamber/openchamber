import React from 'react';
import { closeSectionsManager, openSectionsManager, useSidebarSectionsUiStore } from '../sections/sectionActions';
import { useOnDemandComponent } from '@/hooks/useOnDemandComponent';

const loadSectionsManager = () => import('../sections/SidebarSectionsManager').then((module) => module.SidebarSectionsManager);
import { formatShortcutForDisplay, getEffectiveShortcutCombo } from '@/lib/shortcuts';
import { TooltipLabelWithShortcut } from '@/components/ui/action-toolbar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { Icon } from "@/components/icon/Icon";
import { resolveSidebarGrouping, useSessionDisplayStore } from '@/stores/useSessionDisplayStore';
import { useSessionMultiSelectStore } from '@/stores/useSessionMultiSelectStore';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { updateDesktopSettings } from '@/lib/persistence';
import { SessionSearchInput } from '@/components/session/SessionSearchInput';
import { GuestIcon } from '@/components/layout/GuestRailIcon';
import { useGuestPages } from '@/hooks/useGuestSurfaces';
import { guestPackageIconSrc, resolveGuestIconName } from '@/lib/guests/icon';
import { getRuntimeUrlResolver } from '@/lib/runtime-url';
import { useUIStore } from '@/stores/useUIStore';
import { useEnterpriseMode } from '@/stores/useEnterprisePolicyStore';

type Props = {
  hideDirectoryControls: boolean;
  showProjectDisplayControls: boolean;
  showSectionControls: boolean;
  handleOpenDirectoryDialog: () => void;
  /** Whether the issues and pull requests board is offered. */
  showSourceBoard: boolean;
  headerActionIconClass: string;
  headerActionButtonClass: string;
  isSessionSearchOpen: boolean;
  openSessionSearch: () => void;
  /** Hides the field and drops its query. */
  closeSessionSearch: () => void;
  sessionSearchInputRef: React.RefObject<HTMLInputElement | null>;
  sessionSearchQuery: string;
  setSessionSearchQuery: (value: string) => void;
  hasSessionSearchQuery: boolean;
  searchMatchCount: number;
  collapseAll: () => void;
  expandAll: () => void;
  /** The usage stats page, which the app's own runtimes offer. */
  showStats: boolean;
};

const PRESSED_PAGE_BUTTON_CLASS = 'bg-interactive-selection text-interactive-selection-foreground hover:bg-interactive-selection hover:text-interactive-selection-foreground';
const IDLE_PAGE_BUTTON_CLASS = 'text-muted-foreground hover:text-foreground hover:bg-transparent';

export function SidebarHeader(props: Props): React.ReactNode {
  const { t } = useI18n();
  // The header spans the sidebar: the sections manager opens beside its end
  // edge, so the section being edited shows in the list as it stands.
  const headerRef = React.useRef<HTMLDivElement | null>(null);
  // The manager and its editor load the first time they open.
  const sectionsManagerOpen = useSidebarSectionsUiStore((state) => state.managerOpen);
  const SectionsManager = useOnDemandComponent(props.showSectionControls && sectionsManagerOpen, loadSectionsManager, closeSectionsManager);
  const guestPages = useGuestPages();
  const {
    hideDirectoryControls,
    showProjectDisplayControls,
    showSectionControls,
    handleOpenDirectoryDialog,
    showSourceBoard,
    headerActionIconClass,
    headerActionButtonClass,
    isSessionSearchOpen,
    openSessionSearch,
    closeSessionSearch,
    sessionSearchInputRef,
    sessionSearchQuery,
    setSessionSearchQuery,
    hasSessionSearchQuery,
    searchMatchCount,
    collapseAll,
    expandAll,
    showStats,
  } = props;

  const selectionModeEnabled = useSessionMultiSelectStore((state) => state.enabled);
  const toggleSelectionMode = useSessionMultiSelectStore((state) => state.toggleMode);

  const isSourceBoardOpen = useUIStore((state) => state.isSourceBoardOpen);
  const isOverviewOpen = useUIStore((state) => state.isOverviewOpen);
  const overviewAvailable = useUIStore((state) => state.overviewFeatureAvailable);
  const isScheduledOpen = useUIStore((state) => state.isScheduledTasksDialogOpen);
  const isArchiveOpen = useUIStore((state) => state.isArchivePageOpen);
  const isIntegrationsCatalogOpen = useUIStore((state) => state.isIntegrationsCatalogOpen);
  const enterpriseMode = useEnterpriseMode();
  const openGuestPageId = useUIStore((state) => state.openGuestPageId);
  const isUsageOpen = useUIStore((state) => state.isUsageStatsPageOpen);

  const detailedZoneRows = useSessionDisplayStore((state) => state.detailedZoneRows);
  const setDetailedZoneRows = useSessionDisplayStore((state) => state.setDetailedZoneRows);
  const worktreeNameByBranch = useSessionDisplayStore((state) => state.worktreeNameByBranch);
  const setWorktreeNameByBranch = useSessionDisplayStore((state) => state.setWorktreeNameByBranch);
  const projectSortOrder = useSessionDisplayStore((state) => state.projectSortOrder);
  const setProjectSortOrder = useSessionDisplayStore((state) => state.setProjectSortOrder);
  const sidebarGrouping = useSessionDisplayStore(resolveSidebarGrouping);
  const setSidebarGrouping = useSessionDisplayStore((state) => state.setSidebarGrouping);
  const projectDisplayMode = useSessionDisplayStore((state) => state.projectDisplayMode);
  const setProjectDisplayMode = useSessionDisplayStore((state) => state.setProjectDisplayMode);
  // VS Code always groups under its workspace.
  const timeGrouping = showProjectDisplayControls && sidebarGrouping === 'time';
  const isSingleProjectMode = showProjectDisplayControls && projectDisplayMode === 'single';

  // One choice per line, rarely touched orders behind submenus that name the
  // current choice, so the menu stays short: selection first, then the view,
  // its orders, the sections, and collapse.
  const checkMark = <Icon name="check" className="h-4 w-4 text-primary" />;
  const choiceSubmenu = <T extends string>(
    labelKey: I18nKey,
    options: readonly (readonly [T, I18nKey])[],
    current: T,
    onSelect: (value: T) => void,
  ) => {
    const currentLabelKey = options.find(([value]) => value === current)?.[1];
    return (
      <DropdownMenuSub>
        <DropdownMenuSubTrigger>
          <span className="flex-1">{t(labelKey)}</span>
          {currentLabelKey ? <span className="ms-4 text-muted-foreground">{t(currentLabelKey)}</span> : null}
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent className="min-w-[160px]">
          {options.map(([value, optionLabelKey]) => (
            <DropdownMenuItem key={value} onClick={() => onSelect(value)} className="flex items-center justify-between">
              <span>{t(optionLabelKey)}</span>
              {current === value ? checkMark : null}
            </DropdownMenuItem>
          ))}
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    );
  };
  const toggleItem = (labelKey: I18nKey, checked: boolean, onToggle: () => void) => (
    <DropdownMenuItem onClick={onToggle} className="flex items-center justify-between">
      <span>{t(labelKey)}</span>
      {checked ? checkMark : null}
    </DropdownMenuItem>
  );
  // Select sessions and the sections manager each open a mode or a surface of
  // the list, so they share the first group; the manager arranges the sections
  // and edits the user's own.
  const displayMenuSections: React.ReactNode[] = [
    <>
      <DropdownMenuItem onClick={toggleSelectionMode} className="flex items-center gap-2">
        <Icon name="checkbox-multiple" className="h-4 w-4" />
        <span>{selectionModeEnabled
          ? t('sessions.sidebar.header.actions.exitSelection')
          : t('sessions.sidebar.header.actions.selectSessions')}</span>
      </DropdownMenuItem>
      {showSectionControls ? (
        <DropdownMenuItem onClick={openSectionsManager} className="flex items-center gap-2">
          <Icon name="stack" className="h-4 w-4" />
          <span>{t('sessions.sidebar.sections.open')}</span>
        </DropdownMenuItem>
      ) : null}
    </>,
  ];
  // One view: works under their projects, or every project's works in one
  // list by time, which has no project headers to sort.
  if (showProjectDisplayControls) {
    displayMenuSections.push(choiceSubmenu('sessions.sidebar.header.listGrouping.label', [
      ['project', 'sessions.sidebar.header.listGrouping.project'],
      ['time', 'sessions.sidebar.header.listGrouping.time'],
    ] as const, sidebarGrouping, (grouping) => {
      setSidebarGrouping(grouping);
      void updateDesktopSettings({ sidebarGrouping: grouping });
    }));
  }
  displayMenuSections.push(<>
    {!timeGrouping ? choiceSubmenu('sessions.sidebar.header.actions.sortProjects', [
      ['manual', 'sessions.sidebar.header.projectSort.manual'],
      ['a-z', 'sessions.sidebar.header.projectSort.aToZ'],
      ['z-a', 'sessions.sidebar.header.projectSort.zToA'],
      ['date-added', 'sessions.sidebar.header.projectSort.dateAdded'],
      ['recent', 'sessions.sidebar.header.projectSort.recent'],
    ] as const, projectSortOrder, (order) => {
      setProjectSortOrder(order);
      void updateDesktopSettings({ sidebarProjectSortOrder: order });
    }) : null}
    {showProjectDisplayControls ? choiceSubmenu('sessions.sidebar.header.projectDisplay.label', [
      ['all', 'sessions.sidebar.header.projectDisplay.all'],
      ['single', 'sessions.sidebar.header.projectDisplay.single'],
    ] as const, projectDisplayMode, (mode) => {
      setProjectDisplayMode(mode);
      void updateDesktopSettings({ sidebarProjectDisplayMode: mode });
    }) : null}
  </>);
  if (showSectionControls) {
    displayMenuSections.push(<>
      {/* Rows that mix projects keep one line unless asked. */}
      {toggleItem('sessions.sidebar.header.displayMode.detailedZoneRows', detailedZoneRows, () => {
        setDetailedZoneRows(!detailedZoneRows);
        void updateDesktopSettings({ sidebarDetailedZoneRows: !detailedZoneRows });
      })}
      {toggleItem('sessions.sidebar.header.displayMode.worktreeNameByBranch', worktreeNameByBranch, () => {
        setWorktreeNameByBranch(!worktreeNameByBranch);
        void updateDesktopSettings({ sidebarWorktreeNameByBranch: !worktreeNameByBranch });
      })}
    </>);
  }
  if (!isSingleProjectMode) {
    displayMenuSections.push(<>
      <DropdownMenuItem onClick={collapseAll} className="flex items-center gap-2">
        <Icon name="contract-up-down" className="h-4 w-4" />
        <span>{t('sessions.sidebar.header.displayMode.collapseAll')}</span>
      </DropdownMenuItem>
      <DropdownMenuItem onClick={expandAll} className="flex items-center gap-2">
        <Icon name="expand-up-down" className="h-4 w-4" />
        <span>{t('sessions.sidebar.header.displayMode.expandAll')}</span>
      </DropdownMenuItem>
    </>);
  }

  // The pages the sidebar opens in the main area, most used first. Each item
  // is a toggle: it carries a check while its page is open and closes it.
  const shortcutOverrides = useUIStore((state) => state.shortcutOverrides);
  const sourceBoardShortcut = formatShortcutForDisplay(getEffectiveShortcutCombo('toggle_source_board', shortcutOverrides), '');
  const ui = useUIStore.getState;
  const morePageItems: { key: string; label: string; icon: React.ReactNode; open: boolean; onToggle: () => void }[] = [];
  if (showSourceBoard && overviewAvailable) {
    morePageItems.push({ key: 'overview', label: t('overview.title'), icon: <Icon name="compass-3" className="h-4 w-4" />, open: isOverviewOpen, onToggle: () => ui().setOverviewOpen(!isOverviewOpen) });
  }
  if (showSourceBoard) {
    morePageItems.push({ key: 'source-board', label: t('sourceBoard.title'), icon: <Icon name="git-pull-request" className="h-4 w-4" />, open: isSourceBoardOpen, onToggle: () => ui().setSourceBoardOpen(!isSourceBoardOpen) });
  }
  morePageItems.push(
    { key: 'scheduled', label: t('sessions.sidebar.header.actions.scheduledTasks'), icon: <Icon name="calendar-schedule" className="h-4 w-4" />, open: isScheduledOpen, onToggle: () => ui().setScheduledTasksDialogOpen(!isScheduledOpen) },
    { key: 'archive', label: t('sessions.sidebar.nav.archive'), icon: <Icon name="archive" className="h-4 w-4" />, open: isArchiveOpen, onToggle: () => ui().setArchivePageOpen(!isArchiveOpen) },
  );
  if (showStats) {
    morePageItems.push({ key: 'stats', label: t('usageStats.openAction'), icon: <Icon name="bar-chart" className="h-4 w-4" />, open: isUsageOpen, onToggle: () => ui().setUsageStatsPageOpen(!isUsageOpen) });
  }
  // The bundled catalog offers outside services; enterprise mode waits for
  // administrator-curated sources instead.
  if (!enterpriseMode) {
    morePageItems.push({ key: 'integrations', label: t('integrationsCatalog.sidebar.open'), icon: <Icon name="store-2" className="h-4 w-4" />, open: isIntegrationsCatalogOpen, onToggle: () => ui().setIntegrationsCatalogOpen(!isIntegrationsCatalogOpen) });
  }
  const morePageOpen = morePageItems.some((page) => page.open)
    || guestPages.some((guest) => guest.id === openGuestPageId);

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
          onClose={closeSessionSearch}
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
    <div ref={headerRef} className="select-none flex-shrink-0 px-2.5 py-1">
      <div className="flex h-auto min-h-8 flex-col gap-1">
        {/* Quiet toolbar at the top of the list: the list's own controls
            first, then one menu with the pages the sidebar opens. ms-[3px]
            compensates the icon inset inside the 24px buttons so the first
            glyph sits 16px from the sidebar edge, in line with the titlebar
            controls. */}
        <div className="ms-[3px] flex min-h-8 items-center gap-1.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={isSessionSearchOpen ? closeSessionSearch : openSessionSearch}
                className={cn(headerActionButtonClass, isSessionSearchOpen ? PRESSED_PAGE_BUTTON_CLASS : IDLE_PAGE_BUTTON_CLASS)}
                aria-label={t('sessions.sidebar.header.actions.searchSessions')}
                aria-expanded={isSessionSearchOpen}
              >
                <Icon name="search" className={headerActionIconClass} />
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom" sideOffset={4}><TooltipLabelWithShortcut label={t('sessions.sidebar.header.actions.searchSessions')} shortcut={formatShortcutForDisplay(getEffectiveShortcutCombo('open_session_list', shortcutOverrides), '')} /></TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={handleOpenDirectoryDialog}
                className={cn(headerActionButtonClass, IDLE_PAGE_BUTTON_CLASS)}
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
                    className={cn(headerActionButtonClass, IDLE_PAGE_BUTTON_CLASS)}
                    aria-label={t('sessions.sidebar.header.displayMode.label')}
                  >
                    <Icon name="equalizer-2" className={headerActionIconClass} />
                  </button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={4}><p>{t('sessions.sidebar.header.displayMode.label')}</p></TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="start" className="min-w-[200px]">
              {displayMenuSections.map((section, index) => (
                <React.Fragment key={index}>
                  {index > 0 ? <DropdownMenuSeparator /> : null}
                  {section}
                </React.Fragment>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          {showSectionControls && SectionsManager ? <SectionsManager anchor={headerRef} /> : null}

          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    // A page from the menu is open: the trigger says where it came from.
                    className={cn(headerActionButtonClass, IDLE_PAGE_BUTTON_CLASS, morePageOpen && 'text-foreground')}
                    aria-label={t('sessions.sidebar.header.actions.more')}
                  >
                    <Icon name="more" className={headerActionIconClass} />
                  </button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={4}><p>{t('sessions.sidebar.header.actions.more')}</p></TooltipContent>
            </Tooltip>
            {/* Every page lives here, so a short window scrolls the list instead of cutting it. */}
            <DropdownMenuContent align="start" className="min-w-[200px] overflow-y-auto">
              {morePageItems.map((page) => (
                <DropdownMenuItem key={page.key} onClick={page.onToggle} className="flex items-center gap-2">
                  {page.icon}
                  <span className="flex-1">{page.label}</span>
                  {page.open ? checkMark : null}
                  {page.key === 'source-board' && sourceBoardShortcut ? <span className="ms-auto ps-3 typography-meta text-muted-foreground">{sourceBoardShortcut}</span> : null}
                </DropdownMenuItem>
              ))}
              {guestPages.length > 0 ? <>
                <DropdownMenuSeparator />
                <DropdownMenuLabel>{t('sessions.sidebar.header.actions.extensionPages')}</DropdownMenuLabel>
                {guestPages.map((guest) => {
                  const open = openGuestPageId === guest.id;
                  return (
                    <DropdownMenuItem key={guest.id} onClick={() => useUIStore.getState().setOpenGuestPage(open ? null : guest.id)} className="flex items-center gap-2">
                      <GuestIcon icon={resolveGuestIconName(guest.icon)} iconSrc={guestPackageIconSrc(guest.id, guest.icon, getRuntimeUrlResolver().authenticatedAsset)} className="size-4" />
                      <span className="flex-1">{guest.pageTitle ?? guest.name}</span>
                      {open ? checkMark : null}
                    </DropdownMenuItem>
                  );
                })}
              </> : null}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {isSessionSearchOpen ? (
          <div className="pb-1">
            <SessionSearchInput
              inputRef={sessionSearchInputRef}
              value={sessionSearchQuery}
              onSearch={setSessionSearchQuery}
              onClose={closeSessionSearch}
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
