import { matchesRankQuery } from '@/lib/search/fuzzySearch';
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

import { Checkbox } from '@/components/ui/checkbox';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { PROJECT_TODO_TEXT_MAX_LENGTH, type ProjectTodoItem } from '@/lib/projectContextApi';
import { cn } from '@/lib/utils';

const createTodoId = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `todo_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
};

const sortTodosWithCompletedLast = (items: ProjectTodoItem[]): ProjectTodoItem[] => [
  ...items.filter((todo) => !todo.completed),
  ...items.filter((todo) => todo.completed),
];

const insertTodoBeforeCompleted = (items: ProjectTodoItem[], item: ProjectTodoItem): ProjectTodoItem[] => {
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

export const TodosSection: React.FC<{
  todos: ProjectTodoItem[];
  /** Panel-wide filter. Mutations still act on the full list. */
  query: string;
  disabled: boolean;
  canCreateWorktree: boolean;
  sendingTodoId: string | null;
  /** Persists the whole list through the container's store write. */
  onPersistTodos: (next: ProjectTodoItem[]) => void;
  onSendToCurrentSession: (todoText: string) => void;
  onSendToNewSession: (todoId: string, todoText: string) => void;
  onSendToNewWorktreeSession: (todoId: string, todoText: string) => void;
}> = ({
  todos,
  query,
  disabled,
  canCreateWorktree,
  sendingTodoId,
  onPersistTodos,
  onSendToCurrentSession,
  onSendToNewSession,
  onSendToNewWorktreeSession,
}) => {
  const { t } = useI18n();
  const [newTodoText, setNewTodoText] = React.useState('');
  const [expandedTodoIds, setExpandedTodoIds] = React.useState<Set<string>>(() => new Set());

  const handleAddTodo = React.useCallback(() => {
    const trimmed = newTodoText.trim();
    if (!trimmed) {
      return;
    }
    onPersistTodos(insertTodoBeforeCompleted(todos, {
      id: createTodoId(),
      text: trimmed.slice(0, PROJECT_TODO_TEXT_MAX_LENGTH),
      completed: false,
      createdAt: Date.now(),
    }));
    setNewTodoText('');
  }, [newTodoText, onPersistTodos, todos]);

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
      const remaining = todos.filter((item) => item.id !== id);
      const updated = { ...todo, completed };
      onPersistTodos(completed ? [...remaining, updated] : insertTodoBeforeCompleted(remaining, updated));
    },
    [onPersistTodos, todos]
  );

  const handleDeleteTodo = React.useCallback(
    (id: string) => {
      onPersistTodos(todos.filter((todo) => todo.id !== id));
    },
    [onPersistTodos, todos]
  );

  const handleClearCompletedTodos = React.useCallback(() => {
    const next = todos.filter((todo) => !todo.completed);
    if (next.length === todos.length) {
      return;
    }
    onPersistTodos(next);
  }, [onPersistTodos, todos]);

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
      onPersistTodos(sortTodosWithCompletedLast(arrayMove(todos, oldIndex, newIndex)));
    },
    [onPersistTodos, todos]
  );

  const todoSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } })
  );

  const todoInputValue = newTodoText.slice(0, PROJECT_TODO_TEXT_MAX_LENGTH);
  const completedTodoCount = todos.reduce((count, todo) => count + (todo.completed ? 1 : 0), 0);
  // Filtering is display-only: every handler above still edits the full list,
  // so reordering or clearing while a filter is active cannot drop hidden items.
  const visibleTodos = React.useMemo(
    () => todos.filter((todo) => matchesRankQuery([todo.text], query)),
    [query, todos],
  );

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleClearCompletedTodos}
            disabled={disabled || completedTodoCount === 0}
            className="typography-meta rounded-md px-1.5 py-0.5 text-muted-foreground hover:bg-interactive-hover/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t('rightSidebar.contextNotesTodo.todo.clearCompleted')}
          </button>
        </div>
        <span className="typography-meta text-muted-foreground">{todoInputValue.length}/{PROJECT_TODO_TEXT_MAX_LENGTH}</span>
      </div>

      <div className="flex items-center gap-1.5">
        <Input
          value={todoInputValue}
          onChange={(event) => setNewTodoText(event.target.value.slice(0, PROJECT_TODO_TEXT_MAX_LENGTH))}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              handleAddTodo();
            }
          }}
          placeholder={t('rightSidebar.contextNotesTodo.todo.inputPlaceholder')}
          disabled={disabled}
          className="h-8"
        />
        <button
          type="button"
          onClick={handleAddTodo}
          disabled={disabled || todoInputValue.trim().length === 0}
          className="inline-flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md border border-border/70 text-muted-foreground hover:text-foreground hover:bg-interactive-hover/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 disabled:cursor-not-allowed disabled:opacity-50"
          aria-label={t('rightSidebar.contextNotesTodo.todo.addAria')}
          title={t('rightSidebar.contextNotesTodo.todo.addAria')}
        >
          <Icon name="add" className="h-4 w-4" />
        </button>
      </div>

      <div className="rounded-lg border border-border/60 bg-background/40">
        {visibleTodos.length === 0 ? (
          <p className="px-3 py-3 typography-meta text-muted-foreground">
            {query.trim()
              ? t('rightSidebar.contextNotesTodo.search.noResults', { query: query.trim() })
              : t('rightSidebar.contextNotesTodo.todo.empty')}
          </p>
        ) : (
          <DndContext
            sensors={todoSensors}
            collisionDetection={closestCenter}
            onDragEnd={handleTodoReorder}
          >
            <SortableContext
              items={visibleTodos.map((todo) => todo.id)}
              strategy={verticalListSortingStrategy}
            >
              <ul className="divide-y divide-border/50">
                {visibleTodos.map((todo) => {
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
                                <DropdownMenuItem onClick={() => onSendToCurrentSession(todo.text)}>
                                  {t('rightSidebar.contextNotesTodo.todo.sendMenu.currentSession')}
                                </DropdownMenuItem>
                                <DropdownMenuItem onClick={() => onSendToNewSession(todo.id, todo.text)}>
                                  {t('rightSidebar.contextNotesTodo.todo.sendMenu.newSession')}
                                </DropdownMenuItem>
                                <DropdownMenuItem
                                  onClick={() => onSendToNewWorktreeSession(todo.id, todo.text)}
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
    </div>
  );
};
