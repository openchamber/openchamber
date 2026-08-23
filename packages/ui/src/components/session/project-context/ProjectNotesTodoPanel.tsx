import React from 'react';

import { toast } from '@/components/ui';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { Input } from '@/components/ui/input';
import { useI18n } from '@/lib/i18n';
import { resolveProjectContextId, type ProjectRef, type ProjectTodoItem } from '@/lib/projectContextApi';
import { cn } from '@/lib/utils';
import { useAgentMemoryStore } from '@/stores/useAgentMemoryStore';
import { countHighlightedMemories, memoryViewKey } from '@/lib/agentMemoryBadges';
import { EMPTY_PROJECT_CONTEXT_ENTRY, useProjectContextStore } from '@/stores/useProjectContextStore';
import { useUIStore } from '@/stores/useUIStore';
import { TodoSendDialog } from '../TodoSendDialog';
import { MemorySection } from './MemorySection';
import { NotesSection } from './NotesSection';
import { PlansSection } from './PlansSection';
import { TodosSection } from './TodosSection';
import { useProjectTodoSend } from './useProjectTodoSend';
import { fetchSessionKnowledgeSummary, setSessionProjectContextPin, type SessionProjectContextPins } from '@/lib/sessionKnowledgeApi';
import { useSessionUIStore } from '@/sync/session-ui-store';

/** Lazy: the plan editor is a large view, and most panel visits never open it. */
const PlanView = React.lazy(() => import('@/components/views/PlanView').then((module) => ({ default: module.PlanView })));

interface ProjectNotesTodoPanelProps {
  projectRef: ProjectRef | null;
  projectLabel?: string | null;
  canCreateWorktree?: boolean;
  onActionComplete?: () => void;
  /** When provided, opening a plan calls this instead of the desktop context
      panel tab — hosts without ContextPanel (mobile) render their own viewer. */
  onOpenPlan?: (plan: { id: string; title: string }) => void;
  className?: string;
}

type ProjectContextTab = 'notes' | 'todos' | 'plans' | 'memory';

const TAB_ORDER: ProjectContextTab[] = ['notes', 'todos', 'plans', 'memory'];

/** Wide enough for the longest section label, narrow enough to leave the
    content column usable in a half-width panel. */
const SIDEBAR_MIN_WIDTH = 120;
const SIDEBAR_MAX_WIDTH = 320;

const clampSidebarWidth = (width: number): number => (
  Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(width)))
);

const sortTodosWithCompletedLast = (items: ProjectTodoItem[]): ProjectTodoItem[] => [
  ...items.filter((todo) => !todo.completed),
  ...items.filter((todo) => todo.completed),
];

const matches = (haystack: string, needle: string): boolean => (
  haystack.toLowerCase().includes(needle)
);

/**
 * Notes, todos, and plans for the active project.
 *
 * The three lists are tabs rather than one stacked column: stacking gave each
 * list its own scroller inside the panel's scroller, which only got worse as
 * lists grew and forced the todo list to carry a manual resize handle just to
 * stay usable.
 *
 * Search sits above the tabs and stays panel-wide. Tabs divide, and search is
 * the one thing that division would hurt — you do not always remember whether
 * something was written as a note or lives in a plan — so the tab bar doubles
 * as the result summary by showing per-tab match counts.
 *
 * Storage is server-owned and reached through `useProjectContextStore`.
 */
export const ProjectNotesTodoPanel: React.FC<ProjectNotesTodoPanelProps> = ({
  projectRef,
  projectLabel,
  canCreateWorktree = false,
  onActionComplete,
  onOpenPlan,
  className,
}) => {
  const { t } = useI18n();

  const projectContextId = React.useMemo(() => resolveProjectContextId(projectRef), [projectRef]);
  const contextEntry = useProjectContextStore(
    (state) => (projectContextId ? state.entries[projectContextId] : undefined) ?? EMPTY_PROJECT_CONTEXT_ENTRY,
  );
  const loadProjectContext = useProjectContextStore((state) => state.load);
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
  const projectMemory = useAgentMemoryStore((state) => state.project);

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

  const [query, setQuery] = React.useState('');
  /**
   * The plan being read, shown in place of the list. Plans used to open as a
   * separate context-panel tab, which pushed the user out of the panel they
   * were browsing to read something that belongs to it.
   */
  const [openPlan, setOpenPlan] = React.useState<{ id: string; title: string } | null>(null);
  const trimmedQuery = query.trim().toLowerCase();

  // Completed items sink to the bottom in the list; storage order is untouched.
  const todos = React.useMemo(
    () => sortTodosWithCompletedLast(contextEntry.todos),
    [contextEntry.todos],
  );
  const isLoading = contextEntry.loading && !contextEntry.loaded;

  const memoryEntries = React.useMemo(
    () => [...globalMemory, ...projectMemory],
    [globalMemory, projectMemory],
  );

  const counts = React.useMemo(() => {
    if (!trimmedQuery) {
      return {
        notes: contextEntry.notes.length,
        todos: todos.length,
        plans: contextEntry.plans.length,
        memory: memoryEntries.length,
      };
    }
    return {
      notes: contextEntry.notes.filter((note) => matches(note.body, trimmedQuery)).length,
      todos: todos.filter((todo) => matches(todo.text, trimmedQuery)).length,
      plans: contextEntry.plans.filter((plan) => matches(plan.title, trimmedQuery)).length,
      memory: memoryEntries.filter((entry) => (
        matches(entry.title, trimmedQuery) || matches(entry.body, trimmedQuery)
      )).length,
    };
  }, [contextEntry.notes, contextEntry.plans, memoryEntries, todos, trimmedQuery]);

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

  const storedSidebarWidth = useUIStore((state) => state.projectContextSidebarWidth);
  const setSidebarWidth = useUIStore((state) => state.setProjectContextSidebarWidth);
  const [isResizing, setIsResizing] = React.useState(false);
  // Held locally while dragging so every pointer move does not write through
  // the persisted store, then committed once on release.
  const [draggedWidth, setDraggedWidth] = React.useState<number | null>(null);
  const sidebarWidth = clampSidebarWidth(draggedWidth ?? storedSidebarWidth);

  const handleResizeStart = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    setIsResizing(true);
    setDraggedWidth(sidebarWidth);
  }, [sidebarWidth]);

  const handleResizeMove = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) {
      return;
    }
    // The sidebar is on the right, so dragging its left edge leftwards widens
    // it: the width is the distance from the pointer to the panel's edge.
    const panelRight = event.currentTarget.closest('nav')?.getBoundingClientRect().right ?? 0;
    setDraggedWidth(clampSidebarWidth(panelRight - event.clientX));
  }, []);

  const handleResizeEnd = React.useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setIsResizing(false);
    setDraggedWidth((current) => {
      if (current !== null) {
        setSidebarWidth(clampSidebarWidth(current));
      }
      return null;
    });
  }, [setSidebarWidth]);

  const send = useProjectTodoSend({ projectRef, canCreateWorktree, onActionComplete });

  React.useEffect(() => {
    if (!projectRef) {
      return;
    }
    void loadProjectContext(projectRef);
  }, [loadProjectContext, projectRef]);

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

  // A plan belongs to its project and to its section; leaving either must not
  // leave its editor open over a list it no longer matches.
  React.useEffect(() => {
    setOpenPlan(null);
  }, [projectContextId]);

  React.useEffect(() => {
    if (activeTab !== 'plans') {
      setOpenPlan(null);
    }
  }, [activeTab]);

  // Reset the filter when the project changes: a query that matched the old
  // project would silently hide everything in the new one.
  React.useEffect(() => {
    setQuery('');
  }, [projectContextId]);

  // Follow the search to where the matches are. Without this, typing a query
  // whose hits are all in another tab shows an empty list and the user has to
  // guess which tab to try. Only moves off a tab that has nothing.
  React.useEffect(() => {
    if (!trimmedQuery || counts[activeTab] > 0) {
      return;
    }
    const withMatches = TAB_ORDER.find((tab) => counts[tab] > 0);
    if (withMatches) {
      setStoredTab(withMatches);
    }
  }, [activeTab, counts, setStoredTab, trimmedQuery]);

  const handlePersistTodos = React.useCallback(
    (nextTodos: ProjectTodoItem[]) => {
      if (!projectRef) {
        return;
      }
      // The store owns per-project write serialization and rollback; the panel
      // only decides what to persist and how to report a failure.
      void saveTodos(projectRef, nextTodos).then((saved) => {
        if (!saved) {
          toast.error(t('rightSidebar.contextNotesTodo.toast.saveNotesFailed'));
        }
      });
    },
    [projectRef, saveTodos, t]
  );

  /**
   * The sidebar entries. Icons are worth their width here: a vertical list has
   * the room a horizontal strip did not, and they make the sections scannable
   * without reading.
   */
  const sections: Array<{ id: ProjectContextTab; icon: IconName; label: string; count: string }> = React.useMemo(() => ([
    {
      id: 'notes',
      icon: 'sticky-note',
      label: t('rightSidebar.contextNotesTodo.tabs.notes'),
      count: String(counts.notes),
    },
    {
      id: 'todos',
      icon: 'checkbox-circle',
      label: t('rightSidebar.contextNotesTodo.tabs.todos'),
      count: String(counts.todos),
    },
    {
      id: 'plans',
      icon: 'file-text',
      label: t('rightSidebar.contextNotesTodo.tabs.plans'),
      count: String(counts.plans),
    },
    ...(memoryVisible ? [{
      id: 'memory' as const,
      icon: 'brain-4' as IconName,
      label: t('rightSidebar.contextNotesTodo.tabs.memory'),
      // The new/changed count replaces the total when there is anything the
      // user has not seen: what the agent stored without asking is the number
      // that deserves the glance.
      count: highlightedMemoryCount > 0
        ? `${highlightedMemoryCount}/${counts.memory}`
        : String(counts.memory),
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

  const projectTitle = projectLabel?.trim()
    || projectRef.path.split('/').filter(Boolean).pop()
    || projectRef.path;

  return (
    <div className={cn('flex h-full min-h-0 w-full min-w-0 flex-col', className)}>
      {/* Title and search share a row: search is a filter over what is already
          on screen, not a heading, and a full-width field read as the panel's
          primary control. */}
      <div className="flex flex-shrink-0 items-center gap-2 p-3 pb-2">
        {/* Back sits here, beside the project name, rather than above the
            editor: PlanView already titles the plan, and a second title row
            said the same thing twice. */}
        {openPlan ? (
          <button
            type="button"
            onClick={() => setOpenPlan(null)}
            className="inline-flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-interactive-hover/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
            aria-label={t('rightSidebar.contextNotesTodo.plans.actions.back')}
            title={t('rightSidebar.contextNotesTodo.plans.actions.back')}
          >
            <Icon name="arrow-left-s" className="h-4 w-4" />
          </button>
        ) : null}
        <h3
          className="min-w-0 flex-1 truncate typography-ui-label font-semibold text-foreground"
          title={projectRef.path}
        >
          {projectTitle}
        </h3>

        <div className="relative w-40 flex-shrink-0">
          <Icon
            name="search"
            className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('rightSidebar.contextNotesTodo.search.placeholder')}
            className="h-8 pl-7 pr-7"
          />
          {query ? (
            <button
              type="button"
              onClick={() => setQuery('')}
              className="absolute right-1.5 top-1/2 inline-flex h-5 w-5 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-interactive-hover/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
              aria-label={t('rightSidebar.contextNotesTodo.search.clear')}
              title={t('rightSidebar.contextNotesTodo.search.clear')}
            >
              <Icon name="close" className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </div>

      </div>

      {/* Content first, sidebar on the right — the same order and the same
          drag-to-resize edge the files surface uses, so the two panels do not
          disagree about where navigation lives. */}
      <div className="flex min-h-0 flex-1">
        {/* The plan editor scrolls itself; nesting it in this scroller would
            give the panel two scrollbars for one document. */}
        <div className={cn('min-h-0 min-w-0 flex-1 p-3', openPlan ? 'overflow-hidden' : 'overflow-y-auto')}>
        {activeTab === 'notes' ? (
          <NotesSection
            projectRef={projectRef}
            notes={contextEntry.notes}
            disabled={isLoading}
            query={query}
            pinnedNoteIds={pinnedNoteIds}
            onTogglePinned={(noteId, pinned) => toggleSessionPin('note', noteId, pinned)}
          />
        ) : null}

        {activeTab === 'todos' ? (
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
        ) : null}

        {activeTab === 'memory' && memoryVisible ? (
          <MemorySection projectPath={projectRef.path} query={query} />
        ) : null}

        {activeTab === 'plans' && !openPlan ? (
          <PlansSection
            projectRef={projectRef}
            plans={contextEntry.plans}
            query={query}
            pinnedPlanIds={pinnedPlanIds}
            onTogglePinned={(planId, pinned) => toggleSessionPin('plan', planId, pinned)}
            // Hosts that own a fullscreen plan surface (mobile) keep it; on the
            // desktop panel the plan opens here, in place of the list.
            onOpenPlan={onOpenPlan ?? setOpenPlan}
          />
        ) : null}

        {activeTab === 'plans' && openPlan ? (
          <React.Suspense fallback={null}>
            <PlanView
              projectPlanId={openPlan.id}
              onNavigatedToChat={() => setOpenPlan(null)}
            />
          </React.Suspense>
        ) : null}
        </div>

        <nav
          className="relative flex flex-shrink-0 flex-col gap-0.5 overflow-y-auto border-l border-[var(--interactive-border)] p-2"
          style={{ width: `${sidebarWidth}px` }}
          aria-label={t('rightSidebar.contextNotesTodo.sections.label')}
        >
          <div
            className={cn(
              'absolute left-0 top-0 z-20 h-full w-[3px] cursor-col-resize transition-colors hover:bg-[var(--interactive-border)]/80',
              isResizing && 'bg-[var(--interactive-border)]',
            )}
            onPointerDown={handleResizeStart}
            onPointerMove={handleResizeMove}
            onPointerUp={handleResizeEnd}
            onPointerCancel={handleResizeEnd}
            role="separator"
            aria-orientation="vertical"
            aria-label={t('rightSidebar.contextNotesTodo.sections.resize')}
          />
          {sections.map((section) => {
            const isActive = activeTab === section.id;
            return (
              <button
                key={section.id}
                type="button"
                onClick={() => setStoredTab(section.id)}
                aria-current={isActive ? 'page' : undefined}
                className={cn(
                  'flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
                  isActive
                    ? 'bg-interactive-active text-foreground'
                    : 'text-muted-foreground hover:bg-interactive-hover/50 hover:text-foreground',
                )}
                style={{ minHeight: 0 }}
              >
                <Icon name={section.icon} className="h-3.5 w-3.5 flex-shrink-0" />
                <span className="min-w-0 flex-1 truncate typography-meta">{section.label}</span>
                <span className="flex-shrink-0 typography-micro text-muted-foreground">{section.count}</span>
              </button>
            );
          })}
        </nav>
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
