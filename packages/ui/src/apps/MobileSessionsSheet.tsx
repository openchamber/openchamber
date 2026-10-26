import React from 'react';
import { createPortal } from 'react-dom';
import { isIMECompositionEvent } from '@/lib/ime';
import {
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

import { DirectoryExplorerDialog } from '@/components/session/DirectoryExplorerDialog';
import { Icon } from '@/components/icon/Icon';
import { NewWorktreeDialog } from '@/components/session/NewWorktreeDialog';
import { SessionSidebar } from '@/components/session/SessionSidebar';
import { SessionSearchInput } from '@/components/session/SessionSearchInput';
import type { SessionProjectListProps } from '@/components/session/sidebar/projects/SessionProjectScroller';
import { sortProjectsByOrder } from '@/components/session/sidebar/list/projectSort';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ScrollShadow } from '@/components/ui/ScrollShadow';
import { isChatDirectoryPath } from '@/lib/chatDirectories';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { updateDesktopSettings } from '@/lib/persistence';
import { cn } from '@/lib/utils';
import { refreshGlobalSessions, useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { resolveSidebarGrouping, useSessionDisplayStore, type ProjectSortOrder } from '@/stores/useSessionDisplayStore';
import { useUIStore } from '@/stores/useUIStore';
import { seedGlobalSessionStatusFromHost } from '@/sync/host-session-status-seed';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useAllLiveSessions } from '@/sync/sync-context';
import type { WorktreeMetadata } from '@/types/worktree';

import { MobileDeleteWorktreeDialog } from './MobileDeleteWorktreeDialog';
import { MobileProjectEditSurface } from './MobileProjectEditSurface';
import { MobileProjectIcon } from './MobileProjectIcon';
import { getSessionDirectory } from './mobileSessionFields';
import { getProjectLabel, normalizePath } from './mobilePaths';
import { MobileSessionList } from './mobileSidebar/MobileSessionList';
import { MobileSidebarActionsProvider, useMobileSidebarRowsStore, type MobileSidebarActions } from './mobileSidebar/mobileSidebarState';
import { useEdgeSwipe } from './useEdgeSwipe';

type MobileSessionsSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 'drawer' (default) renders a full-width left drawer over the app;
      'sidebar' renders the same content inline for the iPad persistent
      sidebar, kept mounted while it is hidden, with `open` saying whether
      it is shown. */
  variant?: 'drawer' | 'sidebar';
  /** App-level footer bar (desktop-sidebar-style): current instance on the
      left, settings (and, on hosted web, a pending update) on the right. */
  footer?: {
    /** Connected instance label — Capacitor only; null hides the left slot. */
    instanceLabel: string | null;
    onOpenInstances?: () => void;
    onOpenSettings: () => void;
    onOpenScheduled: () => void;
    onOpenArchive: () => void;
    onOpenUsage: () => void;
    /** The overview of what waits, runs and looks done; absent while the feature is not in this build. */
    onOpenOverview?: () => void;
    /** The issues and PRs board. */
    onOpenSourceBoard: () => void;
    /** Present only while a server update is available (hosted web). */
    onOpenUpdate?: () => void;
  };
};

// Same orders, same labels as the desktop sidebar's sort menu — the setting
// itself is shared, so the two surfaces must offer the same choices.
const PROJECT_SORT_OPTIONS = [
  ['manual', 'sessions.sidebar.header.projectSort.manual'],
  ['a-z', 'sessions.sidebar.header.projectSort.aToZ'],
  ['z-a', 'sessions.sidebar.header.projectSort.zToA'],
  ['date-added', 'sessions.sidebar.header.projectSort.dateAdded'],
  ['recent', 'sessions.sidebar.header.projectSort.recent'],
] as const;

const GROUPING_OPTIONS = [
  ['project', 'sessions.sidebar.header.listGrouping.project'],
  ['time', 'sessions.sidebar.header.listGrouping.time'],
] as const;

/** Menu rows tall enough for a thumb. */
const MOBILE_MENU_ITEM_CLASS = 'min-h-10 items-center justify-between';

type ReorderProject = {
  id: string;
  label: string;
  icon?: string | null;
  color?: string | null;
  iconImage?: { mime: string; updatedAt: number; source: 'custom' | 'auto' } | null;
  iconBackground?: string | null;
};

const renderList = (props: SessionProjectListProps): React.ReactNode => <MobileSessionList {...props} />;

/** One draggable project in Reorder projects. */
const SortableProjectRow: React.FC<{ project: ReorderProject }> = ({ project }) => {
  const { t } = useI18n();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: project.id });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, zIndex: isDragging ? 10 : 1 }}
      className={cn(
        'flex items-center gap-1 rounded-2xl border border-border/70 bg-[var(--surface-elevated)] px-1.5 py-1.5 transition-colors',
        isDragging && 'shadow-lg shadow-black/20',
      )}
    >
      <button
        type="button"
        className="flex size-9 shrink-0 cursor-grab touch-none items-center justify-center rounded-xl text-muted-foreground/70 transition-colors hover:text-foreground active:cursor-grabbing"
        aria-label={t('mobile.sessions.dragHandleAria', { label: project.label })}
        {...attributes}
        {...listeners}
      >
        <Icon name="drag-move-2" className="size-4" />
      </button>
      <MobileProjectIcon project={project} />
      <span className="block min-w-0 flex-1 truncate ps-1 typography-ui-label text-foreground">{project.label}</span>
    </div>
  );
};

/**
 * The phone's sessions drawer, and the iPad's sidebar. The list is the
 * desktop's (`SessionSidebar` with the phone's rows, see
 * `mobileSidebar/MobileSessionList.tsx`); this sheet holds what surrounds it:
 * the header with the display menu and New chat, the search field, Reorder
 * projects, the footer and the dialogs the rows open.
 */
export const MobileSessionsSheet: React.FC<MobileSessionsSheetProps> = ({ open, onOpenChange, variant = 'drawer', footer }) => {
  const { t } = useI18n();
  const liveSessions = useAllLiveSessions();
  const projects = useProjectsStore((state) => state.projects);
  const manualProjectOrder = useProjectsStore((state) => state.manualProjectOrder);
  const reorderProjects = useProjectsStore((state) => state.reorderProjects);
  const openNewSessionDraft = useSessionUIStore((state) => state.openNewSessionDraft);
  const projectSortOrder = useSessionDisplayStore((state) => state.projectSortOrder);
  const setProjectSortOrder = useSessionDisplayStore((state) => state.setProjectSortOrder);
  const grouping = useSessionDisplayStore(resolveSidebarGrouping);
  const setSidebarGrouping = useSessionDisplayStore((state) => state.setSidebarGrouping);
  const showWorkSection = useSessionDisplayStore((state) => state.showWorkSection);
  const setShowWorkSection = useSessionDisplayStore((state) => state.setShowWorkSection);
  const showPinnedSection = useSessionDisplayStore((state) => state.showPinnedSection);
  const setShowPinnedSection = useSessionDisplayStore((state) => state.setShowPinnedSection);
  const keepWorkInPlace = useSessionDisplayStore((state) => state.keepWorkInPlace);
  const setKeepWorkInPlace = useSessionDisplayStore((state) => state.setKeepWorkInPlace);
  const detailedZoneRows = useSessionDisplayStore((state) => state.detailedZoneRows);
  const setDetailedZoneRows = useSessionDisplayStore((state) => state.setDetailedZoneRows);
  const sessionWorkEnabled = useUIStore((state) => state.sessionWorkEnabled);
  const hasChats = useGlobalSessionsStore((state) => state.activeSessions.some((session) => isChatDirectoryPath(getSessionDirectory(session))));
  const [query, setQuery] = React.useState('');
  const [editingProjectId, setEditingProjectId] = React.useState<string | null>(null);
  const [worktreeToDelete, setWorktreeToDelete] = React.useState<{ project: { id: string; path: string }; worktree: WorktreeMetadata } | null>(null);
  const [directoryDialogOpen, setDirectoryDialogOpen] = React.useState(false);
  const [newWorktreeDialogOpen, setNewWorktreeDialogOpen] = React.useState(false);
  const [worktreeDialogProjectId, setWorktreeDialogProjectId] = React.useState<string | null>(null);
  const [editingOrder, setEditingOrder] = React.useState(false);
  const [openId, setOpenId] = React.useState(0);
  // The iPad's sidebar keeps its search behind a header button, as the
  // desktop's does; the phone's drawer shows the field at once.
  const [searchOpen, setSearchOpen] = React.useState(false);
  const searchShown = variant === 'drawer' || searchOpen;
  const searchInputRef = React.useRef<HTMLInputElement | null>(null);
  const toggleSearch = () => {
    // Closing the field clears its query: no list stays filtered by text
    // nobody can see.
    if (searchOpen) setQuery('');
    setSearchOpen(!searchOpen);
  };
  React.useEffect(() => {
    if (searchOpen && variant === 'sidebar') searchInputRef.current?.focus();
  }, [searchOpen, variant]);

  React.useEffect(() => {
    if (!open) {
      setQuery('');
      setSearchOpen(false);
      setEditingOrder(false);
      setEditingProjectId(null);
      useMobileSidebarRowsStore.getState().reset();
      return;
    }
    setOpenId((id) => id + 1);
    // The mobile shell has no global poller, so this load is also where the
    // host seed runs, as the poller runs it after each load elsewhere: a
    // question or permission already waiting at startup is otherwise missing
    // from the cross-directory index the rows read. The seed resolves
    // directories from the list just loaded, so it runs after it.
    void refreshGlobalSessions(liveSessions).then(() => seedGlobalSessionStatusFromHost());
    // intentionally only on open transition — session events keep the list current after that
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const close = React.useCallback(() => onOpenChange(false), [onOpenChange]);
  const sidebarActions = React.useMemo<MobileSidebarActions>(() => ({
    close,
    openProjectEdit: setEditingProjectId,
    // The dialog takes the project as a prop and the created worktree's draft
    // names it: the active project stays, so the chat behind the drawer does
    // not switch to that project's last session while the dialog is open.
    openNewWorktree: (projectId) => {
      setWorktreeDialogProjectId(projectId);
      setNewWorktreeDialogOpen(true);
    },
    requestWorktreeDelete: (project, worktree) => setWorktreeToDelete({ project, worktree }),
    openId,
  }), [close, openId]);
  const clearSearch = React.useCallback(() => setQuery(''), []);
  const phoneList = React.useMemo(() => ({ searchQuery: query, clearSearch, renderList }), [clearSearch, query]);

  // Projects with the label the rows show, in the order Reorder projects drags.
  const labelledProjects = React.useMemo(() => projects.map((project) => ({
    ...project,
    label: project.label?.trim() || getProjectLabel(project.path),
  })), [projects]);
  const reorderList = React.useMemo(
    () => sortProjectsByOrder(labelledProjects, 'manual', manualProjectOrder),
    [labelledProjects, manualProjectOrder],
  );
  const editingProject = labelledProjects.find((project) => project.id === editingProjectId) ?? null;
  const worktreeDialogProject = labelledProjects.find((project) => project.id === worktreeDialogProjectId) ?? null;

  // The order and the view are shared settings of this surface, persisted as
  // the desktop does, so the choice follows the user to their other phones.
  const handleProjectSortChange = (order: ProjectSortOrder) => {
    setProjectSortOrder(order);
    void updateDesktopSettings({ sidebarProjectSortOrder: order });
    // Dragging projects rewrites the manual order; it means nothing while the
    // list is sorted by something else.
    if (order !== 'manual') setEditingOrder(false);
  };
  const handleGroupingChange = (next: 'project' | 'time') => {
    setSidebarGrouping(next);
    void updateDesktopSettings({ sidebarGrouping: next });
    // Project order means nothing without project headers.
    if (next === 'time') setEditingOrder(false);
  };
  const toggleSetting = (current: boolean, set: (next: boolean) => void, persist: (next: boolean) => void) => () => {
    set(!current);
    persist(!current);
  };

  /** One choice or switch in the display menu, checked when it is in effect. */
  const renderMenuChoice = (key: string, labelKey: I18nKey, checked: boolean, onSelect: () => void): React.ReactNode => (
    <DropdownMenuItem key={key} onClick={onSelect} className={MOBILE_MENU_ITEM_CLASS}>
      <span>{t(labelKey)}</span>
      {checked ? <Icon name="check" className="size-4 text-primary" /> : null}
    </DropdownMenuItem>
  );

  const dndSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const handleReorderDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    // The store's own list is the manual order the drag rewrites.
    const fromIndex = projects.findIndex((project) => project.id === active.id);
    const toIndex = projects.findIndex((project) => project.id === over.id);
    if (fromIndex < 0 || toIndex < 0) return;
    reorderProjects(fromIndex, toIndex);
  };

  // Drag order IS the manual order: offering it under another sort would let
  // the user rearrange a list that is about to be re-sorted anyway.
  const canEditOrder = !query && projects.length > 1 && projectSortOrder === 'manual' && grouping === 'project';

  // Sorting lives in the header next to reordering — the two answer the same
  // question about the list. Reachable with a single project too: the menu
  // also holds the view, which matters long before a second project exists.
  // While reordering runs, the menu's button gives way to Done.
  const displayMenu = !editingOrder && projects.length > 0 ? (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="chip"
          size="sm"
          aria-label={t('sessions.sidebar.header.displayMode.label')}
          title={t('sessions.sidebar.header.displayMode.label')}
          style={{ touchAction: 'manipulation' }}
        >
          <Icon name="equalizer-2" className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel>{t('sessions.sidebar.header.listGrouping.label')}</DropdownMenuLabel>
        {GROUPING_OPTIONS.map(([option, labelKey]) => renderMenuChoice(option, labelKey, grouping === option, () => handleGroupingChange(option)))}
        {/* Project order only means something while projects are groups. */}
        {grouping === 'project' ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>{t('sessions.sidebar.header.actions.sortProjects')}</DropdownMenuLabel>
            {PROJECT_SORT_OPTIONS.map(([order, labelKey]) => renderMenuChoice(order, labelKey, projectSortOrder === order, () => handleProjectSortChange(order)))}
          </>
        ) : null}
        <DropdownMenuSeparator />
        {renderMenuChoice('pinned', 'sessions.sidebar.header.displayMode.showPinned', showPinnedSection, toggleSetting(showPinnedSection, setShowPinnedSection, (next) => {
          void updateDesktopSettings({ sidebarShowPinnedSection: next });
        }))}
        {sessionWorkEnabled ? renderMenuChoice('work', 'sessions.sidebar.header.displayMode.showWork', showWorkSection, toggleSetting(showWorkSection, setShowWorkSection, (next) => {
          void updateDesktopSettings({ sidebarShowWorkSection: next });
        })) : null}
        {/* A work in In work leaves its project unless asked. */}
        {sessionWorkEnabled && showWorkSection ? renderMenuChoice('in-place', 'sessions.sidebar.header.displayMode.keepWorkInPlace', keepWorkInPlace, toggleSetting(keepWorkInPlace, setKeepWorkInPlace, (next) => {
          void updateDesktopSettings({ sidebarKeepWorkInPlace: next });
        })) : null}
        {renderMenuChoice('detailed', 'sessions.sidebar.header.displayMode.detailedZoneRows', detailedZoneRows, toggleSetting(detailedZoneRows, setDetailedZoneRows, (next) => {
          void updateDesktopSettings({ sidebarDetailedZoneRows: next });
        }))}
        {canEditOrder ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => setEditingOrder(true)} className={MOBILE_MENU_ITEM_CLASS}>
              <span className="flex items-center gap-2">
                <Icon name="drag-move-2" className="size-4" />
                {t('mobile.sessions.editOrder')}
              </span>
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  ) : null;

  const doneEditingButton = editingOrder ? (
    <Button
      type="button"
      variant="chip"
      size="sm"
      aria-label={t('mobile.sessions.doneEditing')}
      aria-pressed
      onClick={() => setEditingOrder(false)}
      style={{ touchAction: 'manipulation' }}
    >
      <Icon name="check" className="size-4" />
    </Button>
  ) : null;

  const newChatButton = !editingOrder && projects.length > 0 ? (
    <Button
      type="button"
      variant="default"
      size="sm"
      aria-label={t('mobile.sessions.newChat')}
      onClick={() => {
        openNewSessionDraft();
        close();
      }}
      style={{ touchAction: 'manipulation' }}
    >
      <Icon name="add" className="size-4" />
      {t('mobile.sessions.newChat')}
    </Button>
  ) : null;

  const addProjectButton = !editingOrder ? (
    <Button
      type="button"
      variant="chip"
      size="sm"
      aria-label={t('sessions.sidebar.header.actions.addProject')}
      title={t('sessions.sidebar.header.actions.addProject')}
      onClick={() => setDirectoryDialogOpen(true)}
      style={{ touchAction: 'manipulation' }}
    >
      <Icon name="folder-add" className="size-4" />
    </Button>
  ) : null;

  // The new-session button keeps the outer right edge whatever else is showing:
  // it is the one action people reach for without looking, so it must not slide
  // around as the icons beside it come and go.
  const trailingActions = (
    <>
      {addProjectButton}
      {displayMenu}
      {doneEditingButton}
      {newChatButton}
    </>
  );

  const empty = projects.length === 0 && !hasChats;

  // flex-1 + min-h-0 rather than h-full: both hosts put a fixed-height header
  // above this, so a 100% height overflows by exactly that header — and the
  // clipped overflow swallowed the footer.
  const surfaceContent = (
      <div className="flex min-h-0 flex-1 flex-col">
        {/* The list scrolls under the search field: the list is virtualized
            in its own scroller, which the field cannot join. */}
        {!editingOrder && !empty && searchShown ? (
          <div className={cn('shrink-0 px-3 pb-2', variant === 'sidebar' ? 'pt-2' : 'pt-1')}>
            <SessionSearchInput
              inputRef={searchInputRef}
              value={query}
              onSearch={setQuery}
              onClose={variant === 'sidebar' ? toggleSearch : undefined}
              active={open}
              mobile
              placeholder={t('mobile.sessions.search.placeholder')}
              clearLabel={t('mobile.sessions.clearSearchAria')}
            />
          </div>
        ) : null}
        {empty ? (
          <div className="min-h-0 flex-1">
            <MobileSessionsEmpty
              title={t('mobile.sessions.empty.noProjectsTitle')}
              description={t('mobile.sessions.empty.noProjectsDescription')}
              action={
                <button
                  type="button"
                  className="flex items-center justify-center gap-2 rounded-2xl bg-primary px-5 py-3 typography-ui-label text-primary-foreground transition-opacity hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  onClick={() => setDirectoryDialogOpen(true)}
                >
                  <Icon name="folder-add" className="size-4" />
                  {t('sessions.sidebar.header.actions.addProject')}
                </button>
              }
            />
          </div>
        ) : null}
        {editingOrder ? (
          <ScrollShadow className="min-h-0 flex-1 overflow-y-auto pb-4">
            <div className="flex flex-col gap-2 px-3 py-2">
              <p className="px-1 typography-micro text-muted-foreground">{t('mobile.sessions.editOrderHint')}</p>
              <DndContext sensors={dndSensors} collisionDetection={closestCenter} onDragEnd={handleReorderDragEnd}>
                <SortableContext items={reorderList.map((project) => project.id)} strategy={verticalListSortingStrategy}>
                  <div className="flex flex-col gap-1.5">
                    {reorderList.map((project) => <SortableProjectRow key={project.id} project={project} />)}
                  </div>
                </SortableContext>
              </DndContext>
            </div>
          </ScrollShadow>
        ) : null}
        {/* Mounted while reordering too, so the list comes back as it was. */}
        <div className={cn('flex min-h-0 flex-1 flex-col', (editingOrder || empty) && 'hidden')}>
          <MobileSidebarActionsProvider value={sidebarActions}>
            <SessionSidebar mobileVariant isVisible={open} phone={phoneList} />
          </MobileSidebarActionsProvider>
        </div>

        {/* App-level footer: the connected instance (Capacitor) on the left;
            on the right the pages opened less often behind "More", then a
            pending web update, the overview, the issues board and Settings.
            Settings is the one filled button; the rest are flat, as the
            header's. Bottom placement keeps the header for list actions and
            stays thumb-reachable. */}
        {footer ? (
          <div
            className="flex shrink-0 items-center justify-between gap-2 border-t border-border/70 px-3 pt-1.5"
            style={{ paddingBottom: 'calc(0.375rem + var(--oc-safe-area-bottom, 0px))' }}
          >
            <div className="flex min-w-0 items-center">
              {footer.instanceLabel && footer.onOpenInstances ? (
                <Button
                  type="button"
                  variant="info"
                  size="lg"
                  className="min-w-0 shrink justify-start"
                  onClick={footer.onOpenInstances}
                  aria-label={t('mobile.menu.instances')}
                  style={{ touchAction: 'manipulation' }}
                >
                  <Icon name="server" className="size-[18px]" />
                  <span className="block min-w-0 truncate">{footer.instanceLabel}</span>
                </Button>
              ) : null}
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    variant="chip"
                    size="lg"
                    className="w-10 shrink-0 px-0"
                    aria-label={t('mobile.sessions.footer.more')}
                    title={t('mobile.sessions.footer.more')}
                    style={{ touchAction: 'manipulation' }}
                  >
                    <Icon name="more" className="size-5" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent side="top" align="end" className="w-56">
                  <DropdownMenuItem onClick={footer.onOpenScheduled} className={MOBILE_MENU_ITEM_CLASS}>
                    <span className="flex items-center gap-2">
                      <Icon name="calendar-schedule" className="size-4" />
                      {t('sessions.sidebar.header.actions.scheduledTasks')}
                    </span>
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={footer.onOpenArchive} className={MOBILE_MENU_ITEM_CLASS}>
                    <span className="flex items-center gap-2">
                      <Icon name="archive" className="size-4" />
                      {t('sessions.sidebar.nav.archive')}
                    </span>
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={footer.onOpenUsage} className={MOBILE_MENU_ITEM_CLASS}>
                    <span className="flex items-center gap-2">
                      <Icon name="bar-chart" className="size-4" />
                      {t('usageStats.openAction')}
                    </span>
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
              {footer.onOpenUpdate ? (
                <Button
                  type="button"
                  variant="chip"
                  size="lg"
                  className="w-10 px-0"
                  onClick={footer.onOpenUpdate}
                  aria-label={t('mobile.menu.update')}
                  title={t('mobile.menu.update')}
                  style={{ touchAction: 'manipulation' }}
                >
                  <Icon name="download" className="size-5" />
                  <span className="absolute inset-e-2 top-2 inline-flex size-2 rounded-full bg-primary" aria-hidden />
                </Button>
              ) : null}
              {footer.onOpenOverview ? (
                <Button
                  type="button"
                  variant="chip"
                  size="lg"
                  className="w-10 px-0"
                  onClick={footer.onOpenOverview}
                  aria-label={t('overview.title')}
                  title={t('overview.title')}
                  style={{ touchAction: 'manipulation' }}
                >
                  <Icon name="compass-3" className="size-5" />
                </Button>
              ) : null}
              <Button
                type="button"
                variant="chip"
                size="lg"
                className="w-10 px-0"
                onClick={footer.onOpenSourceBoard}
                aria-label={t('sourceBoard.title')}
                title={t('sourceBoard.title')}
                style={{ touchAction: 'manipulation' }}
              >
                <Icon name="git-pull-request" className="size-5" />
              </Button>
              <Button
                type="button"
                variant="default"
                size="lg"
                className="w-10 px-0"
                onClick={footer.onOpenSettings}
                aria-label={t('mobile.menu.settings')}
                title={t('mobile.menu.settings')}
                style={{ touchAction: 'manipulation' }}
              >
                <Icon name="settings-3" className="size-5" />
              </Button>
            </div>
          </div>
        ) : null}

        <DirectoryExplorerDialog open={directoryDialogOpen} onOpenChange={setDirectoryDialogOpen} />
        <NewWorktreeDialog
          open={newWorktreeDialogOpen}
          onOpenChange={(value) => {
            setNewWorktreeDialogOpen(value);
            if (!value) setWorktreeDialogProjectId(null);
          }}
          project={worktreeDialogProject ? { id: worktreeDialogProject.id, path: normalizePath(worktreeDialogProject.path) } : undefined}
          onWorktreeCreated={(worktreePath) => {
            openNewSessionDraft({
              selectedProjectId: worktreeDialogProjectId,
              directoryOverride: worktreePath,
              preserveDirectoryOverride: true,
            });
            close();
          }}
        />
        <MobileProjectEditSurface
          open={editingProject !== null}
          project={editingProject}
          onClose={() => setEditingProjectId(null)}
        />
        {worktreeToDelete ? (
          <MobileDeleteWorktreeDialog
            open
            project={worktreeToDelete.project}
            worktree={worktreeToDelete.worktree}
            onClose={() => setWorktreeToDelete(null)}
          />
        ) : null}
      </div>
  );

  if (variant === 'sidebar') {
    return (
      <div className="flex h-full min-h-0 flex-col">
        {/* No title: the list below says what this is, and the actions need
            the width. Search opens from the leading button, as on the desktop. */}
        <div className="flex h-[var(--oc-header-height,56px)] shrink-0 items-center gap-2 border-b border-border/70 px-3">
          {!editingOrder && !empty ? (
            <Button
              type="button"
              variant="chip"
              size="sm"
              aria-label={t('sessions.sidebar.header.actions.searchSessions')}
              title={t('sessions.sidebar.header.actions.searchSessions')}
              aria-pressed={searchOpen}
              onClick={toggleSearch}
              style={{ touchAction: 'manipulation' }}
            >
              <Icon name="search" className="size-4" />
            </Button>
          ) : null}
          <div className="ms-auto flex shrink-0 items-center gap-2">{trailingActions}</div>
        </div>
        {surfaceContent}
      </div>
    );
  }

  return (
    <MobileSessionsDrawerContainer
      open={open}
      onClose={close}
      // The mirror of the swipe that opened the drawer closes it again —
      // except while a row has its actions out: then the same swipe is the
      // user putting those away, so it only clears them.
      onSwipeClose={() => {
        const rows = useMobileSidebarRowsStore.getState();
        if (rows.revealedKey) {
          rows.setRevealed(rows.revealedKey, false);
          return;
        }
        close();
      }}
      ariaLabel={t('mobile.sessions.sheet.title')}
    >
      <div className="flex h-[var(--oc-header-height,56px)] shrink-0 items-center gap-2 px-3">
        <button
          type="button"
          className="flex size-10 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={t('mobile.surface.closeAria')}
          onClick={close}
          style={{ touchAction: 'manipulation' }}
        >
          <Icon name="close" className="size-5" />
        </button>
        <div className="ms-auto flex shrink-0 items-center gap-2">{trailingActions}</div>
      </div>
      {surfaceContent}
    </MobileSessionsDrawerContainer>
  );
};

const DRAWER_ROOT_ID = 'mobile-surface-root';
const DRAWER_ENTER_DELAY_MS = 16;
// Slightly long, decelerating slide — matches the workspace drawer so both
// sides feel like the same piece of chrome.
const DRAWER_ENTER_DURATION_MS = 320;
const DRAWER_EASING = 'cubic-bezier(0.22, 1, 0.36, 1)';

/** Full-width left drawer for the phone sessions list: covers the whole app
    and slides in from the left edge. Closes via the header X, a right-edge
    swipe back toward the left (the mirror of the gesture that opened it),
    Escape, or the Android back button (handled by MobileShell).

    Stays MOUNTED while closed (parked off-screen, hidden): the sessions
    sheet's project/worktree state stays warm, so reopening shows the tree
    instantly instead of refetching from scratch — and the close slide can
    actually play instead of the drawer vanishing on unmount. */
const MobileSessionsDrawerContainer: React.FC<{
  open: boolean;
  onClose: () => void;
  /** What the closing edge swipe does; the drawer's owner may want it to undo
      a lighter state first. Falls back to `onClose`. */
  onSwipeClose?: () => void;
  ariaLabel: string;
  children: React.ReactNode;
}> = ({ open, onClose, onSwipeClose, ariaLabel, children }) => {
  const { direction } = useI18n();
  const rootRef = React.useRef<HTMLElement | null>(null);
  const drawerRef = React.useRef<HTMLElement>(null);
  const [entered, setEntered] = React.useState(false);
  // Kept visible through the exit slide; flipped to hidden once it finishes.
  const [visible, setVisible] = React.useState(open);
  const onCloseRef = React.useRef(onClose);
  React.useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
  const onSwipeCloseRef = React.useRef(onSwipeClose);
  React.useEffect(() => {
    onSwipeCloseRef.current = onSwipeClose;
  }, [onSwipeClose]);

  // Swipe from the drawer's end edge back toward its start = close, the
  // reverse of the start-edge swipe that opened it from the chat. Rows inside
  // reveal their actions in the opposite direction, so the two never fight.
  const closeFromEdge = () => (onSwipeCloseRef.current ?? onCloseRef.current)();
  useEdgeSwipe(drawerRef, {
    enabled: open,
    ...(direction === 'rtl' ? { onLeftEdgeSwipe: closeFromEdge } : { onRightEdgeSwipe: closeFromEdge }),
  });

  if (typeof document !== 'undefined' && !rootRef.current) {
    let root = document.getElementById(DRAWER_ROOT_ID);
    if (!root) {
      root = document.createElement('div');
      root.id = DRAWER_ROOT_ID;
      document.body.appendChild(root);
    }
    rootRef.current = root;
  }

  React.useEffect(() => {
    if (open) {
      setVisible(true);
      const id = window.setTimeout(() => setEntered(true), DRAWER_ENTER_DELAY_MS);
      return () => window.clearTimeout(id);
    }
    setEntered(false);
    const id = window.setTimeout(() => setVisible(false), DRAWER_ENTER_DURATION_MS + 40);
    return () => window.clearTimeout(id);
  }, [open]);

  React.useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !isIMECompositionEvent(event)) onCloseRef.current();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  if (!rootRef.current) return null;

  return createPortal(
    <section
      ref={drawerRef}
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
      aria-hidden={!open}
      className="oc-keyboard-inset-surface fixed inset-0 z-50 flex flex-col bg-background text-foreground"
      style={{
        paddingTop: 'var(--oc-safe-area-top, 0px)',
        // Settled state drops the transform entirely so the drawer isn't kept
        // on a compositing layer (iOS clips those to the safe-area viewport).
        transform: entered ? 'none' : direction === 'rtl' ? 'translateX(100%)' : 'translateX(-100%)',
        transition: `transform ${DRAWER_ENTER_DURATION_MS}ms ${DRAWER_EASING}`,
        visibility: visible ? 'visible' : 'hidden',
        pointerEvents: open ? 'auto' : 'none',
      }}
    >
      <div className="flex h-full min-h-0 flex-col">
        {children}
      </div>
    </section>,
    rootRef.current,
  );
};

const MobileSessionsEmpty: React.FC<{
  title: string;
  description?: string;
  action?: React.ReactNode;
}> = ({ title, description, action }) => (
  <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
    <p className="typography-ui-label text-foreground">{title}</p>
    {description ? <p className="typography-meta text-muted-foreground">{description}</p> : null}
    {action ? <div className="pt-2">{action}</div> : null}
  </div>
);
