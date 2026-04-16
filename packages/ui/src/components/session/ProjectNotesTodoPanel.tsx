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
  getProjectNotesAndTodos,
  OPENCHAMBER_PROJECT_NOTES_MAX_LENGTH,
  OPENCHAMBER_PROJECT_TODO_TEXT_MAX_LENGTH,
  saveProjectNotesAndTodos,
  type OpenChamberProjectTodoItem,
  type ProjectRef,
} from '@/lib/openchamberConfig';
import { m } from '@/lib/i18n/messages';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useInputStore } from '@/sync/input-store';
import { createWorktreeDraft } from '@/lib/worktreeSessionCreator';
import { cn } from '@/lib/utils';

interface ProjectNotesTodoPanelProps {
  projectRef: ProjectRef | null;
  projectLabel?: string | null;
  canCreateWorktree?: boolean;
  onActionComplete?: () => void;
  className?: string;
}

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

  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const openNewSessionDraft = useSessionUIStore((state) => state.openNewSessionDraft);
  const setPendingInputText = useInputStore((state) => state.setPendingInputText);
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
        toast.error(m.pnFailedToSaveProjectNotes());
      }
      return saved;
    },
    [projectRef]
  );

  React.useEffect(() => {
    if (!projectRef) {
      setNotes('');
      setTodos([]);
      setNewTodoText('');
      setExpandedTodoIds(new Set());
      return;
    }

    let cancelled = false;
    setIsLoading(true);

    (async () => {
      try {
        const data = await getProjectNotesAndTodos(projectRef);
        if (cancelled) {
          return;
        }
        setNotes(data.notes);
        setTodos(data.todos);
        setNewTodoText('');
        setExpandedTodoIds(new Set());
      } catch {
        if (!cancelled) {
          toast.error(m.pnFailedToLoadProjectNotes());
          setNotes('');
          setTodos([]);
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
  }, [projectRef]);

  const handleNotesBlur = React.useCallback(() => {
    void persistProjectData(notes, todos);
  }, [notes, persistProjectData, todos]);

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
    (todoText: string) => {
      if (!projectRef) {
        return;
      }
      routeToChat();
      openNewSessionDraft({
        directoryOverride: projectRef.path,
        initialPrompt: todoText,
      });
      toast.success(m.pnTodoSentToNewSession());
      onActionComplete?.();
    },
    [onActionComplete, openNewSessionDraft, projectRef, routeToChat]
  );

  const handleSendToCurrentSession = React.useCallback(
    (todoText: string) => {
      if (!currentSessionId) {
        toast.error(m.pnNoActiveSessionSelected());
        return;
      }
      routeToChat();
      const fenced = `\`\`\`md\n${todoText}\n\`\`\``;
      setPendingInputText(fenced, 'append');
      toast.success(m.pnTodoSentToCurrentSession());
      onActionComplete?.();
    },
    [currentSessionId, onActionComplete, routeToChat, setPendingInputText]
  );

  const handleSendToNewWorktreeSession = React.useCallback(
    async (todoId: string, todoText: string) => {
      if (!projectRef) {
        return;
      }
      if (!canCreateWorktree) {
        toast.error(m.pnWorktreeActionsOnlyAvailableForGitRepos());
        return;
      }
      setSendingTodoId(todoId);
      try {
        routeToChat();
        const newWorktreePath = await createWorktreeDraft({ initialPrompt: todoText });
        if (!newWorktreePath) {
          return;
        }
        toast.success(m.pnTodoSentToNewWorktreeSession());
        onActionComplete?.();
      } finally {
        setSendingTodoId(null);
      }
    },
    [canCreateWorktree, onActionComplete, projectRef, routeToChat]
  );

  if (!projectRef) {
    return (
      <div className={cn('w-full min-w-0 p-3', className)}>
        <p className="typography-meta text-muted-foreground">{m.pnSelectProjectToAddNotesAndTodos()}</p>
      </div>
    );
  }

  return (
    <div className={cn('w-full min-w-0 space-y-3 p-3', className)}>
      <div className="space-y-1">
        <div className="flex items-center justify-between gap-2">
          <h3 className="min-w-0 truncate typography-ui-label font-semibold text-foreground" title={projectRef.path}>
            {m.pnQuickNotes({ label: projectLabel?.trim() || projectRef.path.split('/').filter(Boolean).pop() || projectRef.path })}
          </h3>
          <span className="typography-meta text-muted-foreground">{notes.length}/{OPENCHAMBER_PROJECT_NOTES_MAX_LENGTH}</span>
        </div>
          <Textarea
            value={notes}
            onChange={(event) => setNotes(event.target.value.slice(0, OPENCHAMBER_PROJECT_NOTES_MAX_LENGTH))}
            onBlur={handleNotesBlur}
            placeholder={m.pnCaptureContextRemindersOrLinks()}
            className="min-h-28 max-h-80 resize-none"
            useScrollShadow
            scrollShadowSize={56}
            disabled={isLoading}
          />
      </div>

      <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <h3 className="typography-ui-label font-semibold text-foreground">{m.pnTodo()}</h3>
              <span className="typography-meta text-muted-foreground">{m.pnItemCount({ count: todos.length })}</span>
              <button
                type="button"
                onClick={handleClearCompletedTodos}
                disabled={isLoading || completedTodoCount === 0}
                className="typography-meta rounded-md px-1.5 py-0.5 text-muted-foreground hover:bg-interactive-hover/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {m.pnClearCompleted()}
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
            placeholder={m.pnAddATodo()}
            disabled={isLoading}
            className="h-8"
          />
          <button
            type="button"
            onClick={handleAddTodo}
            disabled={isLoading || todoInputValue.trim().length === 0}
            className="inline-flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md border border-border/70 text-muted-foreground hover:text-foreground hover:bg-interactive-hover/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 disabled:cursor-not-allowed disabled:opacity-50"
            aria-label={m.pnAddTodo()}
          >
            <RiAddLine className="h-4 w-4" />
          </button>
        </div>

        <div className="max-h-56 overflow-y-auto rounded-lg border border-border/60 bg-background/40">
          {todos.length === 0 ? (
            <p className="px-3 py-3 typography-meta text-muted-foreground">{m.pnNoTodosYet()}</p>
          ) : (
            <ul className="divide-y divide-border/50">
              {todos.map((todo) => {
                const isExpandedTodo = expandedTodoIds.has(todo.id);
                return (
                <li key={todo.id} className="flex items-start gap-1.5 px-2.5 py-1.5">
                  <Checkbox
                    checked={todo.completed}
                    onChange={(checked) => handleToggleTodo(todo.id, checked)}
                    ariaLabel={`Mark "${todo.text}" complete`}
                    className="mt-[3px] self-start"
                  />
                  <button
                    type="button"
                    onClick={() => handleToggleTodoExpanded(todo.id)}
                    className={cn(
                      'mt-[3px] min-w-0 flex-1 self-start bg-transparent p-0 text-left typography-ui-label text-foreground',
                      isExpandedTodo ? 'whitespace-normal break-words' : 'truncate',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
                      todo.completed && 'text-muted-foreground line-through'
                    )}
                    title={isExpandedTodo ? undefined : todo.text}
                    aria-label={isExpandedTodo ? `Collapse todo "${todo.text}"` : `Expand todo "${todo.text}"`}
                  >
                    {todo.text}
                  </button>
                  <div className="mt-0.5 flex self-start items-center gap-0.5">
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
                          {m.pnSendToCurrentSession()}
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => handleSendToNewSession(todo.text)}>
                          {m.pnSendToNewSession()}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() => void handleSendToNewWorktreeSession(todo.id, todo.text)}
                          disabled={!canCreateWorktree}
                        >
                          {m.pnSendToNewWorktreeSession()}
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
    </div>
  );
};
