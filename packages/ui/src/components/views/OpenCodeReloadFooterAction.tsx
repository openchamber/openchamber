import * as React from 'react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { applyPendingOpenCodeRestart } from '@/lib/opencode/deferredRestart';
import { cn } from '@/lib/utils';
import { reloadOpenCodeConfiguration } from '@/stores/useAgentsStore';
import {
  selectPendingOpenCodeRestartCount,
  usePendingOpenCodeRestartStore,
} from '@/stores/usePendingOpenCodeRestartStore';
import { useUIStore } from '@/stores/useUIStore';

type OpenCodeReloadFooterActionProps = {
  className?: string;
};

export const OpenCodeReloadFooterAction: React.FC<OpenCodeReloadFooterActionProps> = ({
  className,
}) => {
  const { t } = useI18n();
  const pendingCount = usePendingOpenCodeRestartStore(selectPendingOpenCodeRestartCount);
  const isApplying = usePendingOpenCodeRestartStore((state) => state.isApplying);
  const showRestartConfirm = useUIStore((state) => state.showOpenCodeRestartConfirm);
  const setShowOpenCodeRestartConfirm = useUIStore((state) => state.setShowOpenCodeRestartConfirm);
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [dontShowAgain, setDontShowAgain] = React.useState(false);

  const hasPending = pendingCount > 0;

  const runApply = React.useCallback(async () => {
    try {
      const result = await applyPendingOpenCodeRestart({
        message: t('settings.view.pendingRestart.applying'),
      });
      if (result.requiresManualRestart) {
        toast.warning(t('settings.view.pendingRestart.manualRestartRequired'));
        return;
      }
      if (result.ok) {
        toast.success(t('settings.view.pendingRestart.applied'));
      }
    } catch (error) {
      const message = error instanceof Error && error.message
        ? error.message
        : t('settings.view.pendingRestart.applyFailed');
      toast.error(message);
    }
  }, [t]);

  const runManualReload = React.useCallback(async () => {
    try {
      await reloadOpenCodeConfiguration({
        message: t('settings.view.pendingRestart.applying'),
        mode: 'projects',
        scopes: ['all'],
      });
      usePendingOpenCodeRestartStore.getState().clear();
    } catch {
      // ignore
    }
  }, [t]);

  const handleConfirmApply = React.useCallback(() => {
    if (dontShowAgain) {
      setShowOpenCodeRestartConfirm(false);
    }
    setConfirmOpen(false);
    setDontShowAgain(false);
    void runApply();
  }, [dontShowAgain, runApply, setShowOpenCodeRestartConfirm]);

  const handleClick = React.useCallback(() => {
    if (!hasPending) {
      void runManualReload();
      return;
    }
    if (showRestartConfirm) {
      setDontShowAgain(false);
      setConfirmOpen(true);
      return;
    }
    void runApply();
  }, [hasPending, runApply, runManualReload, showRestartConfirm]);

  const label = !hasPending
    ? t('settings.view.actions.reloadOpenCode')
    : isApplying
      ? t('settings.view.pendingRestart.applying')
      : t('settings.view.actions.applyAndRestartOpenCode');

  const tooltip = !hasPending
    ? t('settings.view.actions.reloadOpenCodeTooltip')
    : pendingCount === 1
      ? t('settings.view.actions.applyAndRestartOpenCodeTooltipSingle')
      : t('settings.view.actions.applyAndRestartOpenCodeTooltipPlural', { count: pendingCount });

  return (
    <>
      <button
        type="button"
        disabled={isApplying}
        title={tooltip}
        aria-label={tooltip}
        onClick={handleClick}
        className={cn(
          'flex w-full items-center gap-2 rounded-md overflow-hidden whitespace-nowrap',
          'h-11 px-3 sm:h-8 sm:px-2',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
          hasPending
            ? 'bg-primary text-primary-foreground typography-ui-label font-semibold hover:bg-primary/90'
            : 'text-sm font-semibold text-sidebar-foreground/90 hover:text-sidebar-foreground hover:bg-interactive-hover',
          isApplying && 'opacity-80',
          className,
        )}
      >
        {hasPending ? (
          <span
            className={cn(
              'inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full px-1.5',
              'bg-background text-foreground typography-micro font-semibold tabular-nums',
            )}
            aria-hidden="true"
          >
            {pendingCount}
          </span>
        ) : (
          <Icon name="restart" className="h-4 w-4 shrink-0" />
        )}
        <span className="truncate">{label}</span>
      </button>

      <Dialog
        open={confirmOpen}
        onOpenChange={(open) => {
          setConfirmOpen(open);
          if (!open) {
            setDontShowAgain(false);
          }
        }}
      >
        <DialogContent showCloseButton={false} className="max-w-md gap-5">
          <DialogHeader>
            <DialogTitle>{t('settings.view.pendingRestart.confirm.title')}</DialogTitle>
            <DialogDescription>
              {t('settings.view.pendingRestart.confirm.description')}
            </DialogDescription>
          </DialogHeader>
          {/* Plain stack — avoid DialogFooter (sm:flex-row) fighting this layout */}
          <div className="flex w-full flex-col items-center gap-3">
            <div className="flex w-full items-stretch justify-center gap-3">
              <div className="min-w-0 shrink-0" style={{ width: '40%' }}>
                <Button
                  type="button"
                  variant="outline"
                  className="h-9 w-full normal-case"
                  onClick={() => setConfirmOpen(false)}
                >
                  {t('settings.view.pendingRestart.confirm.cancel')}
                </Button>
              </div>
              <div className="min-w-0 shrink-0" style={{ width: '40%' }}>
                <Button
                  type="button"
                  variant="default"
                  className="h-9 w-full normal-case"
                  onClick={handleConfirmApply}
                >
                  {t('settings.view.actions.applyAndRestartOpenCode')}
                </Button>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setDontShowAgain((value) => !value)}
              className="inline-flex items-center justify-center gap-1.5 typography-ui-label text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/50"
              aria-pressed={dontShowAgain}
            >
              {dontShowAgain
                ? <Icon name="checkbox" className="h-4 w-4 text-primary" />
                : <Icon name="checkbox-blank" className="h-4 w-4" />}
              {t('settings.view.pendingRestart.confirm.dontShowAgain')}
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
};
