import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useI18n } from '@/lib/i18n';

type ConfirmRequest = {
  title: string;
  message: string;
  action: string;
  /** Label for declining, when declining still goes on without the action; defaults to Cancel. */
  decline?: string;
  /** The action discards something; its button reads as destructive. */
  destructive?: boolean;
};

/**
 * A yes-or-no question asked in the product's own dialog.
 *
 * Native `window.confirm` sits outside the page's focus tree: on Windows it can
 * leave Electron's renderer unable to accept text, and in a webview it does
 * not open at all. `confirm` resolves `true` for the action, `false` for cancel
 * or dismissal, and `false` when the owner unmounts while the question is
 * open, so a caller never waits on an answer nobody can give.
 */
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
    // A second question while one is open answers the first with "no" first.
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
