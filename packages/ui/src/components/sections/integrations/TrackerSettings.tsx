import React from 'react';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui';
import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { useTrackerAuthEntry, useTrackerAuthStore } from '@/stores/useTrackerAuthStore';
import type { TrackerAuthStatus, TrackerDescriptor } from '@/lib/api/types';
import { trackerPresentation } from '@/lib/trackers/presentation';
import { openExternalUrl } from '@/lib/url';
import { useI18n } from '@/lib/i18n';
import { focusDesktopWindow, isDesktopShell } from '@/lib/desktop';
import { Icon } from '@/components/icon/Icon';
import { BusyDots } from '@/components/ui/busy-dots';
import { IntegrationCatalogCard } from './IntegrationCatalogCard';
import { TrackerProjectMapping } from './TrackerProjectMapping';
import { TrackerSessionComments } from './TrackerSessionComments';
import { trackerSettingsCopy } from './trackerSettingsCopy';

const AUTHORIZATION_WATCH_MS = 3 * 60_000;
const AUTHORIZATION_POLL_MS = 1_500;

type AccountSnapshot = {
  connected: boolean;
  ids: string;
  currentId: string;
  currentAuthorizedAt: number;
};

function snapshotAccounts(status: TrackerAuthStatus | null): AccountSnapshot {
  const accounts = status?.connected ? status.accounts ?? [] : [];
  const current = accounts.find((entry) => entry.current);
  return {
    connected: Boolean(status?.connected),
    ids: accounts.map((entry) => entry.id).slice().sort().join(','),
    currentId: current?.id || (status?.connected ? status.account?.id : '') || '',
    currentAuthorizedAt: current?.authorizedAt ?? 0,
  };
}

/**
 * The browser sign-in finished when the tracker now reports a connection it
 * did not have: the first account, another account, or the current one
 * authorized again.
 */
function authorizationCompleted(previous: AccountSnapshot, next: AccountSnapshot): boolean {
  if (!next.connected) return false;
  if (!previous.connected) return true;
  return next.ids !== previous.ids
    || next.currentId !== previous.currentId
    || next.currentAuthorizedAt !== previous.currentAuthorizedAt;
}

/**
 * One tracker on Settings → Integrations → Built-in integrations, drawn from
 * the descriptor the server serves: connect through the browser and wait for
 * the account to appear, disconnect, and switch between accounts where the
 * tracker keeps several (`multipleAccounts`). Project mapping and session
 * comments show where the tracker's capabilities offer them.
 */
export const TrackerSettings: React.FC<{ descriptor: TrackerDescriptor }> = ({ descriptor }) => {
  const { t } = useI18n();
  const trackers = getRegisteredRuntimeAPIs()?.trackers;
  const providerId = descriptor.id;
  const provider = descriptor.name;
  const copy = trackerSettingsCopy(providerId);
  const { capabilities } = descriptor;
  const { status, isLoading, hasChecked } = useTrackerAuthEntry(providerId);
  const refreshTrackerStatus = useTrackerAuthStore((state) => state.refreshStatus);
  const setTrackerStatus = useTrackerAuthStore((state) => state.setStatus);

  const [isBusy, setIsBusy] = React.useState(false);
  const [isWaiting, setIsWaiting] = React.useState(false);
  const [open, setOpen] = React.useState(false);
  const pollTimerRef = React.useRef<number | null>(null);

  const stopWaiting = React.useCallback(() => {
    if (pollTimerRef.current != null) {
      window.clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    setIsWaiting(false);
  }, []);

  React.useEffect(() => {
    if (trackers && !hasChecked) void refreshTrackerStatus(trackers, providerId);
  }, [hasChecked, providerId, refreshTrackerStatus, trackers]);

  // Only leaving the card ends a browser sign-in wait. Tied to the effect above,
  // the wait also ended when a poll's answer first set `hasChecked` (the
  // opening status read had failed), and the card never saw the sign-in land.
  React.useEffect(() => stopWaiting, [stopWaiting]);

  const startConnect = React.useCallback(async () => {
    if (!trackers) return;
    stopWaiting();
    setIsBusy(true);
    const previous = snapshotAccounts(useTrackerAuthStore.getState().entries[providerId]?.status ?? null);
    try {
      const payload = await trackers.authStart(providerId, isDesktopShell() ? 'desktop' : 'web');
      setIsWaiting(true);
      setOpen(true);
      void openExternalUrl(payload.authorizationUrl);

      const deadline = Date.now() + AUTHORIZATION_WATCH_MS;
      pollTimerRef.current = window.setInterval(() => {
        void (async () => {
          if (Date.now() > deadline) {
            stopWaiting();
            toast.error(t(copy.toastAuthorizationFailed, { provider }));
            return;
          }
          const next = await refreshTrackerStatus(trackers, providerId, { force: true });
          if (authorizationCompleted(previous, snapshotAccounts(next))) {
            stopWaiting();
            toast.success(t(copy.toastConnected, { provider }));
            void focusDesktopWindow();
          }
        })();
      }, AUTHORIZATION_POLL_MS);
    } catch {
      toast.error(t(copy.toastStartConnectFailed, { provider }));
      stopWaiting();
    } finally {
      setIsBusy(false);
    }
  }, [copy, provider, providerId, refreshTrackerStatus, stopWaiting, t, trackers]);

  const activateAccount = React.useCallback(async (accountId: string) => {
    if (!trackers || !accountId) return;
    setIsBusy(true);
    try {
      setTrackerStatus(providerId, await trackers.authActivate(providerId, accountId));
      toast.success(t(copy.toastAccountSwitched, { provider }));
    } catch {
      toast.error(t(copy.toastAccountSwitchFailed, { provider }));
    } finally {
      setIsBusy(false);
    }
  }, [copy, provider, providerId, setTrackerStatus, t, trackers]);

  const disconnect = React.useCallback(async () => {
    if (!trackers) return;
    setIsBusy(true);
    try {
      stopWaiting();
      await trackers.authDisconnect(providerId);
      toast.success(t(copy.toastDisconnected, { provider }));
      await refreshTrackerStatus(trackers, providerId, { force: true });
    } catch {
      toast.error(t(copy.toastDisconnectFailed, { provider }));
    } finally {
      setIsBusy(false);
    }
  }, [copy, provider, providerId, refreshTrackerStatus, stopWaiting, t, trackers]);

  if (!trackers) return null;

  const icon = trackerPresentation(providerId).icon;
  // Browser sign-in is the one method this version draws; a tracker that only
  // takes another asks for an update instead of showing a dead Connect.
  const canConnect = descriptor.authMethods.includes('oauth');
  const connected = Boolean(status?.connected);
  const account = status?.connected ? status.account ?? null : null;
  const user = account?.user;
  const otherAccounts = capabilities.multipleAccounts && status?.connected
    ? (status.accounts ?? []).filter((entry) => !entry.current)
    : [];
  const displayName = user?.name?.trim() || t(copy.unknownUser);
  const statusLabel = isWaiting
    ? t(copy.waiting)
    : isLoading && !hasChecked
      ? t('common.loading')
      : connected
        ? (account?.name?.trim() || t(copy.connected))
        : t(copy.notConnected);
  const expanded = isWaiting || open;
  const settingsItem = `integrations.${providerId}`;

  return (
    <IntegrationCatalogCard
      settingsItem={settingsItem}
      logo={<Icon name={icon} className="size-5 text-foreground" />}
      name={provider}
      description={t(copy.description, { provider })}
      status={statusLabel}
      statusTone={isWaiting ? 'warning' : connected ? 'success' : 'neutral'}
      open={expanded}
      onOpenChange={(nextOpen) => setOpen(isWaiting || nextOpen)}
    >
      <div className="space-y-3">
        {connected ? (
          <div className="flex min-w-0 items-center gap-3">
            {user?.avatarUrl ? (
              <img
                src={user.avatarUrl}
                alt={t(copy.avatarAlt, { name: displayName, provider })}
                className="size-10 shrink-0 rounded-full border border-[var(--interactive-border)] bg-[var(--surface-muted)] object-cover"
                loading="lazy"
                referrerPolicy="no-referrer"
              />
            ) : (
              <div className="flex size-10 shrink-0 items-center justify-center rounded-full border border-[var(--interactive-border)] bg-[var(--surface-muted)]">
                <Icon name={icon} className="size-4 text-muted-foreground" />
              </div>
            )}
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-medium text-foreground">{displayName}</div>
              {account?.name ? <p className="mt-0.5 truncate text-xs text-muted-foreground">{account.name}</p> : null}
            </div>
          </div>
        ) : isWaiting ? (
          <p className="text-xs text-muted-foreground">{t(copy.flowDescription, { provider })}</p>
        ) : null}

        {connected ? (
          <>
            {capabilities.projectMapping ? (
              <TrackerProjectMapping trackers={trackers} providerId={providerId} provider={provider} accountId={account?.id ?? null} />
            ) : null}
            {capabilities.sessionComments ? (
              <TrackerSessionComments trackers={trackers} providerId={providerId} provider={provider} />
            ) : null}
            {otherAccounts.length > 0 ? (
              <div className="space-y-2">
                <p className="typography-micro text-muted-foreground">{t(copy.otherAccounts, { provider })}</p>
                <div className="space-y-1">
                  {otherAccounts.map((entry) => (
                    <div key={entry.id} className="flex items-center justify-between gap-3 oc-tile-inset rounded-md px-3 py-2">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium text-foreground">
                          {entry.name?.trim() || t(copy.connected)}
                        </div>
                        {entry.user?.name ? <p className="truncate text-xs text-muted-foreground">{entry.user.name}</p> : null}
                      </div>
                      <Button type="button" size="sm" variant="ghost" onClick={() => void activateAccount(entry.id)} disabled={isBusy}>
                        {t(copy.switchTo)}
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
            <div className="flex flex-wrap items-center gap-2">
              {capabilities.multipleAccounts && canConnect ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => void startConnect()}
                  disabled={isBusy || isWaiting}
                  data-settings-item={`${settingsItem}.add-workspace`}
                >
                  {t(copy.addAccount, { provider })}
                </Button>
              ) : null}
              <Button type="button" size="sm" variant="destructive" onClick={() => void disconnect()} disabled={isBusy}>
                {t(copy.disconnect)}
              </Button>
            </div>
          </>
        ) : isWaiting ? (
          <div className="flex flex-wrap items-center gap-2">
            <span className="typography-micro text-muted-foreground">
              {t(copy.flowWaiting)}<BusyDots />
            </span>
            <Button type="button" size="sm" variant="ghost" disabled={isBusy} onClick={stopWaiting}>
              {t('settings.common.actions.cancel')}
            </Button>
          </div>
        ) : canConnect ? (
          <Button
            type="button"
            size="sm"
            variant="default"
            onClick={() => void startConnect()}
            disabled={isBusy || (isLoading && !hasChecked)}
          >
            {isBusy ? <Icon name="loader-4" className="size-3.5 animate-spin" /> : null}
            {t(copy.connect, { provider })}
          </Button>
        ) : (
          <p className="typography-meta text-muted-foreground">{t(copy.unsupportedSignIn, { provider })}</p>
        )}
      </div>
    </IntegrationCatalogCard>
  );
};
