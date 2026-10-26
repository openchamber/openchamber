import React from 'react';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui';
import { useConfirmDialog } from '@/components/ui/confirm-dialog';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import type { ClientAuthAPI } from '@/lib/api/types';

// The relay status is read only for this notice, so it polls slowly: the
// server reports a conflict after two evictions within ten minutes.
const STATUS_POLL_MS = 30_000;

/**
 * Shown while another copy of this server's data, usually on a second
 * computer, keeps taking the relay slot, so devices added for "Anywhere" land
 * on either computer. Offers to give this computer its own relay identity.
 */
export function RelayConflictNotice({ clientAuth }: { clientAuth: ClientAuthAPI }) {
  const { t } = useI18n();
  const { confirm, dialog } = useConfirmDialog();
  const [conflict, setConflict] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    const load = () => {
      // A failed read keeps the last known state.
      clientAuth.getRelayHostStatus()
        .then((status) => { if (!cancelled) setConflict(status.identityConflict); })
        .catch(() => {});
    };
    load();
    const timer = window.setInterval(load, STATUS_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [clientAuth]);

  const separate = async () => {
    const confirmed = await confirm({
      title: t('settings.remoteInstances.clientAuth.relayConflict.confirmTitle'),
      message: t('settings.remoteInstances.clientAuth.relayConflict.confirmMessage'),
      action: t('settings.remoteInstances.clientAuth.relayConflict.confirmAction'),
    });
    if (!confirmed) return;
    setBusy(true);
    try {
      const status = await clientAuth.resetRelayIdentity();
      setConflict(status.identityConflict);
      toast.success(t('settings.remoteInstances.clientAuth.relayConflict.toast.success'));
    } catch {
      toast.error(t('settings.remoteInstances.clientAuth.relayConflict.toast.failed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {conflict ? (
        <div className="flex max-w-[40rem] items-start gap-3 rounded-lg bg-[var(--status-warning)]/10 p-3">
          <Icon name="error-warning" className="mt-0.5 size-4 shrink-0 text-[var(--status-warning)]" />
          <div className="min-w-0 flex-1 space-y-1">
            <p className="typography-ui-label text-foreground">{t('settings.remoteInstances.clientAuth.relayConflict.title')}</p>
            <p className="typography-meta text-muted-foreground">{t('settings.remoteInstances.clientAuth.relayConflict.description')}</p>
            <Button type="button" size="xs" variant="outline" className="mt-1.5" disabled={busy} onClick={() => void separate()}>
              {t('settings.remoteInstances.clientAuth.relayConflict.action')}
            </Button>
          </div>
        </div>
      ) : null}
      {dialog}
    </>
  );
}
