import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui';
import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { useLinearAuthStore } from '@/stores/useLinearAuthStore';
import { openExternalUrl } from '@/lib/url';
import { useI18n } from '@/lib/i18n';
import { focusDesktopWindow, isDesktopShell } from '@/lib/desktop';
import { Icon } from '@/components/icon/Icon';
import { BusyDots } from '@/components/ui/busy-dots';
import { IntegrationCatalogCard } from './IntegrationCatalogCard';
import { LinearProjectMapping } from './LinearProjectMapping';
import { LinearSessionComments } from './LinearSessionComments';

const AUTHORIZATION_WATCH_MS = 3 * 60_000;
const AUTHORIZATION_POLL_MS = 1_500;

type WorkspaceSnapshot = {
  connected: boolean;
  ids: string;
  currentId: string;
  currentAuthorizedAt: number;
};

function snapshotWorkspaces(status: {
  connected?: boolean;
  organization?: { id?: string } | null;
  workspaces?: Array<{ id: string; current: boolean; authorizedAt?: number | null }>;
} | null): WorkspaceSnapshot {
  const workspaces = status?.workspaces ?? [];
  const current = workspaces.find((entry) => entry.current);
  return {
    connected: Boolean(status?.connected),
    ids: workspaces.map((entry) => entry.id).slice().sort().join(','),
    currentId: current?.id || status?.organization?.id || '',
    currentAuthorizedAt: current?.authorizedAt ?? 0,
  };
}

function authorizationCompleted(previous: WorkspaceSnapshot, next: WorkspaceSnapshot): boolean {
  if (!next.connected) return false;
  if (!previous.connected) return true;
  return next.ids !== previous.ids
    || next.currentId !== previous.currentId
    || next.currentAuthorizedAt !== previous.currentAuthorizedAt;
}

export const LinearSettings: React.FC = () => {
  const { t } = useI18n();
  const runtimeLinear = getRegisteredRuntimeAPIs()?.linear;
  const status = useLinearAuthStore((state) => state.status);
  const isLoading = useLinearAuthStore((state) => state.isLoading);
  const hasChecked = useLinearAuthStore((state) => state.hasChecked);
  const refreshStatus = useLinearAuthStore((state) => state.refreshStatus);
  const setStatus = useLinearAuthStore((state) => state.setStatus);

  const [isBusy, setIsBusy] = React.useState(false);
  const [vaultReference, setVaultReference] = React.useState('');
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
    if (!runtimeLinear) {
      return;
    }
    if (!hasChecked) {
      void refreshStatus(runtimeLinear);
    }
    return () => {
      stopWaiting();
    };
  }, [hasChecked, refreshStatus, runtimeLinear, stopWaiting]);

  const startConnect = React.useCallback(async () => {
    if (!runtimeLinear) return;
    stopWaiting();
    setIsBusy(true);
    const previous = snapshotWorkspaces(useLinearAuthStore.getState().status);
    try {
      const payload = await runtimeLinear.authStart(isDesktopShell() ? 'desktop' : 'web');
      setIsWaiting(true);
      setOpen(true);
      void openExternalUrl(payload.authorizationUrl);

      const deadline = Date.now() + AUTHORIZATION_WATCH_MS;
      pollTimerRef.current = window.setInterval(() => {
        void (async () => {
          if (Date.now() > deadline) {
            stopWaiting();
            toast.error(t('settings.integrations.linear.toast.authorizationFailed'));
            return;
          }
          const next = await refreshStatus(runtimeLinear, { force: true });
          if (authorizationCompleted(previous, snapshotWorkspaces(next))) {
            stopWaiting();
            toast.success(t('settings.integrations.linear.toast.connected'));
            void focusDesktopWindow();
          }
        })();
      }, AUTHORIZATION_POLL_MS);
    } catch (error) {
      console.error('Failed to start Linear connect:', error);
      toast.error(t('settings.integrations.linear.toast.startConnectFailed'));
      stopWaiting();
    } finally {
      setIsBusy(false);
    }
  }, [refreshStatus, runtimeLinear, stopWaiting, t]);

  // A Linear personal API key kept in 1Password: the server reads the key
  // once to identify the workspace and stores only the reference (#304).
  const addFromVault = React.useCallback(async () => {
    const reference = vaultReference.trim();
    if (!reference || !runtimeLinear?.authVault) return;
    setIsBusy(true);
    try {
      const payload = await runtimeLinear.authVault(reference);
      setStatus(payload);
      setVaultReference('');
      toast.success(t('settings.vault.added'));
    } catch (error) {
      console.error('Failed to add a Linear account from 1Password:', error);
      // SAFETY: authVault attaches the server's stable error code to the Error it throws; the probe is optional, so any other failure falls through to the generic message.
      const code = (error as { code?: string })?.code;
      toast.error(code === 'VAULT_READ_FAILED' ? t('settings.vault.error.readFailed')
        : code === 'INVALID_TOKEN' ? t('settings.vault.error.invalidToken')
          : code === 'INVALID_REFERENCE' ? t('settings.vault.error.invalidReference')
            : t('settings.vault.error.failed'));
    } finally {
      setIsBusy(false);
    }
  }, [runtimeLinear, setStatus, t, vaultReference]);

  const activateWorkspace = React.useCallback(async (organizationId: string) => {
    if (!runtimeLinear || !organizationId) return;
    setIsBusy(true);
    try {
      const payload = await runtimeLinear.authActivate(organizationId);
      setStatus(payload);
      toast.success(t('settings.integrations.linear.toast.workspaceSwitched'));
    } catch (error) {
      console.error('Failed to switch Linear workspace:', error);
      toast.error(t('settings.integrations.linear.toast.workspaceSwitchFailed'));
    } finally {
      setIsBusy(false);
    }
  }, [runtimeLinear, setStatus, t]);

  const disconnect = React.useCallback(async () => {
    if (!runtimeLinear) return;
    setIsBusy(true);
    try {
      stopWaiting();
      await runtimeLinear.authDisconnect();
      toast.success(t('settings.integrations.linear.toast.disconnected'));
      await refreshStatus(runtimeLinear, { force: true });
    } catch (error) {
      console.error('Failed to disconnect Linear:', error);
      toast.error(t('settings.integrations.linear.toast.disconnectFailed'));
    } finally {
      setIsBusy(false);
    }
  }, [refreshStatus, runtimeLinear, stopWaiting, t]);

  if (!runtimeLinear) {
    return null;
  }

  const connected = Boolean(status?.connected);
  const user = status?.user;
  const organization = status?.organization;
  const workspaces = status?.workspaces ?? [];
  const otherWorkspaces = workspaces.filter((workspace) => !workspace.current);
  const displayName = user?.displayName?.trim() || user?.name?.trim() || t('settings.integrations.linear.label.unknownUser');
  const statusLabel = isWaiting
    ? t('settings.integrations.linear.status.waiting')
    : isLoading && !hasChecked
      ? t('common.loading')
      : connected
        ? (organization?.name?.trim() || t('settings.integrations.linear.status.connected'))
        : t('settings.integrations.linear.status.notConnected');
  const expanded = isWaiting || open;

  return (
      <IntegrationCatalogCard
        settingsItem="integrations.linear"
        logo={<Icon name="linear" className="size-5 text-foreground" />}
        name={t('settings.integrations.linear.title')}
        description={t('settings.integrations.linear.description')}
        status={statusLabel}
        statusTone={isWaiting ? 'warning' : connected ? 'success' : 'neutral'}
        open={expanded}
        onOpenChange={(nextOpen) => {
          if (isWaiting) {
            setOpen(true);
            return;
          }
          setOpen(nextOpen);
        }}
      >
            <div className="space-y-3">
              {connected ? (
                <div className="flex min-w-0 items-center gap-3">
                  {user?.avatarUrl ? (
                    <img
                      src={user.avatarUrl}
                      alt={t('settings.integrations.linear.avatarAlt.withName', { name: displayName })}
                      className="size-10 shrink-0 rounded-full border border-[var(--interactive-border)] bg-[var(--surface-muted)] object-cover"
                      loading="lazy"
                      referrerPolicy="no-referrer"
                    />
                  ) : (
                    <div className="flex size-10 shrink-0 items-center justify-center rounded-full border border-[var(--interactive-border)] bg-[var(--surface-muted)]">
                      <Icon name="linear" className="size-4 text-muted-foreground" />
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium text-foreground">{displayName}</div>
                    <p className="mt-0.5 truncate text-xs text-muted-foreground">
                      {[organization?.name, user?.email].filter(Boolean).join(' · ')}
                    </p>
                  </div>
                </div>
              ) : isWaiting ? (
                <p className="text-xs text-muted-foreground">
                  {t('settings.integrations.linear.flow.description')}
                </p>
              ) : null}

              {connected ? (
                <>
                  <LinearProjectMapping
                    linear={runtimeLinear}
                    connected={connected}
                    organizationId={organization?.id ?? null}
                  />
                  <LinearSessionComments linear={runtimeLinear} connected={connected} />
                  {otherWorkspaces.length > 0 ? (
                    <div className="space-y-2">
                      <p className="typography-micro text-muted-foreground">
                        {t('settings.integrations.linear.label.otherWorkspaces')}
                      </p>
                      <div className="space-y-1">
                        {otherWorkspaces.map((workspace) => {
                          const workspaceUser = workspace.user;
                          const workspaceName = workspace.name?.trim()
                            || t('settings.integrations.linear.status.connected');
                          return (
                            <div
                              key={workspace.id}
                              className="flex items-center justify-between gap-3 oc-tile-inset rounded-md px-3 py-2"
                            >
                              <div className="min-w-0">
                                <div className="truncate text-sm font-medium text-foreground">{workspaceName}</div>
                                {workspaceUser?.email ? (
                                  <p className="truncate text-xs text-muted-foreground">{workspaceUser.email}</p>
                                ) : null}
                              </div>
                              <Button
                                type="button"
                                size="sm"
                                variant="ghost"
                                onClick={() => void activateWorkspace(workspace.id)}
                                disabled={isBusy}
                              >
                                {t('settings.integrations.linear.actions.switchTo')}
                              </Button>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  ) : null}
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => void startConnect()}
                      disabled={isBusy || isWaiting}
                      data-settings-item="integrations.linear.add-workspace"
                    >
                      {t('settings.integrations.linear.actions.addWorkspace')}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="destructive"
                      onClick={() => void disconnect()}
                      disabled={isBusy}
                    >
                      {t('settings.integrations.linear.actions.disconnect')}
                    </Button>
                  </div>
                </>
              ) : isWaiting ? (
                <div className="flex flex-wrap items-center gap-2">
                  <span className="typography-micro text-muted-foreground">
                    {t('settings.integrations.linear.flow.waiting')}<BusyDots />
                  </span>
                  <Button type="button" size="sm" variant="ghost" disabled={isBusy} onClick={stopWaiting}>
                    {t('settings.common.actions.cancel')}
                  </Button>
                </div>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  variant="default"
                  onClick={() => void startConnect()}
                  disabled={isBusy || (isLoading && !hasChecked)}
                >
                  {isBusy ? <Icon name="loader-4" className="size-3.5 animate-spin" /> : null}
                  {t('settings.integrations.linear.actions.connect')}
                </Button>
              )}

              {runtimeLinear.authVault ? (
                <div className="space-y-2 border-t border-[var(--interactive-border)] pt-3">
                  <p className="text-sm font-medium text-foreground">{t('settings.integrations.linear.vault.label')}</p>
                  <p className="text-xs text-muted-foreground">{t('settings.integrations.linear.vault.info')}</p>
                  <form
                    className="flex flex-wrap items-center gap-2"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void addFromVault();
                    }}
                  >
                    <Input
                      className="h-8 w-[18rem] max-w-full font-mono text-xs"
                      value={vaultReference}
                      onChange={(event) => setVaultReference(event.target.value)}
                      placeholder="op://Vault/item/field"
                      aria-label={t('settings.integrations.linear.vault.label')}
                      disabled={isBusy}
                    />
                    <Button type="submit" size="sm" variant="outline" disabled={isBusy || !vaultReference.trim()}>
                      {t('settings.vault.add')}
                    </Button>
                  </form>
                </div>
              ) : null}
            </div>
      </IntegrationCatalogCard>
  );
};
