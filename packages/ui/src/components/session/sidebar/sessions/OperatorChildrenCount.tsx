import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { isOperatorChildSession } from '@/lib/sessionOperatorChild';
import { cn } from '@/lib/utils';
import { hasActiveSubagent, useGlobalSessionStatusStore } from '@/sync/global-session-status';
import type { SessionNode } from '../types';
import { RowMarkTooltip } from './RowMarkTooltip';

const NO_IDS: readonly string[] = [];

const useOperatorChildIds = (children: readonly SessionNode[]): readonly string[] => React.useMemo(() => {
  const ids = children.filter((child) => isOperatorChildSession(child.session)).map((child) => child.session.id);
  return ids.length > 0 ? ids : NO_IDS;
}, [children]);

export function OperatorChildrenCount({ childNodes, className }: { childNodes: readonly SessionNode[]; className?: string }): React.ReactNode {
  const { t } = useI18n();
  const ids = useOperatorChildIds(childNodes);
  const running = useGlobalSessionStatusStore((state) => ids.filter((id) => (
    state.activeSessionIds.has(id) || hasActiveSubagent(id, state.activeSessionIds)
  )).length);
  if (ids.length === 0) return null;
  const finished = ids.length - running;
  const label = t('sessions.sidebar.session.operatorChildren.count', { running, finished });
  return (
    <RowMarkTooltip label={label}>
      <span
        className={cn('inline-flex flex-shrink-0 items-center gap-1.5 typography-micro tabular-nums leading-none text-muted-foreground', className)}
        aria-label={label}
        data-operator-children-running={running}
        data-operator-children-finished={finished}
      >
        {running > 0 ? <span className="inline-flex items-center gap-0.5"><Icon name="loader-4" className="h-3 w-3" />{running}</span> : null}
        {finished > 0 ? <span className="inline-flex items-center gap-0.5"><Icon name="check" className="h-3 w-3" />{finished}</span> : null}
      </span>
    </RowMarkTooltip>
  );
}
