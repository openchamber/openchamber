import type { IconName } from '@/components/icon/icons';
import type { TodoItem } from '@/lib/opencode/tools';

/**
 * How a todo's status looks wherever the agent's list is drawn: the Tasks
 * section of Work Status and the `todowrite` row in the chat. The icons are
 * the ones the Subagents rows use for the same states.
 */
export const TODO_STATUS_ICON = {
  in_progress: { name: 'record-circle', color: 'var(--status-info)' },
  completed: { name: 'checkbox-circle', color: 'var(--status-success)' },
  pending: { name: 'time', color: undefined },
  cancelled: { name: 'close-circle', color: undefined },
} satisfies Record<TodoItem['status'], { name: IconName; color: string | undefined }>;
