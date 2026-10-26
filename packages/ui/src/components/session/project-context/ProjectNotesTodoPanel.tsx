import React from 'react';

import { toast } from '@/components/ui';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { useI18n } from '@/lib/i18n';
import { resolveProjectContextId, type ProjectRef, type ProjectTodoChange, type ProjectTodoItem } from '@/lib/projectContextApi';
import { observeProjectContext } from '@/lib/projectContextSync';
import { cn } from '@/lib/utils';
import { selectProjectMemoryForPath, useAgentMemoryStore } from '@/stores/useAgentMemoryStore';
import { countHighlightedMemories, memoryViewKey } from '@/lib/agentMemoryBadges';
import { EMPTY_PROJECT_CONTEXT_ENTRY, useProjectContextStore } from '@/stores/useProjectContextStore';
import { useUIStore } from '@/stores/useUIStore';
import { TodoSendDialog } from '../TodoSendDialog';
import { MemorySection } from './MemorySection';
import { NotesSection } from './NotesSection';
import { PlansSection } from './PlansSection';
import { TodosSection } from './TodosSection';
import { ContextPanelHeaderSlotProvider, ContextPanelHeaderToolbar } from '@/components/layout/contextPanelHeaderSlot';
import { useInContextPanelHeader } from '@/components/layout/contextPanelHeaderSlotContext';
import { useProjectTodoSend } from './useProjectTodoSend';
import { KnowledgeSearchBar } from './KnowledgeSearchBar';
import { KnowledgeBackButton } from './KnowledgeEntryView';
import { KnowledgeSplit } from './KnowledgeSplit';
import { Button } from '@/components/ui/button';
import { memoryDeleteKey, noteDeleteKey, planDeleteKey, usePendingKnowledgeDeletes } from './pendingKnowledgeDeletes';
import { matchesRankQuery } from '@/lib/search/fuzzySearch';
import { fetchSessionKnowledgeSummary, setSessionProjectContextPin, type SessionProjectContextPins } from '@/lib/sessionKnowledgeApi';
import { useSessionUIStore } from '@/sync/session-ui-store';

/** Lazy: the plan editor is a large view, and most panel visits never open it. */
const PlanView = React.lazy(() => import('@/components/views/PlanView').then((module) => ({ default: module.PlanView })));

interface ProjectNotesTodoPanelProps {
  projectRef: ProjectRef | null;
  visible?: boolean;
  projectLabel?: string | null;
  canCreateWorktree?: boolean;
  onActionComplete?: () => void;
  /** When provided, opening a plan calls this instead of the desktop context
      panel tab — hosts without ContextPanel (mobile) render their own viewer.
      The plan carries its owner so the host's viewer cannot guess wrong. */
  onOpenPlan?: (plan: { id: string; title: string; projectRef: ProjectRef }) => void;
  className?: string;
}

type ProjectContextTab = 'notes' | 'todos' | 'plans' | 'memory';

const TAB_ORDER: ProjectContextTab[] = ['notes', 'todos', 'plans', 'memory'];

/** Panel width from which entries open beside the list instead of over it. */
const SPLIT_MIN_WIDTH = 900;

const sortTodosWithCompletedLast = (items: ProjectTodoItem[]): ProjectTodoItem[] => [
  ...items.filter((todo) => !todo.completed),
  ...items.filter((todo) => todo.completed),
];

/**
 * Notes, todos, plans and agent memory for the active project.
 *
 * The lists are tabs rather than one stacked column: stacking gave each
 * list its own scroller inside the panel's scroller, which only got worse as
 * lists grew and forced the todo list to carry a manual resize handle just to
 * stay usable.
 *
 * Search sits above the tabs and stays panel-wide. Tabs divide, and search is
 * the one thing that division would hurt — you do not always remember whether
 * something was written as a note or lives in a plan — so the section strip
 * doubles as the result summary by showing per-section match counts.
 *
 * Storage is server-owned and reached through `useProjectContextStore`.
 */
export const ProjectNotesTodoPanel: React.FC<ProjectNotesTodoPanelProps> = ({
  projectRef,
  visible = true,
  projectLabel,
  canCreateWorktree = false,
  onActionComplete,
  onOpenPlan,
  className,
}) => {
  const inPanelHeader = useInContextPanelHeader();
  const { t } = useI18n();

  const projectContextId = React.useMemo(() => resolveProjectContextId(projectRef), [projectRef]);
  const contextEntry = useProjectContextStore(
    (state) => (projectContextId ? state.entries[projectContextId] : undefined) ?? EMPTY_PROJECT_CONTEXT_ENTRY,
  );
  const saveTodos = useProjectContextStore((state) => state.saveTodos);
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const currentSessionDirectory = useSessionUIStore((state) => state.currentSessionDirectory);
  const newSessionDraft = useSessionUIStore((state) => state.newSessionDraft);
  const setDraftProjectContextPin = useSessionUIStore((state) => state.setDraftProjectContextPin);
  const [sessionPins, setSessionPins] = React.useState<SessionProjectContextPins>({ notes: [], plans: [] });

  React.useEffect(() => {
    if (newSessionDraft.open) {
      setSessionPins(newSessionDraft.projectContextPins ?? { notes: [], plans: [] });
      return;
    }
    let cancelled = false;
    void fetchSessionKnowledgeSummary(currentSessionDirectory, currentSessionId).then((summary) => {
      if (!cancelled) {
        setSessionPins({
          notes: summary.notes.map((note) => note.id),
          plans: summary.plans.map((plan) => plan.id),
        });
      }
    });
    return () => { cancelled = true; };
  }, [currentSessionDirectory, currentSessionId, newSessionDraft.open, newSessionDraft.projectContextPins]);

  const toggleSessionPin = React.useCallback(async (kind: 'note' | 'plan', id: string, pinned: boolean) => {
    if (newSessionDraft.open) {
      setDraftProjectContextPin(kind, id, pinned);
      return true;
    }
    if (!currentSessionId || !currentSessionDirectory) return false;
    const next = await setSessionProjectContextPin(currentSessionDirectory, currentSessionId, kind, id, pinned);
    if (!next) return false;
    setSessionPins(next);
    return true;
  }, [currentSessionDirectory, currentSessionId, newSessionDraft.open, setDraftProjectContextPin]);

  const pinnedNoteIds = React.useMemo(() => new Set(sessionPins.notes), [sessionPins.notes]);
  const pinnedPlanIds = React.useMemo(() => new Set(sessionPins.plans), [sessionPins.plans]);

  // The whole feature is one switch: with memory off there is nothing for the
  // agent to manage, so showing the user what is stored would be pointless.
  const memoryEnabled = useUIStore((state) => (
    state.agentMemoryFeatureAvailable && state.agentMemoryToolEnabled
  ));
  const memoryDisabledByServer = useAgentMemoryStore((state) => state.disabled);
  const memoryVisible = memoryEnabled && !memoryDisabledByServer;
  const globalMemory = useAgentMemoryStore((state) => state.global);
  const projectMemory = useAgentMemoryStore(
    (state) => selectProjectMemoryForPath(state, projectRef?.path ?? null),
  );

  const isMobile = useUIStore((state) => state.isMobile);
  /**
   * The panel's own width decides the layout, whether it got wide through the
   * expand button or by being dragged: from SPLIT_MIN_WIDTH the list and the
   * open entry sit side by side. Touch layouts always stack.
   */
  // A node in state rather than a ref: the panel first renders without its
  // root while no project is selected, and must start measuring once it has one.
  const [rootNode, setRootNode] = React.useState<HTMLDivElement | null>(null);
  const [panelWidth, setPanelWidth] = React.useState(0);
  React.useLayoutEffect(() => {
    const root = rootNode;
    if (!root) return;
    setPanelWidth(root.getBoundingClientRect().width);
    const observer = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (entry) setPanelWidth(entry.contentRect.width);
    });
    observer.observe(root);
    return () => observer.disconnect();
  }, [rootNode]);
  const wide = !isMobile && panelWidth >= SPLIT_MIN_WIDTH;
  const storedTab = useUIStore((state) => state.projectContextTab);
  const setStoredTab = useUIStore((state) => state.setProjectContextTab);
  const requestedTab = TAB_ORDER.includes(storedTab as ProjectContextTab)
    ? storedTab as ProjectContextTab
    : 'notes';
  // A persisted 'memory' must not survive the feature being turned off, or the
  // panel would open on a tab that no longer exists.
  const activeTab: ProjectContextTab = requestedTab === 'memory' && !memoryVisible
    ? 'notes'
    : requestedTab;
  // Todos open nothing, so they never split.
  const split = wide && activeTab !== 'todos';

  const [query, setQuery] = React.useState('');
  const [searchOpen, setSearchOpen] = React.useState(false);
  const [searchFocusRequest, setSearchFocusRequest] = React.useState(0);
  // Closing the search clears it, so a list never stays filtered by text
  // nobody can see.
  const closeSearch = React.useCallback(() => {
    setSearchOpen(false);
    setQuery('');
  }, []);
  const toggleSearch = React.useCallback(() => {
    if (searchOpen) {
      closeSearch();
      return;
    }
    setSearchOpen(true);
    setSearchFocusRequest((request) => request + 1);
  }, [closeSearch, searchOpen]);
  /**
   * The entry being read, shown in place of its section's list. Plans used to
   * open as a separate context-panel tab, and notes and memories expanded
   * inside the list, pushing every card below them around. Every section now
   * opens an entry the same way, and the panel owns which one so the back
   * control in the section strip can close it.
   */
  const [openEntry, setOpenEntry] = React.useState<{ section: ProjectContextTab; id: string } | null>(null);
  const openIdIn = (section: ProjectContextTab): string | null => (
    openEntry?.section === section && activeTab === section ? openEntry.id : null
  );
  const openPlanId = openIdIn('plans');
  /**
   * Where the list was when an entry opened, so going back lands on the same
   * card instead of the top. The list unmounts while the entry is open, so the
   * position is kept here and put back once the list renders again.
   */
  const listScrollerRef = React.useRef<HTMLDivElement | null>(null);
  const returnPointRef = React.useRef<{ section: ProjectContextTab; id: string; scrollTop: number } | null>(null);
  const openEntryIn = React.useCallback((section: ProjectContextTab, id: string | null) => {
    if (id) {
      returnPointRef.current = { section, id, scrollTop: listScrollerRef.current?.scrollTop ?? 0 };
    }
    setOpenEntry(id ? { section, id } : null);
  }, []);
  const openNote = React.useCallback((id: string | null) => openEntryIn('notes', id), [openEntryIn]);
  const openMemory = React.useCallback((id: string | null) => openEntryIn('memory', id), [openEntryIn]);
  const openPlan = React.useCallback((plan: { id: string }) => openEntryIn('plans', plan.id), [openEntryIn]);
  const trimmedQuery = query.trim().toLowerCase();

  // Completed items sink to the bottom in the list; storage order is untouched.
  const todos = React.useMemo(
    () => sortTodosWithCompletedLast(contextEntry.todos),
    [contextEntry.todos],
  );
  const isLoading = contextEntry.loading && !contextEntry.loaded;

  // Counted the way the sections filter, fuzzy match included, and without
  // entries whose delete is waiting out its undo window: the strip must agree
  // with the list it opens.
  const pendingDeletes = usePendingKnowledgeDeletes();
  const counts = React.useMemo(() => ({
    notes: contextEntry.notes.filter((note) => (
      !(projectRef && pendingDeletes.has(noteDeleteKey(projectRef, note.id))) && matchesRankQuery([note.body], query)
    )).length,
    todos: todos.filter((todo) => matchesRankQuery([todo.text], query)).length,
    plans: contextEntry.plans.filter((plan) => (
      !(projectRef && pendingDeletes.has(planDeleteKey(projectRef, plan.id))) && matchesRankQuery([plan.title], query)
    )).length,
    memory: [
      ...globalMemory.filter((entry) => !pendingDeletes.has(memoryDeleteKey('global', entry.id))),
      ...projectMemory.filter((entry) => !pendingDeletes.has(memoryDeleteKey('project', entry.id))),
    ].filter((entry) => matchesRankQuery([entry.title, entry.body], query)).length,
  }), [contextEntry.notes, contextEntry.plans, globalMemory, pendingDeletes, projectMemory, projectRef, query, todos]);

  // Counted across both scopes against their own marks: a new global memory is
  // the one the user most needs to see, and it would be invisible behind the
  // project scope.
  const globalViewedAt = useUIStore((state) => state.agentMemoryViewedAt[memoryViewKey('global', null)] ?? 0);
  const projectViewedAt = useUIStore(
    (state) => state.agentMemoryViewedAt[memoryViewKey('project', projectRef?.path ?? null)] ?? 0,
  );
  const highlightedMemoryCount = React.useMemo(
    () => countHighlightedMemories(globalMemory, globalViewedAt)
      + countHighlightedMemories(projectMemory, projectViewedAt),
    [globalMemory, globalViewedAt, projectMemory, projectViewedAt],
  );

  const send = useProjectTodoSend({ projectRef, canCreateWorktree, onActionComplete });

  React.useEffect(() => {
    if (!projectRef || !visible) {
      return;
    }
    return observeProjectContext(projectRef);
  }, [projectRef, visible]);

  // Surface a load failure once. The store keeps whatever it already had, so
  // the panel never blanks out over an unreachable server.
  const reportedErrorRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!contextEntry.error) {
      reportedErrorRef.current = null;
      return;
    }
    if (reportedErrorRef.current === contextEntry.error) {
      return;
    }
    reportedErrorRef.current = contextEntry.error;
    if (!contextEntry.loaded) {
      toast.error(t('rightSidebar.contextNotesTodo.toast.loadNotesFailed'));
    }
  }, [contextEntry.error, contextEntry.loaded, t]);

  // Back on the list: the same scroll position, and focus on the card that was
  // open, so the keyboard continues from there too. Only for the section the
  // entry came from; leaving for another section forgets the spot.
  const listShown = openEntry === null || openEntry.section !== activeTab;
  React.useLayoutEffect(() => {
    const point = returnPointRef.current;
    if (!point || !listShown) return;
    returnPointRef.current = null;
    if (point.section !== activeTab) return;
    const scroller = listScrollerRef.current;
    if (!scroller) return;
    scroller.scrollTop = point.scrollTop;
    const card = Array.from(scroller.querySelectorAll<HTMLElement>('[data-knowledge-entry-id]'))
      .find((element) => element.dataset.knowledgeEntryId === point.id);
    // Note and memory cards take focus themselves; a plan row's target is the
    // button that opened it.
    const target = card && card.tabIndex >= 0 ? card : card?.querySelector<HTMLElement>('button');
    target?.focus({ preventScroll: true });
  }, [activeTab, listShown]);

  // An entry belongs to its project and to its section; leaving either must
  // not leave it open over a list it no longer matches.
  React.useEffect(() => {
    setOpenEntry(null);
  }, [projectContextId]);

  React.useEffect(() => {
    setOpenEntry((current) => (current && current.section !== activeTab ? null : current));
  }, [activeTab]);

  // A plan an agent asked to show. Declared after the resets above so a request
  // that switched the tab or mounted the panel is not closed again by them. A
  // request for another project waits for that project's panel.
  const planRequest = useUIStore((state) => state.projectKnowledgePlanRequest);
  React.useEffect(() => {
    if (!planRequest || planRequest.projectContextId !== projectContextId || activeTab !== 'plans') return;
    useUIStore.getState().clearProjectKnowledgePlanRequest();
    openEntryIn('plans', planRequest.planId);
  }, [activeTab, openEntryIn, planRequest, projectContextId]);

  // Reset the filter when the project changes: a query that matched the old
  // project would silently hide everything in the new one.
  React.useEffect(() => {
    closeSearch();
  }, [closeSearch, projectContextId]);

  // Follow the search to where the matches are. Without this, typing a query
  // whose hits are all in another tab shows an empty list and the user has to
  // guess which tab to try. Only moves off a tab that has nothing, and only
  // when the query changes: a tab the user picks by hand while searching
  // stays picked, even when it has no matches.
  const followedQueryRef = React.useRef('');
  React.useEffect(() => {
    if (trimmedQuery === followedQueryRef.current) {
      return;
    }
    followedQueryRef.current = trimmedQuery;
    if (!trimmedQuery || counts[activeTab] > 0) {
      return;
    }
    const withMatches = TAB_ORDER.find((tab) => counts[tab] > 0);
    if (withMatches) {
      setStoredTab(withMatches);
    }
  }, [activeTab, counts, setStoredTab, trimmedQuery]);

  const handlePersistTodos = React.useCallback(
    (nextTodos: ProjectTodoItem[], change?: ProjectTodoChange) => {
      if (!projectRef) {
        return;
      }
      // The store owns per-project write serialization and rollback; the panel
      // only decides what to persist and how to report a failure.
      void saveTodos(projectRef, nextTodos, change).then((saved) => {
        if (!saved) {
          toast.error(t('rightSidebar.contextNotesTodo.toast.saveNotesFailed'));
        }
      });
    },
    [projectRef, saveTodos, t]
  );

  const sections: Array<{ id: ProjectContextTab; icon: IconName; label: string; count: number; unseen: number }> = React.useMemo(() => ([
    { id: 'notes', icon: 'sticky-note', label: t('rightSidebar.contextNotesTodo.tabs.notes'), count: counts.notes, unseen: 0 },
    { id: 'todos', icon: 'checkbox-circle', label: t('rightSidebar.contextNotesTodo.tabs.todos'), count: counts.todos, unseen: 0 },
    { id: 'plans', icon: 'file-text', label: t('rightSidebar.contextNotesTodo.tabs.plans'), count: counts.plans, unseen: 0 },
    ...(memoryVisible ? [{
      id: 'memory' as const,
      icon: 'brain-4' as IconName,
      label: t('rightSidebar.contextNotesTodo.tabs.memory'),
      count: counts.memory,
      // What the agent stored without asking deserves the glance, so it gets
      // its own mark beside the total instead of hiding inside it.
      unseen: highlightedMemoryCount,
    }] : []),
  ]), [counts, highlightedMemoryCount, memoryVisible, t]);

  if (!projectRef) {
    return (
      <div className={cn('w-full min-w-0 p-3', className)}>
        <p className="typography-meta text-muted-foreground">
          {t('rightSidebar.contextNotesTodo.empty.selectProject')}
        </p>
      </div>
    );
  }

  const entryOpen = openIdIn(activeTab) !== null;
  // Beside the list the search still has a list to filter.
  const showSearchBar = searchOpen && (split || !entryOpen);

  const projectTitle = projectLabel?.trim()
    || projectRef.path.split('/').filter(Boolean).pop()
    || projectRef.path;
  // The search names the project it searches: that is where the panel says
  // whose notes these are, Chats included, without a row of its own.
  const searchLabel = t('rightSidebar.contextNotesTodo.search.placeholderInProject', { project: projectTitle });
  const nothingFound = trimmedQuery.length > 0 && sections.every((section) => section.count === 0);

  // Sections are the panel's header; the search is a toggle beside the
  // panel's own buttons. In the mobile drawer, which has no panel header, the
  // same row sits at the top of the panel.
  const toolbar = (
    <div className="flex min-w-0 flex-1 items-center gap-1 pe-1">
      <nav
          className="@container/knowledge-sections flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
          aria-label={t('rightSidebar.contextNotesTodo.sections.label')}
        >
          {sections.map((section) => {
            const isActive = activeTab === section.id;
            return (
              <button
                key={section.id}
                type="button"
                onClick={() => setStoredTab(section.id)}
                aria-current={isActive ? 'page' : undefined}
                title={section.label}
                className={cn(
                  'flex h-7 flex-shrink-0 items-center gap-1.5 rounded-md px-2 transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  isActive
                    ? 'bg-interactive-selection text-interactive-selection-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <Icon name={section.icon} className="h-3.5 w-3.5 flex-shrink-0" />
                <span
                  className={cn(
                    'whitespace-nowrap typography-meta',
                    !isActive && (isMobile ? 'hidden' : 'hidden @[22rem]/knowledge-sections:inline'),
                  )}
                >
                  {section.label}
                </span>
                <span className="typography-micro opacity-70">{section.count}</span>
                {section.unseen > 0 ? (
                  <span
                    className="rounded-full bg-[var(--status-success)]/15 px-1 typography-micro font-medium leading-4 text-[var(--status-success-text)]"
                    title={t('rightSidebar.contextNotesTodo.memory.unseenTitle', { count: section.unseen })}
                    aria-label={t('rightSidebar.contextNotesTodo.memory.unseenTitle', { count: section.unseen })}
                  >
                    {`+${section.unseen}`}
                  </span>
                ) : null}
              </button>
            );
          })}
        </nav>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={toggleSearch}
        aria-pressed={searchOpen}
        className={cn('h-7 w-7 flex-shrink-0 p-0', searchOpen && 'bg-interactive-selection text-interactive-selection-foreground')}
        title={searchLabel}
        aria-label={searchLabel}
      >
        <Icon name="search" className="h-3.5 w-3.5" />
      </Button>
    </div>
  );

  const plansList = (
    <PlansSection
      projectRef={projectRef}
      plans={contextEntry.plans}
      query={query}
      pinnedPlanIds={pinnedPlanIds}
      onTogglePinned={(planId, pinned) => toggleSessionPin('plan', planId, pinned)}
      selectedPlanId={split ? openPlanId : null}
      // Hosts that own a fullscreen plan surface (mobile) keep it; on the
      // desktop panel the plan opens here, in place of the list or beside it.
      onOpenPlan={onOpenPlan ?? openPlan}
    />
  );

  const planView = (planId: string, withBack: boolean) => (
    <React.Suspense fallback={null}>
      {/* The panel header belongs to this panel's tabs; the plan keeps its
          own title row inside the panel body. */}
      <ContextPanelHeaderSlotProvider value={null}>
        <PlanView
          visible={visible}
          leading={withBack ? (
            <KnowledgeBackButton
              label={t('rightSidebar.contextNotesTodo.plans.actions.back')}
              onClick={() => setOpenEntry(null)}
            />
          ) : null}
          savedProjectPlan={{ projectRef, planId }}
          onNavigatedToChat={() => setOpenEntry(null)}
        />
      </ContextPanelHeaderSlotProvider>
    </React.Suspense>
  );

  return (
    <div ref={setRootNode} className={cn('flex h-full min-h-0 w-full min-w-0 flex-col', className)}>
      {inPanelHeader ? (
        <ContextPanelHeaderToolbar>{toolbar}</ContextPanelHeaderToolbar>
      ) : (
        <div className="flex flex-shrink-0 px-3 pt-2">{toolbar}</div>
      )}

      <div className="relative min-h-0 min-w-0 flex-1">
      {showSearchBar ? (
        // Over the list column in the split layout, so it never covers the
        // open entry's toolbar.
        <div className={cn('pointer-events-none absolute top-2 z-20', split ? 'inset-s-3' : 'inset-e-3')}>
          <KnowledgeSearchBar
            query={query}
            onQueryChange={setQuery}
            placeholder={searchLabel}
            nothingFound={nothingFound}
            focusRequest={searchFocusRequest}
            onClose={closeSearch}
          />
        </div>
      ) : null}
      {/* An open entry scrolls itself; nesting it in this scroller would give
          the panel two scrollbars for one document. In the split layout each
          column scrolls itself. */}
      <div
        ref={listScrollerRef}
        className={cn('h-full min-w-0', split ? 'overflow-hidden' : cn('p-3', entryOpen ? 'overflow-hidden' : 'overflow-y-auto'))}
      >
        {activeTab === 'notes' ? (
          <NotesSection
            projectRef={projectRef}
            notes={contextEntry.notes}
            disabled={isLoading}
            query={query}
            pinnedNoteIds={pinnedNoteIds}
            onTogglePinned={(noteId, pinned) => toggleSessionPin('note', noteId, pinned)}
            openNoteId={openIdIn('notes')}
            onOpenNote={openNote}
            split={split}
          />
        ) : null}

        {activeTab === 'todos' ? (
          // Todos open nothing, so a wide panel gets one column of readable
          // width instead of rows stretched edge to edge.
          <div className={cn(wide && 'mx-auto max-w-3xl')}>
            <TodosSection
              todos={todos}
              query={query}
              disabled={isLoading}
              canCreateWorktree={canCreateWorktree}
              sendingTodoId={send.sendingTodoId}
              onPersistTodos={handlePersistTodos}
              onSendToCurrentSession={send.sendToCurrentSession}
              onSendToNewSession={send.sendToNewSession}
              onSendToNewWorktreeSession={send.sendToNewWorktreeSession}
            />
          </div>
        ) : null}

        {activeTab === 'memory' && memoryVisible ? (
          <MemorySection
            projectPath={projectRef.path}
            query={query}
            openMemoryId={openIdIn('memory')}
            onOpenMemory={openMemory}
            split={split}
          />
        ) : null}

        {activeTab === 'plans' ? (
          split ? (
            <KnowledgeSplit
              list={plansList}
              detail={openPlanId ? planView(openPlanId, false) : null}
              emptyLabel={t('rightSidebar.contextNotesTodo.plans.selectHint')}
            />
          ) : openPlanId ? planView(openPlanId, true) : plansList
        ) : null}
      </div>
      </div>

      <TodoSendDialog
        open={send.pendingSendTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            send.closeDialog();
          }
        }}
        target={send.pendingSendTarget?.kind ?? 'session'}
        projectDirectory={projectRef.path}
        submitting={send.isSubmitting}
        onConfirm={send.confirmSend}
      />
    </div>
  );
};
