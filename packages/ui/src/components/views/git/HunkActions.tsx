import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';

export type HunkDiffAction = 'stage' | 'unstage' | 'discard';

export type HunkBusyState = {
  index: number;
  action: HunkDiffAction;
} | null;

interface HunkActionsProps {
  index: number;
  /** The pointer is on the hunk. */
  revealed: boolean;
  staged: boolean;
  busyHunk: HunkBusyState;
  disabled: boolean;
  onAction: (hunkIndex: number, action: HunkDiffAction) => void;
}

export const HunkActions = React.memo<HunkActionsProps>(function HunkActions({
  index, revealed, staged, busyHunk, disabled, onAction,
}) {
  const { t } = useI18n();
  const actions: HunkDiffAction[] = staged ? ['unstage'] : ['discard', 'stage'];
  return (
    // Over the end of the hunk's last line, so it shows only while the user
    // points at the hunk, at the actions themselves, or tabs to them; one
    // that is running stays. Touch screens without hover keep it shown.
    <div className="pointer-events-none absolute inset-e-3 z-20" style={{ top: 'var(--oc-hunk-action-offset, 0.25rem)' }} data-hunk-actions={index}>
      <div className={cn(
        'pointer-events-auto transition-opacity',
        !(revealed || busyHunk?.index === index) && 'opacity-0 hover:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-100',
      )}>
      <div className="flex items-center gap-0.5 rounded-full border border-[var(--interactive-border)]/45 bg-[var(--surface-background)]/95 px-1 py-0.5 shadow-sm backdrop-blur-md">
        {actions.map((action) => {
          const label = t(action === 'stage' ? 'diffView.hunk.stageTitle'
            : action === 'unstage' ? 'diffView.hunk.unstageTitle' : 'diffView.hunk.discardTitle', { index: index + 1 });
          const tooltip = t(action === 'stage' ? 'contextTooltips.diff.hunkStage'
            : action === 'unstage' ? 'contextTooltips.diff.hunkUnstage' : 'contextTooltips.diff.hunkDiscard');
          const busy = busyHunk?.index === index && busyHunk.action === action;
          return (
            <Tooltip key={action}>
              <TooltipTrigger asChild>
                <span className="inline-flex">
                  <Button
                    variant="ghost"
                    size="xs"
                    className={cn(
                      'rounded-full bg-transparent text-muted-foreground hover:bg-transparent hover:text-foreground',
                      action === 'discard' && 'text-[var(--status-error)] hover:text-[var(--status-error)]',
                      action === 'stage' && 'text-[var(--status-success)] hover:text-[var(--status-success)]',
                    )}
                    disabled={disabled || busyHunk !== null}
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
                </span>
              </TooltipTrigger>
              <TooltipContent sideOffset={6}>{tooltip}</TooltipContent>
            </Tooltip>
          );
        })}
      </div>
      </div>
    </div>
  );
});
