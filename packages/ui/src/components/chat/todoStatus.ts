import type { IconName } from '@/components/icon/icons';
import type { TodoItem } from '@/lib/opencode/tools';

export const TODO_STATUS_ICON = {
  in_progress: { name: 'record-circle', color: 'var(--status-info)' },
  completed: { name: 'checkbox-circle', color: 'var(--status-success)' },
  pending: { name: 'time', color: undefined },
  cancelled: { name: 'close-circle', color: undefined },
} satisfies Record<TodoItem['status'], { name: IconName; color: string | undefined }>;
