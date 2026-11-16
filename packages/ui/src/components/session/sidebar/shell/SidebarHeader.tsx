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
import { resolveSidebarGrouping, useSessionDisplayStore } from '@/stores/useSessionDisplayStore';
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
  showPagesSection: boolean;
  headerActionIconClass: string;
  headerActionButtonClass: string;
  listControlsSlot?: HTMLElement | null;
  closeSessionSearch: () => void;
  sessionSearchInputRef: React.RefObject<HTMLInputElement | null>;
  sessionSearchQuery: string;
  setSessionSearchQuery: (value: string) => void;
  searchScope: SearchScope;
  setSearchScope: (scope: SearchScope) => void;
  searchStatus: ContentSearchStatus;
  searchMatchCount: number | null;
  collapseAll: () => void;
  expandAll: () => void;
};

const IDLE_BUTTON_CLASS = 'text-muted-foreground hover:text-foreground hover:bg-transparent';

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
  const headerRef = React.useRef<HTMLDivElement | null>(null);
  const sectionsTriggerRef = React.useRef<HTMLButtonElement | null>(null);
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
  const worktreeNameByBranch = useSessionDisplayStore((state) => state.worktreeNameByBranch);
  const setWorktreeNameByBranch = useSessionDisplayStore((state) => state.setWorktreeNameByBranch);
  const projectSortOrder = useSessionDisplayStore((state) => state.projectSortOrder);
  const setProjectSortOrder = useSessionDisplayStore((state) => state.setProjectSortOrder);
  const sidebarGrouping = useSessionDisplayStore(resolveSidebarGrouping);
  const setSidebarGrouping = useSessionDisplayStore((state) => state.setSidebarGrouping);
  const projectDisplayMode = useSessionDisplayStore((state) => state.projectDisplayMode);
  const setProjectDisplayMode = useSessionDisplayStore((state) => state.setProjectDisplayMode);
  const timeGrouping = showProjectDisplayControls && sidebarGrouping === 'time';
  const isSingleProjectMode = showProjectDisplayControls && projectDisplayMode === 'single' && !timeGrouping;

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
  if (showProjectDisplayControls) {
    displayMenuSections.push(choiceSubmenu({ labelKey: 'sessions.sidebar.header.listGrouping.label', icon: sidebarGrouping === 'time' ? 'time' : 'folders' }, [
      ['project', 'sessions.sidebar.header.listGrouping.project'],
      ['time', 'sessions.sidebar.header.listGrouping.time'],
    ] as const, sidebarGrouping, (grouping) => {
      setSidebarGrouping(grouping);
      void updateDesktopSettings({ sidebarGrouping: grouping });
    }));
  }
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
      {toggleItem({ labelKey: 'sessions.sidebar.header.displayMode.detailedZoneRows', icon: 'list-check-2' }, detailedZoneRows, () => {
        setDetailedZoneRows(!detailedZoneRows);
        void updateDesktopSettings({ sidebarDetailedZoneRows: !detailedZoneRows });
      })}
      {toggleItem({ labelKey: 'sessions.sidebar.header.displayMode.worktreeNameByBranch', icon: 'git-branch' }, worktreeNameByBranch, () => {
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
  displayMenuSections.push(<MarkAllReadItem />);

  const searchText = sessionSearchQuery.trim();
  const canSaveSearch = showSectionControls && searchText !== '' && !searchText.toLowerCase().startsWith('ses_')
    && canAddSidebarSection(sidebarSections);
  const saveSearchAsSection = () => {
    const section = createSidebarSectionFromTemplate('blank', searchText.slice(0, SIDEBAR_SECTION_NAME_MAX));
    editSection({ ...section, filter: { ...section.filter, text: [searchText.slice(0, SIDEBAR_SECTION_TEXT_MAX)] } }, true);
    closeSessionSearch();
  };

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
      {listControlsSlot
        ? createPortal(<div className="flex items-center gap-1.5 pe-2.5">{listControls}</div>, listControlsSlot)
        : null}
    </div>
  );
}
