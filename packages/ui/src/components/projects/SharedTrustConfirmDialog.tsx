import * as React from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useI18n } from '@/lib/i18n';
import {
  getSharedTrustConfirmationSnapshot,
  settleSharedTrustConfirmation,
  subscribeSharedTrustConfirmation,
  type SharedTrustChoice,
} from '@/lib/sharedTrustConfirmation';

/**
 * App-level dialog shown the first time a team's shared setup commands or
 * shared actions (from `<repo>/.openchamber/project.json`) are about to run.
 * It lists exactly what would run. Dismissing via the close button, Escape,
 * or the backdrop counts as "run without the shared commands this time".
 */
export const SharedTrustConfirmDialog = () => {
  const { t } = useI18n();
  const request = React.useSyncExternalStore(
    subscribeSharedTrustConfirmation,
    getSharedTrustConfirmationSnapshot,
    getSharedTrustConfirmationSnapshot,
  );

  const settle = React.useCallback((choice: SharedTrustChoice) => {
    settleSharedTrustConfirmation(choice);
  }, []);

  return (
    <Dialog
      open={Boolean(request)}
      onOpenChange={(open: boolean) => {
        if (!open) {
          settle('skip');
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('projects.sharedTrust.title')}</DialogTitle>
          <DialogDescription>
            {t('projects.sharedTrust.description', { path: request?.sharedPath ?? '' })}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {request && request.setupCommands.length > 0 ? (
            <div className="space-y-1">
              <p className="typography-meta text-muted-foreground">{t('projects.sharedTrust.setupCommands')}</p>
              <div className="rounded-lg bg-[var(--surface-muted)] px-3 py-2 font-mono text-[13px] leading-relaxed break-all text-[var(--surface-foreground)]">
                {request.setupCommands.map((command, index) => (
                  <div key={`${index}-${command}`}>{command}</div>
                ))}
              </div>
            </div>
          ) : null}
          {request && request.actions.length > 0 ? (
            <div className="space-y-1">
              <p className="typography-meta text-muted-foreground">{t('projects.sharedTrust.actions')}</p>
              <div className="rounded-lg bg-[var(--surface-muted)] px-3 py-2 text-[13px] leading-relaxed break-all text-[var(--surface-foreground)]">
                {request.actions.map((action) => (
                  <div key={action.id}>
                    <span>{action.name}</span>
                    <span className="text-muted-foreground">{' — '}</span>
                    <span className="font-mono">{action.command}</span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="ghost" autoFocus onClick={() => settle('skip')}>
            {t('projects.sharedTrust.skip')}
          </Button>
          <Button variant="default" onClick={() => settle('trust')}>
            {t('projects.sharedTrust.trust')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
