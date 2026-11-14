import React from 'react';
import { createPortal } from 'react-dom';
import { canAddSidebarSection, closeSectionsManager, editSection, openSectionsManager, useSidebarSectionsUiStore } from '../sections/sectionActions';
import { createSidebarSectionFromTemplate, SIDEBAR_SECTION_NAME_MAX, SIDEBAR_SECTION_TEXT_MAX } from '@/lib/sidebarSections';
import { useOnDemandComponent } from '@/hooks/useOnDemandComponent';

const loadSectionsManager = () => import('../sections/SidebarSectionsManager').then((module) => module.SidebarSectionsManager);
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { Icon } from "@/components/icon/Icon";
import type { IconName } from "@/components/icon/icons";
import { resolveSidebarGrouping, resolveSidebarRowDisplayMode, useSessionDisplayStore } from '@/stores/useSessionDisplayStore';
import { useSessionMultiSelectStore } from '@/stores/useSessionMultiSelectStore';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { updateDesktopSettings } from '@/lib/persistence';
import { SessionSearchInput } from '@/components/session/SessionSearchInput';
import { markAllSessionsViewed } from '@/sync/notification-store';
import { useHasUnreadSession } from '@/sync/session-unread';
import type { SearchScope } from '@/lib/search/omniQuery';
import { SearchInMenu } from '@/components/search/SearchInMenu';
import { SearchStatusMark } from '@/components/search/SearchStatusMark';
import type { ContentSearchStatus } from '@/hooks/useConversationSearch';

type Props = {
  hideDirectoryControls: boolean;
  showProjectDisplayControls: boolean;
  showSectionControls: boolean;
  /** The sidebar lists the app's pages (the Pages section), so the manager offers it. */
  showPagesSection: boolean;
  headerActionIconClass: string;
  headerActionButtonClass: string;
  /**
   * The sidebar's top strip, beside the titlebar buttons: the sections manager
   * and the list menu go there, so the search field has its row to itself.
   * Without it they stay at the end of the search row.
   */
  listControlsSlot?: HTMLElement | null;
  /** Drops the query and its scope. */
  closeSessionSearch: () => void;
  sessionSearchInputRef: React.RefObject<HTMLInputElement | null>;
  sessionSearchQuery: string;
  setSessionSearchQuery: (value: string) => void;
  searchScope: SearchScope;
  setSearchScope: (scope: SearchScope) => void;
  searchStatus: ContentSearchStatus;
  /** Null while no search is applied or the total is not known yet. */
  searchMatchCount: number | null;
  collapseAll: () => void;
  expandAll: () => void;
};

const IDLE_BUTTON_CLASS = 'text-muted-foreground hover:text-foreground hover:bg-transparent';

/**
 * Clears every unread mark at once. It mounts only with the open menu, so the
 * sidebar does not watch the whole session list for it.
 */
function MarkAllReadItem(): React.ReactNode {
  const { t } = useI18n();
  const hasUnread = useHasUnreadSession();
  return (
    <DropdownMenuItem disabled={!hasUnread} onClick={markAllSessionsViewed} className="flex items-center gap-2">
      <Icon name="check-double" className="h-4 w-4" />
      <span>{t('sessions.sidebar.header.actions.markAllRead')}</span>
    </DropdownMenuItem>
  );
}

export function SidebarHeader(props: Props): React.ReactNode {
  const { t } = useI18n();
  // The header spans the sidebar: the sections manager opens beside its end
  // edge, so the section being edited shows in the list as it stands.
  const headerRef = React.useRef<HTMLDivElement | null>(null);
  // The button toggles the manager, so a press on it is not a press outside.
  const sectionsTriggerRef = React.useRef<HTMLButtonElement | null>(null);
  // The manager and its editor load the first time they open.
  const sectionsManagerOpen = useSidebarSectionsUiStore((state) => state.managerOpen);
  const sidebarSections = useSessionDisplayStore((state) => state.sections);
  const SectionsManager = useOnDemandComponent(props.showSectionControls && sectionsManagerOpen, loadSectionsManager, closeSectionsManager);
  const {
    hideDirectoryControls,
    showProjectDisplayControls,
    showSectionControls,
    showPagesSection,
    headerActionIconClass,
    headerActionButtonClass,
    listControlsSlot = null,
    closeSessionSearch,
    sessionSearchInputRef,
    sessionSearchQuery,
    setSessionSearchQuery,
    searchScope,
    setSearchScope,
    searchStatus,
    searchMatchCount,
    collapseAll,
    expandAll,
  } = props;

  const selectionModeEnabled = useSessionMultiSelectStore((state) => state.enabled);
  const toggleSelectionMode = useSessionMultiSelectStore((state) => state.toggleMode);


  const detailedZoneRows = useSessionDisplayStore((state) => state.detailedZoneRows);
  const setDetailedZoneRows = useSessionDisplayStore((state) => state.setDetailedZoneRows);
  const rowDisplayMode = useSessionDisplayStore(resolveSidebarRowDisplayMode);
  const setRowDisplayMode = useSessionDisplayStore((state) => state.setRowDisplayMode);
  const projectSortOrder = useSessionDisplayStore((state) => state.projectSortOrder);
  const setProjectSortOrder = useSessionDisplayStore((state) => state.setProjectSortOrder);
  const sidebarGrouping = useSessionDisplayStore(resolveSidebarGrouping);
  const setSidebarGrouping = useSessionDisplayStore((state) => state.setSidebarGrouping);
  const projectDisplayMode = useSessionDisplayStore((state) => state.projectDisplayMode);
  const setProjectDisplayMode = useSessionDisplayStore((state) => state.setProjectDisplayMode);
  // VS Code always groups under its workspace.
  const timeGrouping = showProjectDisplayControls && sidebarGrouping === 'time';
  // The list by time shows every project, whatever the project display says.
  const isSingleProjectMode = showProjectDisplayControls && projectDisplayMode === 'single' && !timeGrouping;

  // One choice per line, rarely touched orders behind submenus that name the
  // current choice, so the menu stays short: selection first, then the view,
  // its orders, the sections, and collapse. Choosing a view setting keeps the
  // menu open, so several can be set in one go; the actions close it.
  const checkMark = <Icon name="check" className="h-4 w-4 text-primary" />;
  const choiceSubmenu = <T extends string>(
    { labelKey, icon }: { labelKey: I18nKey; icon: IconName },
    options: readonly (readonly [T, I18nKey])[],
    current: T,
    onSelect: (value: T) => void,
  ) => {
    const currentLabelKey = options.find(([value]) => value === current)?.[1];
    return (
      <DropdownMenuSub>
        <DropdownMenuSubTrigger className="gap-2">
          <Icon name={icon} className="h-4 w-4" />
          <span className="flex-1">{t(labelKey)}</span>
          {currentLabelKey ? <span className="ms-4 text-muted-foreground">{t(currentLabelKey)}</span> : null}
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent className="min-w-[160px]">
          {options.map(([value, optionLabelKey]) => (
            <DropdownMenuItem key={value} closeOnClick={false} onClick={() => onSelect(value)} className="flex items-center justify-between">
              <span>{t(optionLabelKey)}</span>
              {current === value ? checkMark : null}
            </DropdownMenuItem>
          ))}
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    );
  };
  const toggleItem = ({ labelKey, icon }: { labelKey: I18nKey; icon: IconName }, checked: boolean, onToggle: () => void) => (
    <DropdownMenuItem closeOnClick={false} onClick={onToggle} className="flex items-center gap-2">
      <Icon name={icon} className="h-4 w-4" />
      <span className="flex-1">{t(labelKey)}</span>
      {checked ? checkMark : null}
    </DropdownMenuItem>
  );
  // Select sessions puts the list in a mode of its own, so it leads. The
  // sections manager is the button beside this menu.
  const displayMenuSections: React.ReactNode[] = [
    <>
      <DropdownMenuItem onClick={toggleSelectionMode} className="flex items-center gap-2">
        <Icon name="checkbox-multiple" className="h-4 w-4" />
        <span>{selectionModeEnabled
          ? t('sessions.sidebar.header.actions.exitSelection')
          : t('sessions.sidebar.header.actions.selectSessions')}</span>
      </DropdownMenuItem>
    </>,
  ];
  // One view: works under their projects, or every project's works in one
  // list by time, which has no project headers to sort.
  if (showProjectDisplayControls) {
    // The grouping's icon follows the choice, so the menu says which one the list is in.
    displayMenuSections.push(choiceSubmenu({ labelKey: 'sessions.sidebar.header.listGrouping.label', icon: sidebarGrouping === 'time' ? 'time' : 'folders' }, [
      ['project', 'sessions.sidebar.header.listGrouping.project'],
      ['time', 'sessions.sidebar.header.listGrouping.time'],
    ] as const, sidebarGrouping, (grouping) => {
      setSidebarGrouping(grouping);
      void updateDesktopSettings({ sidebarGrouping: grouping });
    }));
  }
  // Grouped by time the list has no project headers to sort and shows every
  // project, so this group is empty then and takes no separator.
  if (!timeGrouping) displayMenuSections.push(<>
    {choiceSubmenu({ labelKey: 'sessions.sidebar.header.actions.sortProjects', icon: 'arrow-up-down' }, [
      ['manual', 'sessions.sidebar.header.projectSort.manual'],
      ['a-z', 'sessions.sidebar.header.projectSort.aToZ'],
      ['z-a', 'sessions.sidebar.header.projectSort.zToA'],
      ['date-added', 'sessions.sidebar.header.projectSort.dateAdded'],
      ['recent', 'sessions.sidebar.header.projectSort.recent'],
    ] as const, projectSortOrder, (order) => {
      setProjectSortOrder(order);
      void updateDesktopSettings({ sidebarProjectSortOrder: order });
    })}
    {showProjectDisplayControls ? choiceSubmenu({ labelKey: 'sessions.sidebar.header.projectDisplay.label', icon: 'folder-open' }, [
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
      {toggleItem({ labelKey: 'sessions.sidebar.header.displayMode.detailedZoneRows', icon: 'list-check-2' }, detailedZoneRows, () => {
        setDetailedZoneRows(!detailedZoneRows);
        void updateDesktopSettings({ sidebarDetailedZoneRows: !detailedZoneRows });
      })}
      {choiceSubmenu({ labelKey: 'sessions.sidebar.header.displayMode.displayAs', icon: 'list-check-2' }, [
        ['sessions', 'sessions.sidebar.header.displayMode.sessions'],
        ['worktrees', 'sessions.sidebar.header.displayMode.worktrees'],
        ['branches', 'sessions.sidebar.header.displayMode.branches'],
      ] as const, rowDisplayMode, (mode) => {
        setRowDisplayMode(mode);
        void updateDesktopSettings({ sidebarRowDisplayMode: mode });
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
  displayMenuSections.push(<MarkAllReadItem />);

  // What the search found, kept as a section: the query becomes its words to
  // find and its name, in the editor, with the search closed so the sidebar
  // shows the section being made. An id lookup finds one session, not a topic.
  const searchText = sessionSearchQuery.trim();
  const canSaveSearch = showSectionControls && searchText !== '' && !searchText.toLowerCase().startsWith('ses_')
    && canAddSidebarSection(sidebarSections);
  const saveSearchAsSection = () => {
    const section = createSidebarSectionFromTemplate('blank', searchText.slice(0, SIDEBAR_SECTION_NAME_MAX));
    editSection({ ...section, filter: { ...section.filter, text: [searchText.slice(0, SIDEBAR_SECTION_TEXT_MAX)] } }, true);
    closeSessionSearch();
  };

  // The field's own controls: message search at work or in trouble, then the
  // one menu with where to look and what to do with the search.
  const searchTrailing = sessionSearchQuery.trim() !== '' || searchScope !== 'everything' ? <>
    <SearchStatusMark status={searchStatus} scope={searchScope} />
    <SearchInMenu
      scope={searchScope}
      onChange={setSearchScope}
      actions={canSaveSearch ? (
        <DropdownMenuItem onClick={saveSearchAsSection} className="flex items-center gap-2">
          <Icon name="stack" className="h-4 w-4" />
          <span>{t('sessions.sidebar.sections.saveSearch')}</span>
        </DropdownMenuItem>
      ) : undefined}
    />
  </> : null;

  if (hideDirectoryControls) {
    // VS Code: the sidebar is always a single workspace, so project/directory
    // controls stay hidden and the search field has the row to itself, with
    // room for the match count inside it.
    return (
      <div className="select-none flex-shrink-0 px-2 py-1">
        <SessionSearchInput
          inputRef={sessionSearchInputRef}
          value={sessionSearchQuery}
          onSearch={setSessionSearchQuery}
          onClose={closeSessionSearch}
          placeholder={t('sessions.sidebar.header.search.placeholder')}
          clearLabel={t('sessions.sidebar.header.search.clear')}
          trailing={<>
            {searchMatchCount !== null ? (
              <span className="shrink-0 px-1 typography-micro tabular-nums text-muted-foreground" aria-label={searchMatchCount === 1
                ? t('sessions.sidebar.header.search.matchCountSingle', { count: searchMatchCount })
                : t('sessions.sidebar.header.search.matchCountPlural', { count: searchMatchCount })}>{searchMatchCount}</span>
            ) : null}
            {searchTrailing}
          </>}
        />
      </div>
    );
  }

  // The sections manager and the menu of the list's own controls.
  const listControls = (
    <>
          {showSectionControls ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  ref={sectionsTriggerRef}
                  type="button"
                  onClick={sectionsManagerOpen ? closeSectionsManager : openSectionsManager}
                  className={cn(headerActionButtonClass, IDLE_BUTTON_CLASS, sectionsManagerOpen && 'text-foreground')}
                  aria-label={t('sessions.sidebar.sections.customize')}
                  aria-expanded={sectionsManagerOpen}
                >
                  <Icon name="list-settings" className={headerActionIconClass} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={4}><p>{t('sessions.sidebar.sections.customize')}</p></TooltipContent>
            </Tooltip>
          ) : null}
          {showSectionControls && SectionsManager ? <SectionsManager anchor={headerRef} trigger={sectionsTriggerRef} pages={showPagesSection} /> : null}

          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className={cn(headerActionButtonClass, IDLE_BUTTON_CLASS)}
                    aria-label={t('sessions.sidebar.header.displayMode.label')}
                  >
                    <Icon name="more" className={headerActionIconClass} />
                  </button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={4}><p>{t('sessions.sidebar.header.displayMode.label')}</p></TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="end" className="min-w-[200px]">
              {displayMenuSections.map((section, index) => (
                <React.Fragment key={index}>
                  {index > 0 ? <DropdownMenuSeparator /> : null}
                  {section}
                </React.Fragment>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
    </>
  );

  return (
    <div ref={headerRef} className="select-none flex-shrink-0 px-2.5 py-1">
      <div className="flex h-auto min-h-8 flex-col gap-1">
        {/* Quiet toolbar at the top of the list: the search field, which
            rests as an icon and a word and takes the row, then the list
            controls unless the top strip holds them. ms-[3px] compensates
            the icon inset inside the 24px buttons so the search glyph sits
            16px from the sidebar edge, in line with the titlebar controls. */}
        <div className="ms-[3px] flex min-h-8 items-center gap-1.5">
          <div className="min-w-0 flex-1">
            <SessionSearchInput
              inputRef={sessionSearchInputRef}
              value={sessionSearchQuery}
              onSearch={setSessionSearchQuery}
              onClose={closeSessionSearch}
              placeholder={t('settings.common.sidebar.searchPlaceholder')}
              label={t('sessions.sidebar.header.actions.searchSessions')}
              clearLabel={t('sessions.sidebar.header.search.clear')}
              quiet
              trailing={searchTrailing}
            />
          </div>
          {listControlsSlot ? null : listControls}
        </div>
      </div>
      {/* pe-2.5 puts the menu's end edge where the search row's padding ends. */}
      {listControlsSlot
        ? createPortal(<div className="flex items-center gap-1.5 pe-2.5">{listControls}</div>, listControlsSlot)
        : null}
    </div>
  );
}
