import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { useSessionTodos, type SessionTodo } from '@/stores/useSessionTodosStore';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { TODO_STATUS_ICON } from '../todoStatus';
import { WorkStatusCollapsibleSection, WorkStatusRow } from './WorkStatusPrimitives';
import { useReportWorkStatusPresence } from './presenceContext';

type Props = {
  sessionId: string | null;
};

/**
 * Work first, then what is waiting, then what is done: the panel is read
 * top-down for "what is happening", and a finished item never answers that.
 * Completed items stay, since this is a record of the session.
 */
const STATUS_RANK = {
  in_progress: 0,
  pending: 1,
  completed: 2,
  cancelled: 3,
} satisfies Record<SessionTodo['status'], number>;

const TaskRow: React.FC<{ todo: SessionTodo }> = ({ todo }) => {
  const done = todo.status === 'completed';
  const icon = TODO_STATUS_ICON[todo.status];
  return (
    <WorkStatusRow
      leading={<Icon name={icon.name} className="size-3.5 shrink-0" style={icon.color ? { color: icon.color } : undefined} />}
      muted={done}
      label={<span className={done ? 'line-through' : undefined}>{todo.content}</span>}
      labelDir="auto"
      tooltip={todo.content}
    />
  );
};

/**
 * The agent's todo list for this session (OpenCode's experimental `todowrite`
 * tool), read by the server. Listed only where the tool is on
 * (`useUnavailableWorkStatusSections`); empty, it renders nothing.
 */
export const WorkStatusTasksSection: React.FC<Props> = ({ sessionId }) => {
  const { t } = useI18n();
  const todos = useSessionTodos(sessionId);

  const visibleTodos = React.useMemo(() => todos
    .map((todo, index) => ({ todo, index }))
    .filter(({ todo }) => todo.status !== 'cancelled')
    // Stable within a rank: the agent's own order carries meaning.
    .sort((left, right) => (STATUS_RANK[left.todo.status] - STATUS_RANK[right.todo.status]) || left.index - right.index)
    .map(({ todo }) => todo), [todos]);

  useReportWorkStatusPresence('tasks', visibleTodos.length > 0);
  if (visibleTodos.length === 0) return null;

  const doneCount = visibleTodos.filter((todo) => todo.status === 'completed').length;
  const activeTodo = visibleTodos.find((todo) => todo.status === 'in_progress');

  return (
    <WorkStatusCollapsibleSection
      id="tasks"
      title={t('chat.workStatus.section.tasks')}
      icon="list-check-2"
      summary={`${doneCount}/${visibleTodos.length}`}
      defaultExpanded
      collapsedContent={activeTodo ? <TaskRow todo={activeTodo} /> : null}
    >
      <ScrollableOverlay outerClassName="max-h-72" disableHorizontal>
        {visibleTodos.map((todo, index) => (
          <TaskRow key={`${index}-${todo.content}`} todo={todo} />
        ))}
      </ScrollableOverlay>
    </WorkStatusCollapsibleSection>
  );
};
