import React from 'react';
import QRCode from 'qrcode';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { toast } from '@/components/ui';
import { Icon } from '@/components/icon/Icon';
import { copyTextToClipboard } from '@/lib/clipboard';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { runtimeFetch } from '@/lib/runtime-fetch';

// OpenChamber-owned relay routes (registered before the generic OpenCode proxy).
const RELAY_STATUS_ROUTE = '/api/openchamber/relay/status';
const RELAY_ENABLE_ROUTE = '/api/openchamber/relay/enable';
const RELAY_DISABLE_ROUTE = '/api/openchamber/relay/disable';
const RELAY_OFFER_ROUTE = '/api/openchamber/relay/offer';

const STATUS_POLL_INTERVAL_MS = 5_000;

type RelayState = 'disabled' | 'connecting' | 'connected' | 'reconnecting' | 'error';

interface RelayStatus {
  enabled: boolean;
  state: RelayState;
  serverId: string;
  connectedClients: number;
  lastError?: string;
}

const RELAY_STATES = new Set<string>(['disabled', 'connecting', 'connected', 'reconnecting', 'error']);

// Authoritative fetch: returns null strictly on fetch/shape failure so callers
// keep the previous status instead of treating a blip as "relay disabled".
const fetchRelayStatus = async (signal?: AbortSignal): Promise<RelayStatus | null> => {
  let response: Response;
  try {
    response = await runtimeFetch(RELAY_STATUS_ROUTE, { method: 'GET', signal });
  } catch {
    return null;
  }
  if (!response.ok) return null;
  const body = (await response.json().catch(() => null)) as Partial<RelayStatus> | null;
  if (!body || typeof body.enabled !== 'boolean' || typeof body.state !== 'string' || !RELAY_STATES.has(body.state)) {
    return null;
  }
  return {
    enabled: body.enabled,
    state: body.state as RelayState,
    serverId: typeof body.serverId === 'string' ? body.serverId : '',
    connectedClients: typeof body.connectedClients === 'number' ? body.connectedClients : 0,
    ...(typeof body.lastError === 'string' && body.lastError ? { lastError: body.lastError } : {}),
  };
};

const stateLabelKey = (state: RelayState): I18nKey => {
  switch (state) {
    case 'connecting':
      return 'settings.remoteInstances.relay.state.connecting';
    case 'connected':
      return 'settings.remoteInstances.relay.state.connected';
    case 'reconnecting':
      return 'settings.remoteInstances.relay.state.reconnecting';
    case 'error':
      return 'settings.remoteInstances.relay.state.error';
    default:
      return 'settings.remoteInstances.relay.state.disabled';
  }
};

const stateDotClass = (state: RelayState): string => {
  if (state === 'connected') {
    return 'bg-[var(--status-success)] animate-pulse';
  }
  if (state === 'error') {
    return 'bg-[var(--status-error)] animate-pulse';
  }
  if (state === 'connecting' || state === 'reconnecting') {
    return 'bg-[var(--status-warning)] animate-pulse';
  }
  return 'bg-muted-foreground/40';
};

export const RelaySection: React.FC = () => {
  const { t } = useI18n();
  const [status, setStatus] = React.useState<RelayStatus | null>(null);
  const [statusLoaded, setStatusLoaded] = React.useState(false);
  const [isToggling, setIsToggling] = React.useState(false);
  const [pairLabel, setPairLabel] = React.useState('');
  const [includeToken, setIncludeToken] = React.useState(true);
  const [isPairing, setIsPairing] = React.useState(false);
  const [offerUrl, setOfferUrl] = React.useState<string | null>(null);
  const [offerQrDataUrl, setOfferQrDataUrl] = React.useState<string | null>(null);
  const [qrDialogOpen, setQrDialogOpen] = React.useState(false);

  const refreshStatus = React.useCallback(async (signal?: AbortSignal) => {
    const next = await fetchRelayStatus(signal);
    if (signal?.aborted) return;
    setStatusLoaded(true);
    // Preserve the last known status on fetch failure; never downgrade to
    // "disabled" because of a transient network error.
    if (next) setStatus(next);
  }, []);

  // Poll only while this section is mounted (page visible) and the document
  // is visible — no global polling.
  React.useEffect(() => {
    const controller = new AbortController();
    void refreshStatus(controller.signal);
    const interval = window.setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
        return;
      }
      void refreshStatus(controller.signal);
    }, STATUS_POLL_INTERVAL_MS);
    return () => {
      controller.abort();
      window.clearInterval(interval);
    };
  }, [refreshStatus]);

  const handleEnable = React.useCallback(async () => {
    setIsToggling(true);
    try {
      const response = await runtimeFetch(RELAY_ENABLE_ROUTE, { method: 'POST' });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      await refreshStatus();
    } catch (err) {
      toast.error(t('settings.remoteInstances.relay.toast.enableFailed'), {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setIsToggling(false);
    }
  }, [refreshStatus, t]);

  const handleDisable = React.useCallback(async () => {
    const confirmed = window.confirm(t('settings.remoteInstances.relay.confirm.disable'));
    if (!confirmed) return;
    setIsToggling(true);
    try {
      const response = await runtimeFetch(RELAY_DISABLE_ROUTE, { method: 'POST' });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      setOfferUrl(null);
      setOfferQrDataUrl(null);
      await refreshStatus();
    } catch (err) {
      toast.error(t('settings.remoteInstances.relay.toast.disableFailed'), {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setIsToggling(false);
    }
  }, [refreshStatus, t]);

  const handleCreateOffer = React.useCallback(async () => {
    setIsPairing(true);
    try {
      const response = await runtimeFetch(RELAY_OFFER_ROUTE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          includeToken,
          ...(pairLabel.trim() ? { clientLabel: pairLabel.trim() } : {}),
        }),
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const result = (await response.json()) as { url?: unknown };
      if (typeof result.url !== 'string' || !result.url) {
        throw new Error('Malformed offer response');
      }
      setOfferUrl(result.url);
      // Relay offers are ~500 chars (encryption key JWK + token) — far denser than
      // direct-pairing QRs. Render at high resolution with low ECC; the fullscreen
      // dialog then displays it large enough for a phone camera to lock on. A small
      // inline QR of this density is unscannable (learned the hard way).
      setOfferQrDataUrl(
        await QRCode.toDataURL(result.url, { width: 1024, margin: 2, errorCorrectionLevel: 'L' }),
      );
      setPairLabel('');
    } catch (err) {
      toast.error(t('settings.remoteInstances.relay.toast.offerFailed'), {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setIsPairing(false);
    }
  }, [includeToken, pairLabel, t]);

  const handleCopyOffer = React.useCallback(() => {
    if (!offerUrl) return;
    void copyTextToClipboard(offerUrl).then((result) => {
      if (result.ok) {
        toast.success(t('settings.remoteInstances.relay.toast.linkCopied'));
      }
    });
  }, [offerUrl, t]);

  const enabled = status?.enabled === true;
  const state: RelayState = status?.state ?? 'disabled';
  const isConnected = state === 'connected';

  return (
    <div data-settings-item="remote-instances.relay" className="mb-8 border-t border-[var(--surface-subtle)] pt-8">
      <div className="mb-1 px-1 space-y-0.5">
        <h3 className="typography-ui-header font-medium text-foreground">{t('settings.remoteInstances.relay.title')}</h3>
        <p className="typography-meta text-muted-foreground">{t('settings.remoteInstances.relay.description')}</p>
      </div>
      <section className="px-2 pb-2 pt-0 space-y-3">
        {!statusLoaded ? (
          <p className="typography-meta text-muted-foreground">{t('settings.remoteInstances.relay.state.loading')}</p>
        ) : !enabled ? (
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <p className="typography-meta text-muted-foreground/70">{t('settings.remoteInstances.relay.enableHint')}</p>
            <Button type="button" size="xs" className="!font-normal shrink-0" onClick={() => void handleEnable()} disabled={isToggling}>
              {t('settings.remoteInstances.relay.actions.enable')}
            </Button>
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between gap-3 py-1.5">
              <div className="min-w-0">
                <div className="flex min-w-0 items-center gap-2">
                  <span className={`h-2 w-2 rounded-full ${stateDotClass(state)}`} />
                  <p className="typography-ui-label text-foreground truncate">{t(stateLabelKey(state))}</p>
                </div>
                <p className="typography-micro text-muted-foreground truncate">
                  {(status?.connectedClients ?? 0) === 1
                    ? t('settings.remoteInstances.relay.status.clientsOne', { count: 1 })
                    : t('settings.remoteInstances.relay.status.clientsMany', { count: status?.connectedClients ?? 0 })}
                </p>
                {state === 'error' && status?.lastError ? (
                  <p className="typography-micro text-[var(--status-error)] break-all">{status.lastError}</p>
                ) : null}
              </div>
              <Button type="button" variant="outline" size="xs" className="!font-normal shrink-0" onClick={() => void handleDisable()} disabled={isToggling}>
                {t('settings.remoteInstances.relay.actions.disable')}
              </Button>
            </div>

            <div className="space-y-2">
              <p className="typography-ui-label text-foreground">{t('settings.remoteInstances.relay.pair.title')}</p>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <Input
                  className="h-8"
                  value={pairLabel}
                  onChange={(event) => setPairLabel(event.target.value)}
                  placeholder={t('settings.remoteInstances.relay.pair.labelPlaceholder')}
                  disabled={isPairing}
                />
                <Button type="button" size="xs" className="!font-normal shrink-0" onClick={() => void handleCreateOffer()} disabled={isPairing || !isConnected}>
                  {t('settings.remoteInstances.relay.pair.generate')}
                </Button>
              </div>
              <label className="flex w-fit cursor-pointer items-center gap-2 py-0.5">
                <Switch checked={includeToken} onCheckedChange={(checked) => setIncludeToken(Boolean(checked))} disabled={isPairing} />
                <span className="typography-ui-label font-normal text-foreground">{t('settings.remoteInstances.relay.pair.includeToken')}</span>
              </label>
              {!includeToken ? (
                <p className="typography-meta text-muted-foreground/70">{t('settings.remoteInstances.relay.pair.noTokenHint')}</p>
              ) : null}
              {!isConnected ? (
                <p className="typography-meta text-muted-foreground/70">{t('settings.remoteInstances.relay.pair.requiresConnected')}</p>
              ) : null}
              {offerUrl ? (
                <div className="min-w-0 space-y-2 rounded-md border border-[var(--interactive-border)] p-2">
                  <p className="typography-meta text-muted-foreground">{t('settings.remoteInstances.relay.pair.linkLabel')}</p>
                  <code className="block select-all break-all typography-code text-foreground">{offerUrl}</code>
                  <div className="flex flex-wrap gap-1">
                    <Button type="button" variant="outline" size="xs" className="!font-normal" onClick={handleCopyOffer}>
                      <Icon name="file-copy" className="h-3.5 w-3.5" />
                      {t('settings.common.actions.copyAll')}
                    </Button>
                    {offerQrDataUrl ? (
                      <Button type="button" variant="outline" size="xs" className="!font-normal" onClick={() => setQrDialogOpen(true)}>
                        <Icon name="scan-2" className="h-3.5 w-3.5" />
                        {t('settings.remoteInstances.relay.pair.showQr')}
                      </Button>
                    ) : null}
                  </div>
                  <p className="typography-meta text-[var(--status-warning)]">{t('settings.remoteInstances.relay.pair.warning')}</p>
                </div>
              ) : null}
              <p className="typography-meta text-muted-foreground/70">{t('settings.remoteInstances.relay.pair.manageHint')}</p>
            </div>
          </>
        )}
      </section>
      <Dialog open={qrDialogOpen} onOpenChange={setQrDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('settings.remoteInstances.relay.pair.qrDialogTitle')}</DialogTitle>
            <DialogDescription>{t('settings.remoteInstances.relay.pair.qrDialogDescription')}</DialogDescription>
          </DialogHeader>
          {offerQrDataUrl ? (
            <div className="flex justify-center py-2">
              <img
                src={offerQrDataUrl}
                alt={t('settings.remoteInstances.relay.pair.qrAlt')}
                className="w-full max-w-xs rounded-md bg-white p-3"
              />
            </div>
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
};
