import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useDirectorySync } from '@/sync/sync-context';
import { useTodosPersistStore } from '@/stores/useTodosPersistStore';
import { WorkStatusRow, WorkStatusSection } from './WorkStatusPrimitives';
import { useReportWorkStatusPresence } from './presenceContext';
import type { State } from '@/sync/types';
import type { Todo } from '@opencode-ai/sdk/v2';

type Props = {
  sessionId: string | null;
  directory: string | null;
};

const EMPTY_TODOS: Todo[] = [];

/**
 * Work first, then what is waiting, then what is done — the panel is read
 * top-down for "what is happening", and a finished item never answers that.
 * Unlike the composer's dropdown, completed items stay: this is a record of the
 * session, not a queue to work through.
 */
const STATUS_RANK: Record<string, number> = {
  in_progress: 0,
  pending: 1,
  completed: 2,
};

/** Same icons the composer's todo dropdown uses, so one list does not read as two. */
const statusIcon = (status: string): { name: 'record-circle' | 'checkbox-circle' | 'time'; color?: string } => {
  if (status === 'in_progress') return { name: 'record-circle', color: 'var(--status-info)' };
  if (status === 'completed') return { name: 'checkbox-circle', color: 'var(--status-success)' };
  return { name: 'time' };
};

export const WorkStatusTasksSection: React.FC<Props> = ({ sessionId, directory }) => {
  const { t } = useI18n();

  const liveTodos = useDirectorySync(
    React.useCallback(
      (state: State) => (sessionId ? state.todo[sessionId] ?? EMPTY_TODOS : EMPTY_TODOS),
      [sessionId],
    ),
  );
  const persistedTodos = useTodosPersistStore(
    React.useCallback(
      (state) => (sessionId && directory ? state.getSessionTodos(directory, sessionId) : undefined),
      [directory, sessionId],
    ),
  );
  // Live channel wins; persistence only restores context for a session whose
  // todo events predate this client's connection.
  const todos = liveTodos.length > 0 ? liveTodos : persistedTodos ?? EMPTY_TODOS;

  const visibleTodos = React.useMemo(() => {
    const kept = todos
      .map((todo, index) => ({ todo, index }))
      .filter(({ todo }) => todo.status !== 'cancelled');
    // Stable within a rank: the agent's own ordering carries meaning, so only
    // the status grouping is imposed on top of it.
    return kept
      .sort((left, right) => {
        const rank = (STATUS_RANK[left.todo.status] ?? 1) - (STATUS_RANK[right.todo.status] ?? 1);
        return rank !== 0 ? rank : left.index - right.index;
      })
      .map(({ todo }) => todo);
  }, [todos]);

  useReportWorkStatusPresence('tasks', visibleTodos.length > 0);

  if (visibleTodos.length === 0) return null;

  const doneCount = visibleTodos.filter((todo) => todo.status === 'completed').length;

  return (
    <WorkStatusSection
      title={t('chat.workStatus.section.tasks')}
      summary={`${doneCount}/${visibleTodos.length}`}
    >
      {visibleTodos.map((todo, index) => {
        const done = todo.status === 'completed';
        const icon = statusIcon(todo.status);
        return (
          <Tooltip key={`${todo.status}-${index}-${todo.content}`} delayDuration={600}>
            <TooltipTrigger asChild>
              <div>
                <WorkStatusRow
                  leading={(
                    <Icon
                      name={icon.name}
                      className="size-3.5 shrink-0"
                      style={icon.color ? { color: icon.color } : undefined}
                    />
                  )}
                  muted={done}
                  label={<span className={done ? 'line-through' : undefined}>{todo.content}</span>}
                />
              </div>
            </TooltipTrigger>
            {/* Rows truncate at this width; the tooltip is the only way to read
                a long task in full. */}
            <TooltipContent side="left" className="max-w-[320px]">
              {todo.content}
            </TooltipContent>
          </Tooltip>
        );
      })}
    </WorkStatusSection>
  );
};
