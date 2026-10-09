import React from 'react';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { UpdateDialog } from '@/components/ui/UpdateDialog';
import type { UpdateInfo } from '@/lib/desktop';
import { useI18n } from '@/lib/i18n';
import { checkConnectedServerForUpdates } from '@/stores/useUpdateStore';

type UpdateOffer =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'available'; info: UpdateInfo }
  | { kind: 'manual'; info: UpdateInfo | null; error: string | null };

/**
 * The connected server runs an OpenChamber this app cannot use. Offers the
 * server's own update through its update route, over the transport the app
 * already uses for it, so a relay or tunnel host can be updated from here too.
 * A server that cannot update itself gets the command to run on it.
 */
export function OutdatedServerNotice({ version }: { version: string }) {
  const { t } = useI18n();
  const [offer, setOffer] = React.useState<UpdateOffer>({ kind: 'idle' });

  const checkServer = async () => {
    setOffer({ kind: 'checking' });
    try {
      const info = await checkConnectedServerForUpdates();
      setOffer(info.available && info.installBlocked !== 'service-manager'
        ? { kind: 'available', info }
        : { kind: 'manual', info, error: null });
    } catch (error) {
      setOffer({ kind: 'manual', info: null, error: error instanceof Error ? error.message : null });
    }
  };

  const manual = offer.kind === 'manual' ? offer : null;
  const manualCommand = manual?.info?.updateCommand || 'openchamber update';

  return (
    <div className="flex w-full flex-col items-center gap-3">
      <div className="flex flex-col gap-2">
        <h1 className="typography-title text-foreground">{t('startup.serverOutdated.title')}</h1>
        <p className="typography-body text-muted-foreground">{t('startup.serverOutdated.description', { version })}</p>
      </div>
      <Button type="button" onClick={() => void checkServer()} disabled={offer.kind === 'checking'}>
        <Icon name={offer.kind === 'checking' ? 'loader' : 'download'} className={offer.kind === 'checking' ? 'size-4 animate-spin' : 'size-4'} />
        {offer.kind === 'checking' ? t('startup.serverOutdated.checking') : t('onboarding.desktopRecovery.remoteIncompatible.updateServer')}
      </Button>
      {manual && (
        <div className="w-full space-y-2 text-left">
          {!manual.info?.available && (
            <p className="typography-meta text-[var(--status-error)]">{t('startup.serverOutdated.noUpdate')}</p>
          )}
          {manual.error && <p className="typography-meta text-muted-foreground">{manual.error}</p>}
          <p className="typography-meta text-muted-foreground">{t('onboarding.desktopRecovery.remoteIncompatible.manualUpdate')}</p>
          <code className="block select-text rounded-md bg-[var(--surface-muted)] px-3 py-2 font-mono text-sm text-foreground">{manualCommand}</code>
        </div>
      )}
      <UpdateDialog
        open={offer.kind === 'available'}
        onOpenChange={(open) => {
          if (!open) setOffer({ kind: 'idle' });
        }}
        info={offer.kind === 'available' ? offer.info : null}
        downloading={false}
        downloaded={false}
        progress={null}
        error={null}
        onDownload={() => {}}
        onRestart={() => {}}
        runtimeType="web"
      />
    </div>
  );
}
