import React from 'react';
import { Icon } from '@/components/icon/Icon';
import type { IconName } from '@/components/icon/icons';
import { useI18n } from '@/lib/i18n';
import { LANE_STATUS_LABEL_KEYS, type LaneStatus } from '@/lib/multirun/laneStatus';
import { cn } from '@/lib/utils';

// Blocked states reuse the sidebar's glyphs and colors, so a lane waiting on
// the user reads the same here as its row does there. A plain finish stays
// grey: it only means the turn ended, not that the work is good.
const STATUS_ICON = {
  permission: { name: 'shield', className: 'text-destructive' },
  question: { name: 'question', className: 'text-status-info' },
  working: { name: 'loader-4', className: 'animate-spin text-[var(--status-warning)]' },
  failed: { name: 'error-warning', className: 'text-[var(--status-error)]' },
  stopped: { name: 'stop', className: 'text-muted-foreground' },
  notStarted: { name: 'time', className: 'text-muted-foreground' },
  noReply: { name: 'alert', className: 'text-[var(--status-warning)]' },
  finished: { name: 'checkbox-circle', className: 'text-muted-foreground' },
} satisfies Record<LaneStatus, { name: IconName; className: string }>;

export function LaneStatusIcon({ status, className }: { status: LaneStatus; className?: string }): React.ReactNode {
  const { t } = useI18n();
  const icon = STATUS_ICON[status];
  const label = t(LANE_STATUS_LABEL_KEYS[status]);
  return (
    <span className="inline-flex shrink-0" title={label}>
      <Icon name={icon.name} className={cn('size-3.5', icon.className, className)} aria-label={label} />
    </span>
  );
}
