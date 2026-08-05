import React from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import type { WorktreeCommandResult } from '@/lib/api/types';
import { useI18n } from '@/lib/i18n';

interface WorktreeCommandDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Dialog title, e.g. "Start commands — dev-feature". */
  title: string;
  /** The command line that was run (shown verbatim when present). */
  command?: string;
  /** True while the command is executing on the server. */
  running: boolean;
  /** Result of the run (setup log or start/shutdown command output). */
  result: WorktreeCommandResult | null;
}

/**
 * Dialog that shows the output of a worktree script run: the setup commands
 * captured during worktree bootstrap, or the on-demand start/shutdown command
 * output. The dialog itself is dumb — the caller owns fetching.
 */
export const WorktreeCommandDialog: React.FC<WorktreeCommandDialogProps> = ({
  open,
  onOpenChange,
  title,
  command,
  running,
  result,
}) => {
  const { t } = useI18n();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl w-[calc(100vw-2rem)]">
        <div className="flex flex-col gap-3 overflow-hidden">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {command ? (
              <DialogDescription className="font-mono text-xs break-words">
                {command}
              </DialogDescription>
            ) : null}
          </DialogHeader>

          <div className="bg-[var(--surface-elevated)] rounded-lg p-3 min-h-[12rem] max-h-[26rem] overflow-y-auto overflow-x-hidden">
            {running ? (
              <div className="flex items-center gap-2 py-2 text-muted-foreground typography-meta">
                <Icon name="loader-4" className="size-4 animate-spin" />
                {t('settings.openchamber.worktrees.commands.dialogRunning')}
              </div>
            ) : result ? (
              <>
                {result.timedOut ? (
                  <p className="typography-meta mb-2 text-[var(--status-warning)]">
                    {t('settings.openchamber.worktrees.commands.dialogTimedOut')}
                  </p>
                ) : null}
                {!result.success ? (
                  <p className="typography-meta mb-2 text-[var(--status-error)]">
                    {t('settings.openchamber.worktrees.commands.dialogFailed')}
                  </p>
                ) : null}
                <pre className="typography-micro text-foreground/90 font-mono whitespace-pre-wrap break-words">
                  {result.output.trim().length > 0
                    ? result.output
                    : t('settings.openchamber.worktrees.commands.dialogEmptyOutput')}
                </pre>
              </>
            ) : null}
          </div>

          <div className="flex justify-end">
            <Button type="button" variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              {t('settings.openchamber.worktrees.commands.dialogClose')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};
