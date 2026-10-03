import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useI18n, type I18nKey } from '@/lib/i18n';

type Confirmation = {
  messageKey: I18nKey;
  actionKey: I18nKey;
};

// Native window.confirm can leave Electron's Windows renderer unable to accept
// text input. Keep SSH confirmations in the page's existing dialog focus tree.
export function useSshConfirmation(instanceId: string | null) {
  const { t } = useI18n();
  const [request, setRequest] = React.useState<Confirmation | null>(null);
  const pending = React.useRef<((choice: boolean | null) => void) | null>(null);
  const activeInstance = React.useRef<string | null>(null);

  React.useEffect(() => {
    activeInstance.current = instanceId;
    setRequest(null);
    return () => {
      activeInstance.current = null;
      const resolve = pending.current;
      pending.current = null;
      // Leaving the form abandons the operation, rather than treating it as a
      // decision to save a password without persistence.
      resolve?.(null);
    };
  }, [instanceId]);

  const confirm = React.useCallback((
    messageKey: I18nKey,
    actionKey: I18nKey = 'settings.common.actions.saveChanges',
  ): Promise<boolean | null> => {
    if (!instanceId || activeInstance.current !== instanceId || pending.current) {
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      pending.current = resolve;
      setRequest({ messageKey, actionKey });
    });
  }, [instanceId]);

  const settle = React.useCallback((choice: boolean) => {
    const resolve = pending.current;
    pending.current = null;
    setRequest(null);
    resolve?.(choice);
  }, []);

  const dialog = (
    <Dialog open={request !== null} onOpenChange={(open) => { if (!open) settle(false); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('settings.remoteInstances.page.title')}</DialogTitle>
          <DialogDescription>{request ? t(request.messageKey) : null}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" autoFocus onClick={() => settle(false)}>
            {t('settings.common.actions.cancel')}
          </Button>
          <Button onClick={() => settle(true)}>
            {request ? t(request.actionKey) : null}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  return { confirm, dialog };
}
