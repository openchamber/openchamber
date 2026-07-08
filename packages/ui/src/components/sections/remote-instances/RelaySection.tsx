import React from 'react';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { runtimeFetch } from '@/lib/runtime-fetch';

// OpenChamber-owned relay routes (registered before the generic OpenCode proxy).
const RELAY_STATUS_ROUTE = '/api/openchamber/relay/status';
const RELAY_ENABLE_ROUTE = '/api/openchamber/relay/enable';
const RELAY_DISABLE_ROUTE = '/api/openchamber/relay/disable';

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

// Relay host toggle + status. Pairing is unified: when the relay is enabled the
// pairing links generated in the client-auth section (and by `connect-url`)
// automatically carry a relay transport candidate, so there is no separate
// relay-offer flow here.
export const RelaySection: React.FC = () => {
  const { t } = useI18n();
  const [status, setStatus] = React.useState<RelayStatus | null>(null);
  const [statusLoaded, setStatusLoaded] = React.useState(false);
  const [isToggling, setIsToggling] = React.useState(false);

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
      await refreshStatus();
    } catch (err) {
      toast.error(t('settings.remoteInstances.relay.toast.disableFailed'), {
        description: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setIsToggling(false);
    }
  }, [refreshStatus, t]);

  const enabled = status?.enabled === true;
  const state: RelayState = status?.state ?? 'disabled';

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
        )}
      </section>
    </div>
  );
};
