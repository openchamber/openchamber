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
import { useUIStore } from '@/stores/useUIStore';
import { useSessionStore } from '@/stores/useSessionStore';
import { createWorktreeOnly } from '@/lib/worktreeSessionCreator';
import { cn } from '@/lib/utils';
import { useLanguage } from '@/hooks/useLanguage';

interface ProjectNotesTodoPanelProps {
  projectRef: ProjectRef | null;
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
  canCreateWorktree = false,
  onActionComplete,
  className,
}) => {
  const { t } = useLanguage();
  const [isLoading, setIsLoading] = React.useState(false);
  const [notes, setNotes] = React.useState('');
  const [todos, setTodos] = React.useState<OpenChamberProjectTodoItem[]>([]);
  const [newTodoText, setNewTodoText] = React.useState('');
  const [sendingTodoId, setSendingTodoId] = React.useState<string | null>(null);

  const currentSessionId = useSessionStore((state) => state.currentSessionId);
  const openNewSessionDraft = useSessionStore((state) => state.openNewSessionDraft);
  const setPendingInputText = useSessionStore((state) => state.setPendingInputText);
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
        toast.error(t('projectNotes.failedToSaveProjectNotes'));
      }
      return saved;
    },
    [projectRef, t]
  );

  React.useEffect(() => {
    if (!projectRef) {
      setNotes('');
      setTodos([]);
      setNewTodoText('');
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
      } catch {
        if (!cancelled) {
          toast.error(t('projectNotes.failedToLoadProjectNotes'));
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
  }, [projectRef, t]);

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
      toast.success(t('projectNotes.todoSentToNewSession'));
      onActionComplete?.();
    },
    [onActionComplete, openNewSessionDraft, projectRef, routeToChat, t]
  );

  const handleSendToCurrentSession = React.useCallback(
    (todoText: string) => {
      if (!currentSessionId) {
        toast.error(t('projectNotes.noActiveSessionSelected'));
        return;
      }
      routeToChat();
      const fenced = `\`\`\`md\n${todoText}\n\`\`\``;
      setPendingInputText(fenced, 'append');
      toast.success('Todo sent to current session');
      onActionComplete?.();
    },
    [currentSessionId, onActionComplete, routeToChat, setPendingInputText, t]
  );

  const handleSendToNewWorktreeSession = React.useCallback(
    async (todoId: string, todoText: string) => {
      if (!projectRef) {
        return;
      }
      if (!canCreateWorktree) {
        toast.error(t('projectNotes.worktreeActionsOnlyForGitRepos'));
        return;
      }
      setSendingTodoId(todoId);
      try {
        const newWorktreePath = await createWorktreeOnly();
        if (!newWorktreePath) {
          return;
        }
        routeToChat();
        openNewSessionDraft({
          directoryOverride: newWorktreePath,
          initialPrompt: todoText,
        });
        toast.success(t('projectNotes.todoSentToNewWorktreeSession'));
        onActionComplete?.();
      } finally {
        setSendingTodoId(null);
      }
    },
    [canCreateWorktree, onActionComplete, openNewSessionDraft, projectRef, routeToChat, t]
  );

  if (!projectRef) {
    return (
      <div className={cn('w-full min-w-0 p-3', className)}>
        <p className="typography-meta text-muted-foreground">{t('projectNotes.selectProjectToAddNotes')}</p>
      </div>
    );
  }

  return (
    <div className={cn('w-full min-w-0 space-y-3 p-3', className)}>
      <div className="space-y-1">
        <div className="flex items-center justify-between gap-2">
          <h3 className="typography-ui-label font-semibold text-foreground">{t('projectNotes.quickNotes')}</h3>
          <span className="typography-meta text-muted-foreground">{notes.length}/{OPENCHAMBER_PROJECT_NOTES_MAX_LENGTH}</span>
        </div>
        <Textarea
          value={notes}
          onChange={(event) => setNotes(event.target.value.slice(0, OPENCHAMBER_PROJECT_NOTES_MAX_LENGTH))}
          onBlur={handleNotesBlur}
          placeholder={t('projectNotes.captureContextPlaceholder')}
          className="min-h-24 resize-none"
          disabled={isLoading}
        />
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <h3 className="typography-ui-label font-semibold text-foreground">{t('projectNotes.todo')}</h3>
          <div className="flex items-center gap-2">
            <span className="typography-meta text-muted-foreground">{t('projectNotes.itemsCount', { count: todos.length })}</span>
            <button
              type="button"
              onClick={handleClearCompletedTodos}
              disabled={isLoading || completedTodoCount === 0}
              className="typography-meta rounded-md px-1.5 py-0.5 text-muted-foreground hover:bg-interactive-hover/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {t('projectNotes.clearCompleted')}
            </button>
          </div>
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
            placeholder={t('projectNotes.addTodoPlaceholder')}
            disabled={isLoading}
            className="h-8"
          />
          <button
            type="button"
            onClick={handleAddTodo}
            disabled={isLoading || todoInputValue.trim().length === 0}
            className="inline-flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md border border-border/70 text-muted-foreground hover:text-foreground hover:bg-interactive-hover/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 disabled:cursor-not-allowed disabled:opacity-50"
            aria-label={t('projectNotes.addTodo')}
          >
            <RiAddLine className="h-4 w-4" />
          </button>
        </div>

        <div className="max-h-56 overflow-y-auto rounded-lg border border-border/60 bg-background/40">
          {todos.length === 0 ? (
            <p className="px-3 py-3 typography-meta text-muted-foreground">{t('projectNotes.noTodosYet')}</p>
          ) : (
            <ul className="divide-y divide-border/50">
              {todos.map((todo) => (
                <li key={todo.id} className="flex items-center gap-1.5 px-2.5 py-1.5">
                  <Checkbox
                    checked={todo.completed}
                    onChange={(checked) => handleToggleTodo(todo.id, checked)}
                    ariaLabel={t('projectNotes.markTodoComplete', { text: todo.text })}
                  />
                  <span
                    className={cn(
                      'min-w-0 flex-1 typography-ui-label text-foreground',
                      todo.completed && 'text-muted-foreground line-through'
                    )}
                    title={todo.text}
                  >
                    {todo.text}
                  </span>
                  <button
                    type="button"
                    onClick={() => handleDeleteTodo(todo.id)}
                    className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-interactive-hover/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                    aria-label={t('projectNotes.deleteTodo', { text: todo.text })}
                  >
                    <RiDeleteBinLine className="h-3.5 w-3.5" />
                  </button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <button
                        type="button"
                        disabled={sendingTodoId === todo.id}
                        className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-interactive-hover/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 disabled:cursor-not-allowed disabled:opacity-50"
                        aria-label={t('projectNotes.sendTodo', { text: todo.text })}
                      >
                        <RiSendPlaneLine className="h-3.5 w-3.5" />
                      </button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-56">
                      <DropdownMenuItem onClick={() => handleSendToCurrentSession(todo.text)}>
                        {t('projectNotes.sendToCurrentSession')}
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => handleSendToNewSession(todo.text)}>
                        {t('projectNotes.sendToNewSession')}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => void handleSendToNewWorktreeSession(todo.id, todo.text)}
                        disabled={!canCreateWorktree}
                      >
                        {t('projectNotes.sendToNewWorktreeSession')}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
};
