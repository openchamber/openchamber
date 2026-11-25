import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { cn } from '@/lib/utils';

interface ScheduledTaskNoteProps {
  message: string;
  tone: 'warning' | 'error';
  dimmed: boolean;
}

export const ScheduledTaskNote: React.FC<ScheduledTaskNoteProps> = ({ message, tone, dimmed }) => (
  <div
    className={cn('mt-3 flex items-start gap-2 rounded-md border p-2 typography-micro', dimmed && 'opacity-60')}
    style={{
      color: `var(--status-${tone})`,
      backgroundColor: `var(--status-${tone}-background)`,
      borderColor: `var(--status-${tone}-border)`,
    }}
  >
    <Icon name={tone === 'warning' ? 'time' : 'error-warning'} className="mt-0.5 h-3.5 w-3.5 shrink-0" />
    <span className="min-w-0 break-words">{message}</span>
  </div>
);
