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
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { isIMECompositionEvent } from '@/lib/ime';
import {
  PROJECT_TODO_TEXT_MAX_LENGTH,
  type ProjectPlanLink,
  type ProjectTodoChange,
  type ProjectTodoItem,
} from '@/lib/projectContextApi';
import { cn } from '@/lib/utils';
import { KnowledgeComposer } from './KnowledgeComposer';
import { KNOWLEDGE_ICON_BUTTON_CLASS, useKnowledgeRevealClass } from './knowledgeRowStyle';
import { KnowledgeMenu, KnowledgeRowContextMenu, type KnowledgeMenuItem } from './KnowledgeActions';
import { insertTodoBeforeCompleted, sortTodosWithCompletedLast, unfinishedDependencies, withTodoCompleted } from './todoList';

const createTodoId = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `todo_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
};

/** A todo is one line: pasted line breaks become spaces. */
const normalizeTodoText = (value: string): string => value.replace(/\r?\n/g, ' ').slice(0, PROJECT_TODO_TEXT_MAX_LENGTH);

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

/**
 * A todo's text being edited in its row. The whole text shows while editing,
 * however long; Enter or leaving the field saves, Escape puts the old text
 * back. An emptied field is a cancel: deleting is the menu's job.
 */
const TodoTextEditor: React.FC<{
  initial: string;
  label: string;
  onCommit: (text: string) => void;
  onCancel: () => void;
}> = ({ initial, label, onCommit, onCancel }) => {
  const [text, setText] = React.useState(initial);
  const fieldRef = React.useRef<HTMLTextAreaElement>(null);
  React.useLayoutEffect(() => {
    const field = fieldRef.current;
    if (!field) return;
    field.focus({ preventScroll: true });
    field.setSelectionRange(field.value.length, field.value.length);
  }, []);
  // Escape and Enter end the edit before the blur that follows them.
  const doneRef = React.useRef(false);
  const finish = (commit: boolean) => {
    if (doneRef.current) return;
    doneRef.current = true;
    const trimmed = text.trim();
    if (commit && trimmed && trimmed !== initial) onCommit(trimmed);
    else onCancel();
  };

  return (
    <textarea
      ref={fieldRef}
      rows={1}
      value={text}
      aria-label={label}
      dir="auto"
      onChange={(event) => setText(normalizeTodoText(event.target.value))}
      onKeyDown={(event) => {
        if (isIMECompositionEvent(event)) return;
        if (event.key === 'Enter') {
          event.preventDefault();
          finish(true);
        } else if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          finish(false);
        }
      }}
      onBlur={() => finish(true)}
      className="block min-h-6 w-full min-w-0 resize-none field-sizing-content bg-transparent py-0.5 typography-ui-label leading-normal text-foreground outline-none focus-visible:outline-none"
    />
  );
};

export const TodosSection: React.FC<{
  /** The project whose todos these are; the add field keeps its draft there. */
  projectPath: string;
  todos: ProjectTodoItem[];
  /** The project's plans, to name the plan a todo belongs to. */
  plans: ProjectPlanLink[];
  onOpenPlan: (planId: string) => void;
  /** Panel-wide filter. Mutations still act on the full list. */
  query: string;
  disabled: boolean;
  canCreateWorktree: boolean;
  sendingTodoId: string | null;
  /**
   * Shows `next` and persists it through the container's store write: one
   * todo when `change` names it, otherwise the whole list.
   */
  onPersistTodos: (next: ProjectTodoItem[], change?: ProjectTodoChange) => void;
  onSendToCurrentSession: (todoText: string) => void;
  onSendToNewSession: (todoId: string, todoText: string) => void;
  onSendToNewWorktreeSession: (todoId: string, todoText: string) => void;
}> = ({
  projectPath,
  todos,
  plans,
  onOpenPlan,
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
  const [editingTodoId, setEditingTodoId] = React.useState<string | null>(null);
  const reveal = useKnowledgeRevealClass();

  // Shown at once and persisted by the container, which reports a failure.
  const handleAddTodo = React.useCallback((trimmed: string) => {
    const id = createTodoId();
    const text = trimmed.slice(0, PROJECT_TODO_TEXT_MAX_LENGTH);
    onPersistTodos(insertTodoBeforeCompleted(todos, {
      id,
      text,
      completed: false,
      createdAt: Date.now(),
    }), { kind: 'create', id, text });
    return true;
  }, [onPersistTodos, todos]);

  const handleEditTodo = React.useCallback((id: string, text: string) => {
    setEditingTodoId(null);
    if (!todos.some((todo) => todo.id === id)) return;
    onPersistTodos(todos.map((todo) => (todo.id === id ? { ...todo, text } : todo)), { kind: 'edit', id, text });
  }, [onPersistTodos, todos]);

  const handleToggleTodo = React.useCallback(
    (id: string, completed: boolean) => {
      const next = withTodoCompleted(todos, id, completed);
      if (next) onPersistTodos(next, { kind: 'complete', id, completed });
    },
    [onPersistTodos, todos]
  );

  const handleDeleteTodo = React.useCallback(
    (id: string) => {
      onPersistTodos(todos.filter((todo) => todo.id !== id), { kind: 'delete', id });
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

  const planTitles = React.useMemo(() => new Map(plans.map((plan) => [plan.id, plan.title])), [plans]);
  const todosById = React.useMemo(() => new Map(todos.map((todo) => [todo.id, todo])), [todos]);
  // Filtering is display-only: every handler above still edits the full list,
  // so reordering or clearing while a filter is active cannot drop hidden items.
  const visibleTodos = React.useMemo(
    () => todos.filter((todo) => matchesRankQuery([todo.text], query)),
    [query, todos],
  );

  return (
    <div className="space-y-2">
      <KnowledgeComposer
        placeholder={t('rightSidebar.contextNotesTodo.todo.inputPlaceholder')}
        addLabel={t('rightSidebar.contextNotesTodo.todo.addAria')}
        maxLength={PROJECT_TODO_TEXT_MAX_LENGTH}
        projectPath={projectPath}
        draftKind="todo"
        disabled={disabled}
        onSubmit={handleAddTodo}
      />

      {visibleTodos.length === 0 ? (
        <p className="px-1 typography-meta text-muted-foreground">
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
            <ul className="flex flex-col">
              {visibleTodos.map((todo) => {
                const editing = editingTodoId === todo.id;
                const planId = todo.planId;
                const planTitle = planId ? planTitles.get(planId) : undefined;
                const waitingFor = unfinishedDependencies(todo, todosById);
                const menuItems: KnowledgeMenuItem[] = [
                  {
                    id: 'edit',
                    label: t('rightSidebar.contextNotesTodo.todo.menu.edit'),
                    onSelect: () => setEditingTodoId(todo.id),
                  },
                  ...(todo.completed ? [{
                    id: 'clear-completed',
                    label: t('rightSidebar.contextNotesTodo.todo.clearCompleted'),
                    disabled,
                    onSelect: handleClearCompletedTodos,
                  }] : []),
                  {
                    id: 'delete',
                    label: t('rightSidebar.contextNotesTodo.todo.menu.delete'),
                    destructive: true,
                    onSelect: () => handleDeleteTodo(todo.id),
                  },
                ];
                return (
                  <SortableTodoItem key={todo.id} id={todo.id}>
                    {(dragHandleProps) => (
                      <KnowledgeRowContextMenu
                        items={menuItems}
                        // The field's own menu (spelling, paste) while editing.
                        disabled={editing}
                        // Centred on one line; a field being edited can grow, so it
                        // aligns the row to its first line instead.
                        render={<div className={cn('group/knowledge flex gap-1.5 rounded-md px-1 py-1', editing ? 'items-start' : 'items-center')} />}
                      >
                        <button
                          type="button"
                          ref={dragHandleProps.setActivatorNodeRef}
                          {...dragHandleProps.attributes}
                          {...dragHandleProps.listeners}
                          onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                          }}
                          className={cn('flex h-6 w-4 flex-shrink-0 touch-none items-center justify-center text-muted-foreground hover:text-foreground', reveal)}
                          aria-label={t('rightSidebar.contextNotesTodo.todo.actions.reorder', { text: todo.text })}
                          data-row-tooltip={t('contextTooltips.workspace.todo.reorder')}
                        >
                          <Icon name="draggable" className="h-3.5 w-3.5" />
                        </button>
                        <div
                          className="flex h-6 items-center"
                          data-row-tooltip={t(todo.completed ? 'contextTooltips.workspace.todo.reopen' : 'contextTooltips.workspace.todo.complete')}
                        >
                          <Checkbox
                            checked={todo.completed}
                            onChange={(checked) => handleToggleTodo(todo.id, checked)}
                            ariaLabel={t(todo.completed ? 'contextTooltips.workspace.todo.reopenAria' : 'rightSidebar.contextNotesTodo.todo.actions.markComplete', { text: todo.text })}
                          />
                        </div>
                        {editing ? (
                          <div className="min-w-0 flex-1">
                            <TodoTextEditor
                              initial={todo.text}
                              label={t('rightSidebar.contextNotesTodo.todo.actions.editAria', { text: todo.text })}
                              onCommit={(text) => handleEditTodo(todo.id, text)}
                              onCancel={() => setEditingTodoId(null)}
                            />
                          </div>
                        ) : (
                          <div className="flex min-h-6 min-w-0 flex-1 items-center gap-2">
                            {/* A click edits: the text is what the user came to change. */}
                            <button
                              type="button"
                              onClick={() => setEditingTodoId(todo.id)}
                              className={cn(
                                'min-w-0 shrink cursor-text truncate bg-transparent p-0 text-start typography-ui-label leading-normal focus-visible:outline-none',
                                todo.completed ? 'text-muted-foreground line-through' : 'text-foreground',
                              )}
                              title={todo.text}
                              aria-label={t('rightSidebar.contextNotesTodo.todo.actions.editAria', { text: todo.text })}
                              dir="auto"
                            >
                              {todo.text}
                            </button>
                            {waitingFor.length > 0 && !todo.completed ? (
                              <span
                                className="inline-flex flex-shrink-0 text-muted-foreground"
                                data-row-tooltip={t('rightSidebar.contextNotesTodo.todo.waitingFor', { todos: waitingFor.map((dependency) => dependency.text).join(', ') })}
                              >
                                <Icon name="lock" className="size-3" />
                                <span className="sr-only">
                                  {t('rightSidebar.contextNotesTodo.todo.waitingFor', { todos: waitingFor.map((dependency) => dependency.text).join(', ') })}
                                </span>
                              </span>
                            ) : null}
                            {planTitle && planId ? (
                              <button
                                type="button"
                                onClick={() => onOpenPlan(planId)}
                                // Gives way to the todo's own text first.
                                className="ms-auto min-w-12 max-w-[40%] shrink-[4] truncate typography-micro text-muted-foreground hover:text-foreground focus-visible:outline-none"
                                data-row-tooltip={t('rightSidebar.contextNotesTodo.todo.openPlan')}
                                dir="auto"
                              >
                                {planTitle}
                              </button>
                            ) : null}
                          </div>
                        )}
                        <div className="-me-1 flex h-6 items-center gap-0.5">
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <button
                                type="button"
                                disabled={sendingTodoId === todo.id}
                                className={cn(KNOWLEDGE_ICON_BUTTON_CLASS, reveal)}
                                aria-label={t('rightSidebar.contextNotesTodo.todo.actions.send', { text: todo.text })}
                                data-row-tooltip={t('contextTooltips.workspace.todo.send')}
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
                          <KnowledgeMenu items={menuItems} />
                        </div>
                      </KnowledgeRowContextMenu>
                    )}
                  </SortableTodoItem>
                );
              })}
            </ul>
          </SortableContext>
        </DndContext>
      )}
    </div>
  );
};
