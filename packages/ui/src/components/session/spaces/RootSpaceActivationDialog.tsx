import React from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { MobileOverlayPanel } from '@/components/ui/MobileOverlayPanel';
import { useI18n } from '@/lib/i18n';
import { getRootStartConfirmation, settleRootStartConfirmation, subscribeRootStartConfirmation } from '@/lib/spaces/root-start-confirmation';
import { useSpacesStore } from '@/lib/spaces/spaces-store';
import { useUIStore } from '@/stores/useUIStore';
import { RootSpaceWarning } from './RootSpaceNotice';

export function RootSpaceActivationDialog() {
  const { t } = useI18n();
  const pending = React.useSyncExternalStore(subscribeRootStartConfirmation, getRootStartConfirmation, () => null);
  const name = useSpacesStore((state) => pending ? state.journey?.get(pending.spaceId)?.name : undefined);
  const isMobile = useUIStore((state) => state.isMobile);
  const descriptionId = React.useId();
  React.useEffect(() => () => settleRootStartConfirmation(false), []);
  const close = () => settleRootStartConfirmation(false);
  const title = t('spaces.root.badge');
  const body = <div className="space-y-3">
    {name ? <p className="typography-ui-label text-foreground" dir="auto">{name}</p> : null}
    <div id={descriptionId}><RootSpaceWarning /></div>
  </div>;
  const buttons = <div className="flex w-full justify-end gap-2">
    <Button size="sm" variant="outline" onClick={close}>{t('spaces.create.cancel')}</Button>
    <Button size="sm" variant="destructive" onClick={() => settleRootStartConfirmation(true)}>{t('spaces.root.confirm')}</Button>
  </div>;
  if (isMobile) return <MobileOverlayPanel open={pending !== null} title={title} onClose={close} footer={buttons}>
    <div className="px-3 pb-4 pt-1">{body}</div>
  </MobileOverlayPanel>;
  return <Dialog open={pending !== null} onOpenChange={(open) => { if (!open) close(); }}>
    <DialogContent className="max-w-md" aria-describedby={descriptionId}>
      <DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader>
      {body}
      <DialogFooter>{buttons}</DialogFooter>
    </DialogContent>
  </Dialog>;
}
