import React from 'react';
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy, arrayMove } from '@dnd-kit/sortable';
import { CSS as DndCSS } from '@dnd-kit/utilities';
import { toast } from '@/components/ui';
import { Checkbox } from '@/components/ui/checkbox';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Icon } from "@/components/icon/Icon";
import {
  deleteProjectPlanFile,
  getProjectContextData,
  importProjectPlanFileFromContent,
  OPENCHAMBER_PROJECT_NOTES_MAX_LENGTH,
  readProjectPlanFile,
  OPENCHAMBER_PROJECT_TODO_TEXT_MAX_LENGTH,
  saveProjectNotesAndTodos,
  type OpenChamberProjectPlanFileLink,
  type OpenChamberProjectTodoItem,
  type ProjectRef,
} from '@/lib/openchamberConfig';
import { requestFileAccess } from '@/lib/desktop';
import { generateBranchName } from '@/lib/git/branchNameGenerator';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useUIStore } from '@/stores/useUIStore';
import { useConfigStore } from '@/stores/useConfigStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSelectionStore } from '@/sync/selection-store';
import { useInputStore } from '@/sync/input-store';
import { createWorktreeSessionForNewBranch } from '@/lib/worktreeSessionCreator';
import { cn } from '@/lib/utils';
import { renderMagicPrompt } from '@/lib/magicPrompts';
import { getCurrentIntlLocale, useI18n } from '@/lib/i18n';
import { TodoSendDialog, type TodoSendExecution } from './TodoSendDialog';

const TODO_PANEL_MIN_ITEMS = 5;
const TODO_PANEL_MAX_ITEMS = 15;

const getEffectiveItemHeight = (padding: number) => {
  const scale = Math.sqrt(padding / 100);
  const paddingPx = 12 * scale;
  const contentPx = 24 * scale; // h-6 uses --spacing-6 which also scales with --padding-scale
  const borderPx = 1;
  return Math.ceil(paddingPx + contentPx + borderPx);
};

const getPanelHeightForItems = (itemCount: number, padding: number) => {
  const itemHeight = getEffectiveItemHeight(padding);
  return Math.max(
    itemHeight * TODO_PANEL_MIN_ITEMS,
    Math.min(itemHeight * TODO_PANEL_MAX_ITEMS, itemHeight * itemCount)
  );
};

interface ProjectNotesTodoPanelProps {
  projectRef: ProjectRef | null;
  projectLabel?: string | null;
  canCreateWorktree?: boolean;
  onActionComplete?: () => void;
  className?: string;
}

type PendingSendTarget = {
  kind: 'session' | 'worktree';
  todoId: string;
  todoText: string;
};

type ProjectPlanListItem = OpenChamberProjectPlanFileLink & {
  title: string;
};

const toPlanListItem = async (
  plan: OpenChamberProjectPlanFileLink,
  fallbackTitle: string,
): Promise<ProjectPlanListItem> => {
  const file = await readProjectPlanFile(plan.path);
  return {
    ...plan,
    title: file?.title || plan.path.split('/').pop() || fallbackTitle,
  };
};

const createTodoId = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `todo_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
};

const sortTodosWithCompletedLast = (items: OpenChamberProjectTodoItem[]): OpenChamberProjectTodoItem[] => [
  ...items.filter((todo) => !todo.completed),
  ...items.filter((todo) => todo.completed),
];

const insertTodoBeforeCompleted = (items: OpenChamberProjectTodoItem[], item: OpenChamberProjectTodoItem): OpenChamberProjectTodoItem[] => {
  const firstCompletedIndex = items.findIndex((todo) => todo.completed);
  if (firstCompletedIndex === -1) {
    return [...items, item];
  }
  return [...items.slice(0, firstCompletedIndex), item, ...items.slice(firstCompletedIndex)];
};

type SortableTodoHandleProps = {
  attributes: ReturnType<typeof useSortable>['attributes'];
  listeners: ReturnType<typeof useSortable>['listeners'];
  setActivatorNodeRef: ReturnType<typeof useSortable>['setActivatorNodeRef'];
  isDragging: boolean;
};

const SortableTodoItem: React.FC<{
  id: string;
  children: (dragHandleProps: SortableTodoHandleProps) => React.ReactNode;
}> = ({ id, children }) => {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });

  return (
    <li
      ref={setNodeRef}
      style={{
        transform: DndCSS.Transform.toString(transform),
        transition,
      }}
      className={cn(isDragging && 'opacity-60')}
    >
      {children({ attributes, listeners, setActivatorNodeRef, isDragging })}
    </li>
  );
};

export const ProjectNotesTodoPanel: React.FC<ProjectNotesTodoPanelProps> = ({
  projectRef,
  projectLabel,
  canCreateWorktree = false,
  onActionComplete,
  className,
}) => {
  const { t } = useI18n();
  const [isLoading, setIsLoading] = React.useState(false);
  const [notes, setNotes] = React.useState('');
  const [todos, setTodos] = React.useState<OpenChamberProjectTodoItem[]>([]);
  const [newTodoText, setNewTodoText] = React.useState('');
  const [sendingTodoId, setSendingTodoId] = React.useState<string | null>(null);
  const [expandedTodoIds, setExpandedTodoIds] = React.useState<Set<string>>(() => new Set());
  const [plans, setPlans] = React.useState<ProjectPlanListItem[]>([]);
  const [pendingSendTarget, setPendingSendTarget] = React.useState<PendingSendTarget | null>(null);
  const [isSendDialogSubmitting, setIsSendDialogSubmitting] = React.useState(false);
  const [contextReloadTick, setContextReloadTick] = React.useState(0);
  const notesHydratedRef = React.useRef(false);
  const lastSavedNotesRef = React.useRef('');
  const todoPanelHeight = useUIStore((state) => state.todoPanelHeight);
  const setTodoPanelHeight = useUIStore((state) => state.setTodoPanelHeight);
  const notesPanelHeight = useUIStore((state) => state.notesPanelHeight);
  const setNotesPanelHeight = useUIStore((state) => state.setNotesPanelHeight);
  const [isTodoPanelResizing, setIsTodoPanelResizing] = React.useState(false);
  const todoPanelStartYRef = React.useRef(0);
  const todoPanelStartHeightRef = React.useRef(todoPanelHeight);

  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const createSession = useSessionUIStore((state) => state.createSession);
  const initializeNewOpenChamberSession = useSessionUIStore((state) => state.initializeNewOpenChamberSession);
  const sendMessage = useSessionUIStore((state) => state.sendMessage);
  const setCurrentSession = useSessionUIStore((state) => state.setCurrentSession);
  const setPendingInputText = useInputStore((state) => state.setPendingInputText);
  const currentDirectory = useDirectoryStore((state) => state.currentDirectory);
  const openContextPanelTab = useUIStore((state) => state.openContextPanelTab);
  const setActiveMainTab = useUIStore((state) => state.setActiveMainTab);
  const setSessionSwitcherOpen = useUIStore((state) => state.setSessionSwitcherOpen);
  const padding = useUIStore((state) => state.padding);

  const persistProjectData = React.useCallback(
    async (nextNotes: string, nextTodos: OpenChamberProjectTodoItem[]) => {
      if (!projectRef) {
        return false;
      }
      const saved = await saveProjectNotesAndTodos(projectRef, {
        notes: nextNotes,
        todos: nextTodos,
      });
      if (!saved) {
        toast.error(t('rightSidebar.contextNotesTodo.toast.saveNotesFailed'));
      }
      return saved;
    },
    [projectRef, t]
  );

  React.useEffect(() => {
    if (!projectRef) {
      setNotes('');
      setTodos([]);
      setPlans([]);
      setNewTodoText('');
      setExpandedTodoIds(new Set());
      return;
    }

    let cancelled = false;
    setIsLoading(true);

    (async () => {
      try {
        const data = await getProjectContextData(projectRef);
        const nextPlans = await Promise.all(
          data.plans.map((plan) => toPlanListItem(plan, t('rightSidebar.contextNotesTodo.plan.defaultTitle')))
        );
        if (cancelled) {
          return;
        }
        setNotes(data.notes);
        setTodos(sortTodosWithCompletedLast(data.todos));
        setPlans(nextPlans);
        lastSavedNotesRef.current = data.notes;
        notesHydratedRef.current = true;
        setNewTodoText('');
        setExpandedTodoIds(new Set());
      } catch {
        if (!cancelled) {
          toast.error(t('rightSidebar.contextNotesTodo.toast.loadNotesFailed'));
          setNotes('');
          setTodos([]);
          setPlans([]);
          lastSavedNotesRef.current = '';
          notesHydratedRef.current = true;
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [contextReloadTick, projectRef, t]);

  React.useEffect(() => {
    if (!projectRef) {
      return;
    }

    const handleProjectContextRefresh = (event: Event) => {
      const detail = (event as CustomEvent<{ projectId?: string }>).detail;
      if (detail?.projectId && detail.projectId !== projectRef.id) {
        return;
      }
      setContextReloadTick((previous) => previous + 1);
    };

    window.addEventListener('openchamber:project-plan-saved', handleProjectContextRefresh);
    window.addEventListener('openchamber:project-notes-updated', handleProjectContextRefresh);
    return () => {
      window.removeEventListener('openchamber:project-plan-saved', handleProjectContextRefresh);
      window.removeEventListener('openchamber:project-notes-updated', handleProjectContextRefresh);
    };
  }, [projectRef]);

  React.useEffect(() => {
    if (todos.length < 7) {
      return;
    }
    const targetHeight = getPanelHeightForItems(todos.length, padding);
    const minHeight = getEffectiveItemHeight(padding) * TODO_PANEL_MIN_ITEMS;
    if (todoPanelHeight < minHeight || todoPanelHeight > targetHeight) {
      setTodoPanelHeight(targetHeight);
    }
  }, [todos.length, padding, todoPanelHeight, setTodoPanelHeight]);

  React.useEffect(() => {
    if (!isTodoPanelResizing) {
      return;
    }

    const handlePointerMove = (event: PointerEvent) => {
      const delta = event.clientY - todoPanelStartYRef.current;
      const nextHeight = Math.min(
        getEffectiveItemHeight(padding) * TODO_PANEL_MAX_ITEMS,
        Math.max(getEffectiveItemHeight(padding) * TODO_PANEL_MIN_ITEMS, todoPanelStartHeightRef.current + delta)
      );
      setTodoPanelHeight(nextHeight);
    };

    const handlePointerEnd = () => {
      setIsTodoPanelResizing(false);
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerEnd, { once: true });
    window.addEventListener('pointercancel', handlePointerEnd, { once: true });

    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerEnd);
      window.removeEventListener('pointercancel', handlePointerEnd);
    };
  }, [isTodoPanelResizing, padding, setTodoPanelHeight]);

  const handleTodoPanelResizeStart = React.useCallback((event: React.PointerEvent) => {
    setIsTodoPanelResizing(true);
    todoPanelStartYRef.current = event.clientY;
    todoPanelStartHeightRef.current = todoPanelHeight;
    event.preventDefault();
  }, [todoPanelHeight]);

  const handleNotesBlur = React.useCallback(() => {
    lastSavedNotesRef.current = notes;
    void persistProjectData(notes, todos);
  }, [notes, persistProjectData, todos]);

  React.useEffect(() => {
    if (!projectRef || !notesHydratedRef.current) {
      return;
    }

    if (notes === lastSavedNotesRef.current) {
      return;
    }

    const timer = window.setTimeout(() => {
      lastSavedNotesRef.current = notes;
      void persistProjectData(notes, todos);
    }, 400);

    return () => {
      window.clearTimeout(timer);
    };
  }, [notes, persistProjectData, projectRef, todos]);

  const handleAddTodo = React.useCallback(() => {
    const trimmed = newTodoText.trim();
    if (!trimmed) {
      return;
    }

    const nextTodos = insertTodoBeforeCompleted(todos, {
      id: createTodoId(),
      text: trimmed.slice(0, OPENCHAMBER_PROJECT_TODO_TEXT_MAX_LENGTH),
      completed: false,
      createdAt: Date.now(),
    });
    setTodos(nextTodos);
    setNewTodoText('');
    void persistProjectData(notes, nextTodos);
  }, [newTodoText, notes, persistProjectData, todos]);

  const handleToggleTodoExpanded = React.useCallback((id: string) => {
    setExpandedTodoIds((previous) => {
      const next = new Set(previous);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const handleToggleTodo = React.useCallback(
    (id: string, completed: boolean) => {
      const todo = todos.find((item) => item.id === id);
      if (!todo || todo.completed === completed) {
        return;
      }
      const remainingTodos = todos.filter((item) => item.id !== id);
      const updatedTodo = { ...todo, completed };
      const nextTodos = completed
        ? [...remainingTodos, updatedTodo]
        : insertTodoBeforeCompleted(remainingTodos, updatedTodo);
      setTodos(nextTodos);
      void persistProjectData(notes, nextTodos);
    },
    [notes, persistProjectData, todos]
  );

  const handleDeleteTodo = React.useCallback(
    (id: string) => {
      const nextTodos = todos.filter((todo) => todo.id !== id);
      setTodos(nextTodos);
      void persistProjectData(notes, nextTodos);
    },
    [notes, persistProjectData, todos]
  );

  const handleClearCompletedTodos = React.useCallback(() => {
    const nextTodos = todos.filter((todo) => !todo.completed);
    if (nextTodos.length === todos.length) {
      return;
    }
    setTodos(nextTodos);
    void persistProjectData(notes, nextTodos);
  }, [notes, persistProjectData, todos]);

  const handleTodoReorder = React.useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) {
        return;
      }
      const oldIndex = todos.findIndex((todo) => todo.id === active.id);
      const newIndex = todos.findIndex((todo) => todo.id === over.id);
      if (oldIndex === -1 || newIndex === -1) {
        return;
      }
      const nextTodos = sortTodosWithCompletedLast(arrayMove(todos, oldIndex, newIndex));
      setTodos(nextTodos);
      void persistProjectData(notes, nextTodos);
    },
    [notes, persistProjectData, todos]
  );

  const todoSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } })
  );

  const todoInputValue = newTodoText.slice(0, OPENCHAMBER_PROJECT_TODO_TEXT_MAX_LENGTH);
  const completedTodoCount = todos.reduce((count, todo) => count + (todo.completed ? 1 : 0), 0);

  const routeToChat = React.useCallback(() => {
    setActiveMainTab('chat');
    setSessionSwitcherOpen(false);
  }, [setActiveMainTab, setSessionSwitcherOpen]);

  const handleSendToNewSession = React.useCallback(
    (todoId: string, todoText: string) => {
      if (!projectRef || sendingTodoId) {
        return;
      }
      setPendingSendTarget({ kind: 'session', todoId, todoText });
    },
    [projectRef, sendingTodoId]
  );

  const handleSendToCurrentSession = React.useCallback(
    (todoText: string) => {
      if (!currentSessionId) {
        toast.error(t('rightSidebar.contextNotesTodo.toast.noActiveSession'));
        return;
      }
      routeToChat();
      const fenced = `\`\`\`md\n${todoText}\n\`\`\``;
      setPendingInputText(fenced, 'append');
      toast.success(t('rightSidebar.contextNotesTodo.toast.sentToCurrentSession'));
      onActionComplete?.();
    },
    [currentSessionId, onActionComplete, routeToChat, setPendingInputText, t]
  );

  const handleSendToNewWorktreeSession = React.useCallback(
    (todoId: string, todoText: string) => {
      if (!projectRef || sendingTodoId) {
        return;
      }
      if (!canCreateWorktree) {
        toast.error(t('rightSidebar.contextNotesTodo.toast.worktreeRequiresGitRepo'));
        return;
      }
      setPendingSendTarget({ kind: 'worktree', todoId, todoText });
    },
    [canCreateWorktree, projectRef, sendingTodoId, t]
  );

  const handleConfirmSend = React.useCallback(
    async (execution: TodoSendExecution) => {
      if (!projectRef || !pendingSendTarget) {
        return;
      }

      const visiblePrompt = await renderMagicPrompt('plan.todo.visible', {
        todo_text: pendingSendTarget.todoText,
      });
      const instructionsText = await renderMagicPrompt('plan.todo.instructions', {
        todo_text: pendingSendTarget.todoText,
      });
      const syntheticParts = [{ synthetic: true as const, text: instructionsText }];

      setIsSendDialogSubmitting(true);
      setSendingTodoId(pendingSendTarget.todoId);

      try {
        routeToChat();

        let sessionId: string | null = null;
        let directoryHint: string | null = projectRef.path;

        if (pendingSendTarget.kind === 'worktree') {
          if (!canCreateWorktree) {
            toast.error(t('rightSidebar.contextNotesTodo.toast.worktreeRequiresGitRepo'));
            return;
          }
          const created = await createWorktreeSessionForNewBranch(projectRef.path, generateBranchName());
          if (!created?.id) {
            return;
          }
          sessionId = created.id;
          directoryHint = null;
        } else {
          const session = await createSession(undefined, projectRef.path, null);
          if (!session?.id) {
            toast.error(t('rightSidebar.contextNotesTodo.toast.createSessionFailed'));
            return;
          }
          sessionId = session.id;
          directoryHint = session.directory ?? projectRef.path;
          initializeNewOpenChamberSession(session.id, useConfigStore.getState().agents ?? []);
        }

        if (!sessionId) {
          return;
        }

        const selectionState = useSelectionStore.getState();
        selectionState.saveSessionModelSelection(sessionId, execution.providerID, execution.modelID);
        if (execution.agent.trim()) {
          selectionState.saveSessionAgentSelection(sessionId, execution.agent);
          selectionState.saveAgentModelForSession(sessionId, execution.agent, execution.providerID, execution.modelID);
          selectionState.saveAgentModelVariantForSession(
            sessionId,
            execution.agent,
            execution.providerID,
            execution.modelID,
            execution.variant || undefined,
          );
        }

        setCurrentSession(sessionId, directoryHint);
        await sendMessage(
          visiblePrompt,
          execution.providerID,
          execution.modelID,
          execution.agent.trim() || undefined,
          undefined,
          undefined,
          syntheticParts,
          execution.variant || undefined,
        );

        toast.success(
          pendingSendTarget.kind === 'worktree'
            ? t('rightSidebar.contextNotesTodo.toast.sentToNewWorktreeSession')
            : t('rightSidebar.contextNotesTodo.toast.sentToNewSession')
        );
        setPendingSendTarget(null);
        onActionComplete?.();
      } catch (error) {
        const description = error instanceof Error ? error.message : undefined;
        toast.error(t('rightSidebar.contextNotesTodo.toast.sendTodoFailed'), description ? { description } : undefined);
      } finally {
        setIsSendDialogSubmitting(false);
        setSendingTodoId(null);
      }
    },
    [canCreateWorktree, createSession, initializeNewOpenChamberSession, onActionComplete, pendingSendTarget, projectRef, routeToChat, sendMessage, setCurrentSession, t]
  );

  const planFileInputRef = React.useRef<HTMLInputElement | null>(null);
  const [isImportingPlan, setIsImportingPlan] = React.useState(false);
  const [deletingPlanId, setDeletingPlanId] = React.useState<string | null>(null);

  const handleDeletePlan = React.useCallback(
    async (planId: string) => {
      if (!projectRef || deletingPlanId) {
        return;
      }
      setDeletingPlanId(planId);
      try {
        const ok = await deleteProjectPlanFile(projectRef, planId);
        if (!ok) {
          toast.error(t('rightSidebar.contextNotesTodo.toast.deletePlanFailed'));
          return;
        }
        setPlans((previous) => previous.filter((entry) => entry.id !== planId));
        window.dispatchEvent(new CustomEvent('openchamber:project-plan-saved', {
          detail: { projectId: projectRef.id },
        }));
      } finally {
        setDeletingPlanId(null);
      }
    },
    [deletingPlanId, projectRef, t]
  );

  const handleTriggerUploadPlan = React.useCallback(async () => {
    if (!projectRef || isImportingPlan) {
      return;
    }
    const result = await requestFileAccess({
      defaultPath: projectRef.path,
      filters: [
        { name: 'Plan files', extensions: ['md', 'markdown', 'txt'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (result.success && result.path) {
      setIsImportingPlan(true);
      try {
        const params = new URLSearchParams({
          path: result.path,
          allowOutsideWorkspace: 'true',
        });
        const response = await fetch(`/api/fs/read?${params.toString()}`, { cache: 'no-store' });
        if (!response.ok) {
          toast.error(t('rightSidebar.contextNotesTodo.toast.readPlanFileFailed'));
          return;
        }
        const text = await response.text();
        if (!text.trim()) {
          toast.error(t('rightSidebar.contextNotesTodo.toast.planFileEmpty'));
          return;
        }
        const fallbackTitle = result.path.split('/').pop()?.replace(/\.(md|markdown|txt)$/i, '').trim() || '';
        const created = await importProjectPlanFileFromContent(projectRef, text, fallbackTitle);
        if (!created) {
          toast.error(t('rightSidebar.contextNotesTodo.toast.importPlanFailed'));
          return;
        }
        window.dispatchEvent(new CustomEvent('openchamber:project-plan-saved', {
          detail: { projectId: projectRef.id },
        }));
        toast.success(t('rightSidebar.contextNotesTodo.toast.planImported'));
      } catch (error) {
        const description = error instanceof Error ? error.message : undefined;
        toast.error(t('rightSidebar.contextNotesTodo.toast.readPlanFileFailed'), description ? { description } : undefined);
      } finally {
        setIsImportingPlan(false);
      }
    } else if (result.error === 'Native file picker not available') {
      // Fall back to HTML file input for web/non-desktop runtimes
      planFileInputRef.current?.click();
    }
  }, [isImportingPlan, projectRef, t]);

  const handleUploadPlanFile = React.useCallback(
    async (file: File | null) => {
      if (!projectRef || !file) {
        return;
      }
      setIsImportingPlan(true);
      try {
        const text = await file.text();
        if (!text.trim()) {
          toast.error(t('rightSidebar.contextNotesTodo.toast.planFileEmpty'));
          return;
        }
        const fallbackTitle = file.name.replace(/\.(md|markdown|txt)$/i, '').trim();
        const created = await importProjectPlanFileFromContent(projectRef, text, fallbackTitle);
        if (!created) {
          toast.error(t('rightSidebar.contextNotesTodo.toast.importPlanFailed'));
          return;
        }
        window.dispatchEvent(new CustomEvent('openchamber:project-plan-saved', {
          detail: { projectId: projectRef.id },
        }));
        toast.success(t('rightSidebar.contextNotesTodo.toast.planImported'));
      } catch (error) {
        const description = error instanceof Error ? error.message : undefined;
        toast.error(t('rightSidebar.contextNotesTodo.toast.readPlanFileFailed'), description ? { description } : undefined);
      } finally {
        setIsImportingPlan(false);
      }
    },
    [projectRef, t]
  );

  const handleOpenPlan = React.useCallback(
    (plan: ProjectPlanListItem) => {
      const projectPath = projectRef?.path?.trim();
      const panelDirectory = currentDirectory?.trim() || projectPath;
      if (!panelDirectory) {
        return;
      }
      openContextPanelTab(panelDirectory, {
        mode: 'plan',
        targetPath: plan.path,
        dedupeKey: plan.path,
        label: plan.title,
      });
    },
    [currentDirectory, openContextPanelTab, projectRef]
  );

  if (!projectRef) {
    return (
      <div className={cn('w-full min-w-0 p-3', className)}>
        <p className="typography-meta text-muted-foreground">
          {t('rightSidebar.contextNotesTodo.empty.selectProject')}
        </p>
      </div>
    );
  }

  return (
    <div className={cn('w-full min-w-0 space-y-3 p-3', className)}>
      <div className="space-y-1">
        <div className="flex items-center justify-between gap-2">
          <h3 className="min-w-0 truncate typography-ui-label font-semibold text-foreground" title={projectRef.path}>
            {t('rightSidebar.contextNotesTodo.notes.title', {
              project: projectLabel?.trim() || projectRef.path.split('/').filter(Boolean).pop() || projectRef.path,
            })}
          </h3>
          <span className="typography-meta text-muted-foreground">{notes.length}/{OPENCHAMBER_PROJECT_NOTES_MAX_LENGTH}</span>
        </div>
        <Textarea
          value={notes}
          onChange={(event) => setNotes(event.target.value.slice(0, OPENCHAMBER_PROJECT_NOTES_MAX_LENGTH))}
          onBlur={handleNotesBlur}
          placeholder={t('rightSidebar.contextNotesTodo.notes.placeholder')}
          resizedHeight={notesPanelHeight}
          onResizeHeightChange={setNotesPanelHeight}
          useScrollShadow
          scrollShadowSize={56}
          disabled={isLoading}
        />
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <h3 className="typography-ui-label font-semibold text-foreground">
              {t('rightSidebar.contextNotesTodo.todo.title')}
            </h3>
            <span className="typography-meta text-muted-foreground">
              {todos.length === 1
                ? t('rightSidebar.contextNotesTodo.todo.itemsSingle', { count: todos.length })
                : t('rightSidebar.contextNotesTodo.todo.itemsPlural', { count: todos.length })}
            </span>
            <button
              type="button"
              onClick={handleClearCompletedTodos}
              disabled={isLoading || completedTodoCount === 0}
              className="typography-meta rounded-md px-1.5 py-0.5 text-muted-foreground hover:bg-interactive-hover/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {t('rightSidebar.contextNotesTodo.todo.clearCompleted')}
            </button>
          </div>
          <span className="typography-meta text-muted-foreground">{todoInputValue.length}/{OPENCHAMBER_PROJECT_TODO_TEXT_MAX_LENGTH}</span>
        </div>

        <div className="flex items-center gap-1.5">
          <Input
            value={todoInputValue}
            onChange={(event) => setNewTodoText(event.target.value.slice(0, OPENCHAMBER_PROJECT_TODO_TEXT_MAX_LENGTH))}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                handleAddTodo();
              }
            }}
            placeholder={t('rightSidebar.contextNotesTodo.todo.inputPlaceholder')}
            disabled={isLoading}
            className="h-8"
          />
          <button
            type="button"
            onClick={handleAddTodo}
            disabled={isLoading || todoInputValue.trim().length === 0}
            className="inline-flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md border border-border/70 text-muted-foreground hover:text-foreground hover:bg-interactive-hover/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 disabled:cursor-not-allowed disabled:opacity-50"
            aria-label={t('rightSidebar.contextNotesTodo.todo.addAria')}
            title={t('rightSidebar.contextNotesTodo.todo.addAria')}
          >
            <Icon name="add" className="h-4 w-4" />
          </button>
        </div>

        <div
          className={cn(
            'overflow-y-auto rounded-lg border border-border/60 bg-background/40',
            isTodoPanelResizing && 'transition-none'
          )}
          style={
            todos.length < 7
              ? undefined
              : {
                  height: `${todoPanelHeight}px`,
                  maxHeight: `${todoPanelHeight}px`,
                }
          }
        >
          {todos.length === 0 ? (
            <p className="px-3 py-3 typography-meta text-muted-foreground">
              {t('rightSidebar.contextNotesTodo.todo.empty')}
            </p>
          ) : (
            <DndContext
              sensors={todoSensors}
              collisionDetection={closestCenter}
              onDragEnd={handleTodoReorder}
            >
              <SortableContext
                items={todos.map((todo) => todo.id)}
                strategy={verticalListSortingStrategy}
              >
                <ul className="divide-y divide-border/50">
                  {todos.map((todo) => {
                    const isExpandedTodo = expandedTodoIds.has(todo.id);
                    return (
                      <SortableTodoItem key={todo.id} id={todo.id}>
                        {(dragHandleProps) => (
                          <div className={cn('flex gap-1.5 px-2.5 py-1.5', isExpandedTodo ? 'items-start' : 'items-center')}>
                            <button
                              type="button"
                              ref={dragHandleProps.setActivatorNodeRef}
                              {...dragHandleProps.attributes}
                              {...dragHandleProps.listeners}
                              onClick={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                              }}
                              className="flex h-6 w-4 flex-shrink-0 touch-none items-center justify-center text-muted-foreground hover:text-foreground"
                              aria-label={t('rightSidebar.contextNotesTodo.todo.actions.reorder', { text: todo.text })}
                              title={t('rightSidebar.contextNotesTodo.todo.actions.reorder', { text: todo.text })}
                            >
                              <Icon name="draggable" className="h-3.5 w-3.5" />
                            </button>
                            <div className="flex h-6 items-center">
                              <Checkbox
                                checked={todo.completed}
                                onChange={(checked) => handleToggleTodo(todo.id, checked)}
                                ariaLabel={t('rightSidebar.contextNotesTodo.todo.actions.markComplete', { text: todo.text })}
                              />
                            </div>
                            <button
                              type="button"
                              onClick={() => handleToggleTodoExpanded(todo.id)}
                              className={cn(
                                'block min-h-6 min-w-0 flex-1 bg-transparent p-0 text-left typography-ui-label leading-normal text-foreground',
                                isExpandedTodo ? 'whitespace-normal break-words' : 'overflow-hidden text-ellipsis whitespace-nowrap',
                                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
                                todo.completed && 'text-muted-foreground line-through'
                              )}
                              title={isExpandedTodo ? undefined : todo.text}
                              aria-label={
                                isExpandedTodo
                                  ? t('rightSidebar.contextNotesTodo.todo.actions.collapse', { text: todo.text })
                                  : t('rightSidebar.contextNotesTodo.todo.actions.expand', { text: todo.text })
                              }
                            >
                              {todo.text}
                            </button>
                            <div className="flex h-6 items-center gap-0.5">
                              <button
                                type="button"
                                onClick={() => handleDeleteTodo(todo.id)}
                                className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-interactive-hover/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                                aria-label={t('rightSidebar.contextNotesTodo.todo.actions.delete', { text: todo.text })}
                                title={t('rightSidebar.contextNotesTodo.todo.actions.delete', { text: todo.text })}
                              >
                                <Icon name="delete-bin" className="h-3.5 w-3.5" />
                              </button>
                              <DropdownMenu>
                                <DropdownMenuTrigger asChild>
                                  <button
                                    type="button"
                                    disabled={sendingTodoId === todo.id}
                                    className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-interactive-hover/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 disabled:cursor-not-allowed disabled:opacity-50"
                                    aria-label={t('rightSidebar.contextNotesTodo.todo.actions.send', { text: todo.text })}
                                    title={t('rightSidebar.contextNotesTodo.todo.actions.send', { text: todo.text })}
                                  >
                                    <Icon name="send-plane" className="h-3.5 w-3.5" />
                                  </button>
                                </DropdownMenuTrigger>
                                <DropdownMenuContent align="end" className="w-56">
                                  <DropdownMenuItem onClick={() => handleSendToCurrentSession(todo.text)}>
                                    {t('rightSidebar.contextNotesTodo.todo.sendMenu.currentSession')}
                                  </DropdownMenuItem>
                                  <DropdownMenuItem onClick={() => handleSendToNewSession(todo.id, todo.text)}>
                                    {t('rightSidebar.contextNotesTodo.todo.sendMenu.newSession')}
                                  </DropdownMenuItem>
                                  <DropdownMenuItem
                                    onClick={() => void handleSendToNewWorktreeSession(todo.id, todo.text)}
                                    disabled={!canCreateWorktree}
                                  >
                                    {t('rightSidebar.contextNotesTodo.todo.sendMenu.newWorktreeSession')}
                                  </DropdownMenuItem>
                                </DropdownMenuContent>
                              </DropdownMenu>
                            </div>
                          </div>
                        )}
                      </SortableTodoItem>
                    );
                  })}
                </ul>
              </SortableContext>
            </DndContext>
          )}
        </div>
        {todos.length >= 7 && (
          <div
            className={cn(
              'h-[3px] w-full cursor-row-resize hover:bg-[var(--interactive-border)]/80 transition-colors',
              isTodoPanelResizing && 'bg-[var(--interactive-border)]'
            )}
            onPointerDown={handleTodoPanelResizeStart}
            role="separator"
            aria-orientation="horizontal"
            aria-label={t('rightSidebar.contextNotesTodo.todo.resizeAria')}
          />
        )}
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <h3 className="typography-ui-label font-semibold text-foreground">
              {t('rightSidebar.contextNotesTodo.plans.title')}
            </h3>
            <span className="typography-meta text-muted-foreground">
              {plans.length === 1
                ? t('rightSidebar.contextNotesTodo.plans.filesSingle', { count: plans.length })
                : t('rightSidebar.contextNotesTodo.plans.filesPlural', { count: plans.length })}
            </span>
          </div>
          <input
            ref={planFileInputRef}
            type="file"
            accept=".md,.markdown,.txt,text/markdown,text/plain"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0] ?? null;
              void handleUploadPlanFile(file);
              event.currentTarget.value = '';
            }}
          />
          <button
            type="button"
            onClick={handleTriggerUploadPlan}
            disabled={!projectRef || isImportingPlan}
            className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-border/70 text-muted-foreground hover:text-foreground hover:bg-interactive-hover/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 disabled:cursor-not-allowed disabled:opacity-50"
            aria-label={t('rightSidebar.contextNotesTodo.plans.importFromFile')}
            title={t('rightSidebar.contextNotesTodo.plans.importFromFile')}
          >
            <Icon name="add" className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="max-h-56 overflow-y-auto rounded-lg border border-border/60 bg-background/40">
          {plans.length === 0 ? (
            <p className="px-3 py-3 typography-meta text-muted-foreground">
              {t('rightSidebar.contextNotesTodo.plans.empty')}
            </p>
          ) : (
            <ul className="divide-y divide-border/50">
              {plans.map((plan) => (
                <li key={plan.id} className="flex items-center gap-1.5 px-2.5 py-1.5">
                  <button
                    type="button"
                    onClick={() => handleOpenPlan(plan)}
                    className="flex min-w-0 flex-1 items-center justify-between gap-3 rounded-md px-1.5 py-1 text-left hover:bg-interactive-hover/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                  >
                    <span className="min-w-0 truncate typography-ui-label text-foreground">{plan.title}</span>
                    <span className="flex-shrink-0 typography-micro text-muted-foreground">
                      {new Date(plan.createdAt).toLocaleDateString(getCurrentIntlLocale())}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleDeletePlan(plan.id)}
                    disabled={deletingPlanId === plan.id}
                    className="inline-flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-interactive-hover/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 disabled:cursor-not-allowed disabled:opacity-50"
                    title={t('rightSidebar.contextNotesTodo.plans.deletePlan')}
                    aria-label={t('rightSidebar.contextNotesTodo.plans.deletePlanWithTitle', { title: plan.title })}
                  >
                    <Icon name="delete-bin" className="h-3.5 w-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <TodoSendDialog
        open={pendingSendTarget !== null}
        onOpenChange={(open) => {
          if (!open && !isSendDialogSubmitting) {
            setPendingSendTarget(null);
          }
        }}
        target={pendingSendTarget?.kind ?? 'session'}
        projectDirectory={projectRef?.path ?? null}
        submitting={isSendDialogSubmitting}
        onConfirm={handleConfirmSend}
      />
    </div>
  );
};
