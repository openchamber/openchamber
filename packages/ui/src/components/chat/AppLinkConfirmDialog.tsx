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
import { getUrlScheme } from '@/lib/url';

import {
  getAppLinkConfirmationSnapshot,
  settleAppLinkConfirmation,
  subscribeAppLinkConfirmation,
  type AppLinkConfirmationChoice,
} from './appLinkConfirmation';

/**
 * App-level dialog confirming application deep links (obsidian://, vscode://,
 * ...) rendered in chat markdown before the OS is asked to open them.
 * Dismissing via the close button, Escape, or the backdrop cancels the open.
 */
export const AppLinkConfirmDialog = () => {
  const { t } = useI18n();
  const request = React.useSyncExternalStore(
    subscribeAppLinkConfirmation,
    getAppLinkConfirmationSnapshot,
    getAppLinkConfirmationSnapshot,
  );

  const url = request?.url ?? '';
  const scheme = getUrlScheme(url) ?? '';

  const settle = React.useCallback((choice: AppLinkConfirmationChoice) => {
    settleAppLinkConfirmation(choice);
  }, []);

  return (
    <Dialog
      open={Boolean(request)}
      onOpenChange={(open: boolean) => {
        if (!open) {
          settle('cancel');
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('chat.appLink.confirm.title')}</DialogTitle>
          <DialogDescription>
            {scheme
              ? t('chat.appLink.confirm.description', { scheme: `${scheme}://` })
              : t('chat.appLink.confirm.descriptionPlain')}
          </DialogDescription>
        </DialogHeader>
        <div className="rounded-lg bg-[var(--surface-muted)] px-3 py-2 text-[13px] leading-relaxed break-all text-[var(--surface-foreground)]">
          {url}
        </div>
        <DialogFooter>
          <Button variant="ghost" autoFocus onClick={() => settle('cancel')}>
            {t('chat.appLink.confirm.cancel')}
          </Button>
          <Button variant="outline" onClick={() => settle('trust')}>
            {t('chat.appLink.confirm.trustAndOpen')}
          </Button>
          <Button variant="default" onClick={() => settle('open')}>
            {t('chat.appLink.confirm.open')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
