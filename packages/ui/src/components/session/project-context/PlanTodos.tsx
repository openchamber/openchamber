import React from 'react';

import { toast } from '@/components/ui';
import { Checkbox } from '@/components/ui/checkbox';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { resolveProjectContextId, type ProjectRef, type ProjectTodoItem } from '@/lib/projectContextApi';
import { cn } from '@/lib/utils';
import { useProjectContextStore } from '@/stores/useProjectContextStore';
import { unfinishedDependencies, withTodoCompleted } from './todoList';

const NO_TODOS: ProjectTodoItem[] = [];

/**
 * The todos an agent filed under a plan, under the plan's text. They stay in
 * the Todos list too, named by their plan there; here the plan shows what is
 * left of it. Nothing shows for a plan without todos.
 */
export const PlanTodos: React.FC<{ projectRef: ProjectRef; planId: string }> = ({ projectRef, planId }) => {
  const { t } = useI18n();
  const projectId = resolveProjectContextId(projectRef);
  const todos = useProjectContextStore((state) => state.entries[projectId]?.todos ?? NO_TODOS);
  const saveTodos = useProjectContextStore((state) => state.saveTodos);
  const [open, setOpen] = React.useState(true);

  const linked = React.useMemo(() => todos.filter((todo) => todo.planId === planId), [planId, todos]);
  const byId = React.useMemo(() => new Map(todos.map((todo) => [todo.id, todo])), [todos]);
  if (linked.length === 0) return null;
  const done = linked.filter((todo) => todo.completed).length;

  const toggle = (id: string, completed: boolean) => {
    const next = withTodoCompleted(todos, id, completed);
    if (!next) return;
    void saveTodos(projectRef, next, { kind: 'complete', id, completed }).then((saved) => {
      if (!saved) toast.error(t('rightSidebar.contextNotesTodo.toast.saveNotesFailed'));
    });
  };

  return (
    // A divider, because the block sits under a document that runs to it.
    <section className="flex-shrink-0 border-t border-edge-muted px-3 py-2">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="flex items-center gap-1 typography-meta text-muted-foreground hover:text-foreground focus-visible:outline-none"
      >
        <Icon name={open ? 'arrow-down-s' : 'arrow-right-s'} className={cn('size-3.5', !open && 'rtl:rotate-180')} />
        <span>{t('planView.todos.title')}</span>
        <span className="tabular-nums">{`${done}/${linked.length}`}</span>
      </button>
      {open ? (
        <ul className="mt-1 max-h-48 overflow-y-auto">
          {linked.map((todo) => {
            const waitingFor = todo.completed ? [] : unfinishedDependencies(todo, byId);
            const waitingLabel = waitingFor.length > 0
              ? t('rightSidebar.contextNotesTodo.todo.waitingFor', { todos: waitingFor.map((dependency) => dependency.text).join(', ') })
              : null;
            return (
              <li key={todo.id} className="flex items-start gap-2 py-0.5">
                <div className="flex h-6 items-center">
                  <Checkbox
                    checked={todo.completed}
                    onChange={(checked) => toggle(todo.id, checked)}
                    ariaLabel={t(todo.completed ? 'contextTooltips.workspace.todo.reopenAria' : 'rightSidebar.contextNotesTodo.todo.actions.markComplete', { text: todo.text })}
                  />
                </div>
                <span
                  className={cn('min-w-0 flex-1 py-0.5 typography-ui-label leading-normal break-words', todo.completed ? 'text-muted-foreground line-through' : 'text-foreground')}
                  dir="auto"
                >
                  {todo.text}
                </span>
                {waitingLabel ? (
                  <span className="flex h-6 flex-shrink-0 items-center text-muted-foreground" title={waitingLabel}>
                    <Icon name="lock" className="size-3" />
                    <span className="sr-only">{waitingLabel}</span>
                  </span>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
};
