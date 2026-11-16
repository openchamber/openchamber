import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useI18n } from '@/lib/i18n';

type ConfirmRequest = {
  title: string;
  message: string;
  action: string;
  decline?: string;
  destructive?: boolean;
};

export function useConfirmDialog() {
  const { t } = useI18n();
  const [request, setRequest] = React.useState<ConfirmRequest | null>(null);
  const pending = React.useRef<((choice: boolean) => void) | null>(null);

  React.useEffect(() => () => {
    const resolve = pending.current;
    pending.current = null;
    resolve?.(false);
  }, []);

  const settle = React.useCallback((choice: boolean) => {
    const resolve = pending.current;
    pending.current = null;
    setRequest(null);
    resolve?.(choice);
  }, []);

  const confirm = React.useCallback((next: ConfirmRequest): Promise<boolean> => {
    pending.current?.(false);
    return new Promise((resolve) => {
      pending.current = resolve;
      setRequest(next);
    });
  }, []);

  const dialog = (
    <Dialog open={request !== null} onOpenChange={(open) => { if (!open) settle(false); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{request?.title}</DialogTitle>
          <DialogDescription className="whitespace-pre-line">{request?.message}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button size="sm" variant="outline" autoFocus onClick={() => settle(false)}>{request?.decline ?? t('dialog.common.actions.cancel')}</Button>
          <Button size="sm" variant={request?.destructive ? 'destructive' : 'default'} onClick={() => settle(true)}>{request?.action}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  return { confirm, dialog };
}
