import React from 'react';
import { RiAddLine, RiDeleteBinLine, RiSendPlaneLine } from '@remixicon/react';
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
import { TodoSendDialog, type TodoSendExecution } from './TodoSendDialog';

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

const toPlanListItem = async (plan: OpenChamberProjectPlanFileLink): Promise<ProjectPlanListItem> => {
  const file = await readProjectPlanFile(plan.path);
  return {
    ...plan,
    title: file?.title || plan.path.split('/').pop() || 'Plan',
  };
};

const createTodoId = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `todo_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
};

export const ProjectNotesTodoPanel: React.FC<ProjectNotesTodoPanelProps> = ({
  projectRef,
  projectLabel,
  canCreateWorktree = false,
  onActionComplete,
  className,
}) => {
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
        toast.error('Failed to save project notes');
      }
      return saved;
    },
    [projectRef]
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
        const nextPlans = await Promise.all(data.plans.map((plan) => toPlanListItem(plan)));
        if (cancelled) {
          return;
        }
        setNotes(data.notes);
        setTodos(data.todos);
        setPlans(nextPlans);
        lastSavedNotesRef.current = data.notes;
        notesHydratedRef.current = true;
        setNewTodoText('');
        setExpandedTodoIds(new Set());
      } catch {
        if (!cancelled) {
          toast.error('Failed to load project notes');
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
  }, [contextReloadTick, projectRef]);

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

    const nextTodos = [
      ...todos,
      {
        id: createTodoId(),
        text: trimmed.slice(0, OPENCHAMBER_PROJECT_TODO_TEXT_MAX_LENGTH),
        completed: false,
        createdAt: Date.now(),
      },
    ];
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
      const nextTodos = todos.map((todo) => (todo.id === id ? { ...todo, completed } : todo));
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
        toast.error('No active session selected');
        return;
      }
      routeToChat();
      const fenced = `\`\`\`md\n${todoText}\n\`\`\``;
      setPendingInputText(fenced, 'append');
      toast.success('Todo sent to current session');
      onActionComplete?.();
    },
    [currentSessionId, onActionComplete, routeToChat, setPendingInputText]
  );

  const handleSendToNewWorktreeSession = React.useCallback(
    (todoId: string, todoText: string) => {
      if (!projectRef || sendingTodoId) {
        return;
      }
      if (!canCreateWorktree) {
        toast.error('Worktree actions are only available for Git repositories');
        return;
      }
      setPendingSendTarget({ kind: 'worktree', todoId, todoText });
    },
    [canCreateWorktree, projectRef, sendingTodoId]
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
            toast.error('Worktree actions are only available for Git repositories');
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
            toast.error('Failed to create session');
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
            ? 'Todo sent to new worktree session'
            : 'Todo sent to new session'
        );
        setPendingSendTarget(null);
        onActionComplete?.();
      } catch (error) {
        const description = error instanceof Error ? error.message : undefined;
        toast.error('Failed to send todo', description ? { description } : undefined);
      } finally {
        setIsSendDialogSubmitting(false);
        setSendingTodoId(null);
      }
    },
    [canCreateWorktree, createSession, initializeNewOpenChamberSession, onActionComplete, pendingSendTarget, projectRef, routeToChat, sendMessage, setCurrentSession]
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
          toast.error('Failed to delete plan');
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
    [deletingPlanId, projectRef]
  );

  const handleTriggerUploadPlan = React.useCallback(() => {
    if (!projectRef || isImportingPlan) {
      return;
    }
    planFileInputRef.current?.click();
  }, [isImportingPlan, projectRef]);

  const handleUploadPlanFile = React.useCallback(
    async (file: File | null) => {
      if (!projectRef || !file) {
        return;
      }
      setIsImportingPlan(true);
      try {
        const text = await file.text();
        if (!text.trim()) {
          toast.error('Plan file is empty');
          return;
        }
        const fallbackTitle = file.name.replace(/\.(md|markdown|txt)$/i, '').trim();
        const created = await importProjectPlanFileFromContent(projectRef, text, fallbackTitle);
        if (!created) {
          toast.error('Failed to import plan');
          return;
        }
        window.dispatchEvent(new CustomEvent('openchamber:project-plan-saved', {
          detail: { projectId: projectRef.id },
        }));
        toast.success('Plan imported');
      } catch (error) {
        const description = error instanceof Error ? error.message : undefined;
        toast.error('Failed to read plan file', description ? { description } : undefined);
      } finally {
        setIsImportingPlan(false);
      }
    },
    [projectRef]
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
        <p className="typography-meta text-muted-foreground">Select a project to add notes and todos.</p>
      </div>
    );
  }

  return (
    <div className={cn('w-full min-w-0 space-y-3 p-3', className)}>
      <div className="space-y-1">
        <div className="flex items-center justify-between gap-2">
          <h3 className="min-w-0 truncate typography-ui-label font-semibold text-foreground" title={projectRef.path}>
            Quick notes - {projectLabel?.trim() || projectRef.path.split('/').filter(Boolean).pop() || projectRef.path}
          </h3>
          <span className="typography-meta text-muted-foreground">{notes.length}/{OPENCHAMBER_PROJECT_NOTES_MAX_LENGTH}</span>
        </div>
        <Textarea
          value={notes}
          onChange={(event) => setNotes(event.target.value.slice(0, OPENCHAMBER_PROJECT_NOTES_MAX_LENGTH))}
          onBlur={handleNotesBlur}
          placeholder="Capture context, reminders, or links"
          className="min-h-28 max-h-80 resize-none"
          useScrollShadow
          scrollShadowSize={56}
          disabled={isLoading}
        />
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <h3 className="typography-ui-label font-semibold text-foreground">Todo</h3>
            <span className="typography-meta text-muted-foreground">{todos.length} item{todos.length === 1 ? '' : 's'}</span>
            <button
              type="button"
              onClick={handleClearCompletedTodos}
              disabled={isLoading || completedTodoCount === 0}
              className="typography-meta rounded-md px-1.5 py-0.5 text-muted-foreground hover:bg-interactive-hover/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Clear completed
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
            placeholder="Add a todo"
            disabled={isLoading}
            className="h-8"
          />
          <button
            type="button"
            onClick={handleAddTodo}
            disabled={isLoading || todoInputValue.trim().length === 0}
            className="inline-flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md border border-border/70 text-muted-foreground hover:text-foreground hover:bg-interactive-hover/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 disabled:cursor-not-allowed disabled:opacity-50"
            aria-label="Add todo"
          >
            <RiAddLine className="h-4 w-4" />
          </button>
        </div>

        <div className="max-h-56 overflow-y-auto rounded-lg border border-border/60 bg-background/40">
          {todos.length === 0 ? (
            <p className="px-3 py-3 typography-meta text-muted-foreground">No todos yet. Add a small checklist for this project.</p>
          ) : (
            <ul className="divide-y divide-border/50">
              {todos.map((todo) => {
                const isExpandedTodo = expandedTodoIds.has(todo.id);
                return (
                  <li key={todo.id} className="flex items-start gap-1.5 px-2.5 py-1.5">
                    <div className="flex h-6 items-center">
                      <Checkbox
                        checked={todo.completed}
                        onChange={(checked) => handleToggleTodo(todo.id, checked)}
                        ariaLabel={`Mark "${todo.text}" complete`}
                      />
                    </div>
                    <button
                      type="button"
                      onClick={() => handleToggleTodoExpanded(todo.id)}
                      className={cn(
                        'block min-h-6 min-w-0 flex-1 bg-transparent p-0 text-left typography-ui-label leading-6 text-foreground',
                        isExpandedTodo ? 'whitespace-normal break-words' : 'overflow-hidden text-ellipsis whitespace-nowrap',
                        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
                        todo.completed && 'text-muted-foreground line-through'
                      )}
                      title={isExpandedTodo ? undefined : todo.text}
                      aria-label={isExpandedTodo ? `Collapse todo "${todo.text}"` : `Expand todo "${todo.text}"`}
                    >
                      {todo.text}
                    </button>
                    <div className="flex h-6 items-center gap-0.5">
                      <button
                        type="button"
                        onClick={() => handleDeleteTodo(todo.id)}
                        className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-interactive-hover/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                        aria-label={`Delete "${todo.text}"`}
                      >
                        <RiDeleteBinLine className="h-3.5 w-3.5" />
                      </button>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button
                            type="button"
                            disabled={sendingTodoId === todo.id}
                            className="inline-flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-interactive-hover/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 disabled:cursor-not-allowed disabled:opacity-50"
                            aria-label={`Send "${todo.text}"`}
                          >
                            <RiSendPlaneLine className="h-3.5 w-3.5" />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-56">
                          <DropdownMenuItem onClick={() => handleSendToCurrentSession(todo.text)}>
                            Send to current session
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => handleSendToNewSession(todo.id, todo.text)}>
                            Send to new session
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() => void handleSendToNewWorktreeSession(todo.id, todo.text)}
                            disabled={!canCreateWorktree}
                          >
                            Send to new worktree session
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <h3 className="typography-ui-label font-semibold text-foreground">Plans</h3>
            <span className="typography-meta text-muted-foreground">{plans.length} file{plans.length === 1 ? '' : 's'}</span>
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
            aria-label="Import plan from file"
            title="Import plan from file"
          >
            <RiAddLine className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="max-h-56 overflow-y-auto rounded-lg border border-border/60 bg-background/40">
          {plans.length === 0 ? (
            <p className="px-3 py-3 typography-meta text-muted-foreground">No saved plans yet.</p>
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
                      {new Date(plan.createdAt).toLocaleDateString()}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleDeletePlan(plan.id)}
                    disabled={deletingPlanId === plan.id}
                    className="inline-flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-interactive-hover/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 disabled:cursor-not-allowed disabled:opacity-50"
                    aria-label={`Delete plan "${plan.title}"`}
                    title="Delete plan"
                  >
                    <RiDeleteBinLine className="h-3.5 w-3.5" />
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
