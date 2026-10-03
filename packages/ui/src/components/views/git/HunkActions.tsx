import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

export type HunkDiffAction = 'stage' | 'unstage' | 'discard';

export type HunkBusyState = {
  index: number;
  action: HunkDiffAction;
} | null;

interface HunkActionsProps {
  index: number;
  staged: boolean;
  busyHunk: HunkBusyState;
  disabled: boolean;
  onAction: (hunkIndex: number, action: HunkDiffAction) => void;
}

export const HunkActions = React.memo<HunkActionsProps>(function HunkActions({
  index, staged, busyHunk, disabled, onAction,
}) {
  const { t } = useI18n();
  const actions: HunkDiffAction[] = staged ? ['unstage'] : ['discard', 'stage'];
  return (
    <div className="pointer-events-none absolute right-3 z-20" style={{ top: 'var(--oc-hunk-action-offset, 0.25rem)' }} data-hunk-actions={index}>
      <div className="pointer-events-auto flex items-center gap-0.5 rounded-full border border-[var(--interactive-border)]/45 bg-[var(--surface-background)]/95 px-1 py-0.5 shadow-sm backdrop-blur-md">
        {actions.map((action) => {
          const label = t(action === 'stage' ? 'diffView.hunk.stageTitle'
            : action === 'unstage' ? 'diffView.hunk.unstageTitle' : 'diffView.hunk.discardTitle', { index: index + 1 });
          const busy = busyHunk?.index === index && busyHunk.action === action;
          return (
            <Button
              key={action}
              variant="ghost"
              size="xs"
              className={cn(
                'rounded-full bg-transparent text-muted-foreground hover:bg-transparent hover:text-foreground',
                action === 'discard' && 'text-[var(--status-error)] hover:text-[var(--status-error)]',
                action === 'stage' && 'text-[var(--status-success)] hover:text-[var(--status-success)]',
              )}
              disabled={disabled || busyHunk !== null}
              title={label}
              aria-label={label}
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                onAction(index, action);
              }}
            >
              <Icon name={busy ? 'loader-4' : action === 'stage' ? 'add' : 'arrow-go-back'}
                className={cn(action === 'stage' ? 'size-4' : 'size-3.5', busy && 'animate-spin')} />
            </Button>
          );
        })}
      </div>
    </div>
  );
});
