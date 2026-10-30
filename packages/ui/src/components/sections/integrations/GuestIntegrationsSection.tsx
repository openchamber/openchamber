import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { GuestIcon } from '@/components/layout/GuestRailIcon';
import { SettingsSection, SettingsStackedField } from '@/components/sections/shared/SettingsSection';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { IntegrationCatalogCard } from './IntegrationCatalogCard';
import { NotificationChannelCard } from './NotificationChannelCard';
import { focusDesktopWindow, isDesktopShell, isVSCodeRuntime } from '@/lib/desktop';
import { loadNotificationChannels, type NotificationChannel } from '@/lib/notifications/channels';
import { isMobileSurfaceRuntime } from '@/lib/runtimeSurface';
import { copyTextToClipboard } from '@/lib/clipboard';
import { useI18n } from '@/lib/i18n';
import { isGuestActive } from '@/lib/guests/capabilities';
import { loadGuestCatalog } from '@/lib/guests/load-catalog';
import {
  AUTHORIZATION_POLL_MS,
  AUTHORIZATION_WATCH_MS,
  disconnectGuestOauth,
  guestAuthorizationCompleted,
  saveGuestAccessToken,
  saveGuestOauthClient,
  saveGuestSettings,
  startGuestOauth,
} from '@/lib/guests/oauth';
import { useGuestOauthStore } from '@/lib/guests/oauth-store';
import { useGuestsStore } from '@/lib/guests/store';
import type { InstalledGuest } from '@/lib/guests/types';
import { reportSettingsSaveState } from '@/lib/persistence';
import { guestPackageIconSrc, resolveGuestIconName } from '@/lib/guests/icon';
import { getRuntimeUrlResolver } from '@/lib/runtime-url';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { openExternalUrl } from '@/lib/url';

type GuestIntegrationCardProps = {
  guest: InstalledGuest;
};

export const GuestIntegrationCard: React.FC<GuestIntegrationCardProps> = ({ guest }) => {
  const { t } = useI18n();
  const integration = guest.integration;
  const status = useGuestOauthStore((state) => state.byId[guest.id]);
  const setStatus = useGuestOauthStore((state) => state.setStatus);
  const iconSrc = React.useMemo(
    () => guestPackageIconSrc(guest.id, guest.icon, getRuntimeUrlResolver().authenticatedAsset),
    [guest.id, guest.icon],
  );
  const refresh = useGuestOauthStore((state) => state.refresh);
  const [open, setOpen] = React.useState(false);
  const [isBusy, setIsBusy] = React.useState(false);
  const [isWaiting, setIsWaiting] = React.useState(false);
  const [clientId, setClientId] = React.useState('');
  const [clientSecret, setClientSecret] = React.useState('');
  const [token, setToken] = React.useState('');
  const [username, setUsername] = React.useState('');
  const [settings, setSettings] = React.useState<Record<string, string>>({});
  const [copied, setCopied] = React.useState(false);
  const pollTimerRef = React.useRef<number | null>(null);
  const [ownerRuntimeKey] = React.useState(getRuntimeKey);
  const mountedRef = React.useRef(true);
  const isCurrent = () => mountedRef.current && getRuntimeKey() === ownerRuntimeKey;

  const stopWaiting = React.useCallback(() => {
    if (pollTimerRef.current != null) {
      window.clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    setIsWaiting(false);
  }, []);

  React.useEffect(() => {
    mountedRef.current = true;
    void refresh(guest.id);
    return () => {
      mountedRef.current = false;
      stopWaiting();
    };
  }, [guest.id, refresh, stopWaiting]);

  React.useEffect(() => {
    if (!status) {
      return;
    }
    setSettings(status.settings);
  }, [status]);

  if (!integration) {
    return null;
  }

  const auth = integration.auth;
  const needsUsername = auth === 'token' && integration.token?.scheme === 'basic';
  const connected = Boolean(status?.connection.connected);
  const account = status?.connection.account.trim() || '';
  const statusLabel = isWaiting
    ? t('settings.integrations.guests.status.waiting')
    : connected
      ? (account || t('settings.integrations.guests.status.connected'))
      : t('settings.integrations.guests.status.notConnected');
  const statusTone = isWaiting ? 'warning' : connected ? 'success' : 'neutral';
  const expanded = isWaiting || open;
  const name = integration.name;

  const saveClient = async (): Promise<boolean> => {
    if (!isCurrent()) return false;
    const nextId = clientId.trim();
    if (!nextId) {
      if (status?.hasClient) {
        return true;
      }
      toast.error(t('settings.integrations.guests.toast.clientRequired'));
      return false;
    }
    reportSettingsSaveState('saving');
    const saved = await saveGuestOauthClient(guest.id, nextId, clientSecret.trim() || undefined);
    if (!isCurrent()) return false;
    if (!saved) {
      reportSettingsSaveState('error');
      toast.error(t('settings.integrations.guests.toast.saveFailed', { name }));
      return false;
    }
    setStatus(guest.id, saved);
    setClientSecret('');
    reportSettingsSaveState('saved');
    return true;
  };

  const saveDeclaredSettings = async (next: Record<string, string> = settings): Promise<boolean> => {
    if (!isCurrent()) return false;
    const stored = status?.settings ?? {};
    const declared = integration.settings ?? [];
    const unchanged = declared.every((field) => (next[field.id] ?? '').trim() === (stored[field.id] ?? ''));
    if (unchanged) {
      return true;
    }
    reportSettingsSaveState('saving');
    const saved = await saveGuestSettings(guest.id, next);
    if (!isCurrent()) return false;
    if (!saved) {
      reportSettingsSaveState('error');
      toast.error(t('settings.integrations.guests.toast.saveFailed', { name }));
      return false;
    }
    setStatus(guest.id, saved);
    reportSettingsSaveState('saved');
    return true;
  };

  const saveToken = async (): Promise<boolean> => {
    if (!isCurrent()) return false;
    const nextToken = token.trim();
    if (!nextToken) {
      if (connected) {
        return true;
      }
      toast.error(t('settings.integrations.guests.toast.tokenRequired'));
      return false;
    }
    const nextUsername = username.trim();
    if (needsUsername && !nextUsername) {
      toast.error(t('settings.integrations.guests.toast.usernameRequired'));
      return false;
    }
    reportSettingsSaveState('saving');
    const saved = await saveGuestAccessToken(guest.id, nextToken, needsUsername ? nextUsername : undefined);
    if (!isCurrent()) return false;
    if (!saved) {
      reportSettingsSaveState('error');
      toast.error(t('settings.integrations.guests.toast.tokenInvalid'));
      return false;
    }
    setStatus(guest.id, saved);
    setToken('');
    setUsername('');
    reportSettingsSaveState('saved');
    return true;
  };

  const startConnect = async (): Promise<void> => {
    if (!isCurrent()) return;
    stopWaiting();
    setIsBusy(true);
    const previous = status?.connection ?? { connected: false, account: '' };
    try {
      if (auth === 'token') {
        const saved = await saveToken();
        if (saved) {
          if ((integration.settings ?? []).length > 0) {
            if (!await saveDeclaredSettings()) return;
          }
          if (!isCurrent()) return;
          toast.success(t('settings.integrations.guests.toast.connected', { name }));
        }
        return;
      }
      if (auth === 'oauth' && !status?.hasClient) {
        const saved = await saveClient();
        if (!saved) {
          return;
        }
      }
      const authorizationUrl = await startGuestOauth(guest.id);
      if (!isCurrent()) return;
      if (!authorizationUrl) {
        toast.error(t('settings.integrations.guests.toast.startFailed', { name }));
        return;
      }
      setIsWaiting(true);
      setOpen(true);
      void openExternalUrl(authorizationUrl);
      const deadline = Date.now() + AUTHORIZATION_WATCH_MS;
      pollTimerRef.current = window.setInterval(() => {
        void (async () => {
          if (!isCurrent()) { stopWaiting(); return; }
          if (Date.now() > deadline) {
            stopWaiting();
            toast.error(t('settings.integrations.guests.toast.authorizationFailed', { name }));
            return;
          }
          const next = await refresh(guest.id);
          if (!isCurrent()) return;
          if (next && guestAuthorizationCompleted(previous, next.connection)) {
            stopWaiting();
            toast.success(t('settings.integrations.guests.toast.connected', { name }));
            if (isDesktopShell()) {
              void focusDesktopWindow();
            }
          }
        })();
      }, AUTHORIZATION_POLL_MS);
    } catch (error) {
      if (!isCurrent()) return;
      console.error('Failed to start guest connect:', error);
      toast.error(t('settings.integrations.guests.toast.startFailed', { name }));
      stopWaiting();
    } finally {
      if (isCurrent()) setIsBusy(false);
    }
  };

  const disconnect = async (): Promise<void> => {
    if (!isCurrent()) return;
    setIsBusy(true);
    try {
      stopWaiting();
      const next = await disconnectGuestOauth(guest.id);
      if (!isCurrent()) return;
      if (!next) {
        toast.error(t('settings.integrations.guests.toast.disconnectFailed', { name }));
        return;
      }
      setStatus(guest.id, next);
      toast.success(t('settings.integrations.guests.toast.disconnected', { name }));
    } catch (error) {
      if (!isCurrent()) return;
      console.error('Failed to disconnect guest:', error);
      toast.error(t('settings.integrations.guests.toast.disconnectFailed', { name }));
    } finally {
      if (isCurrent()) setIsBusy(false);
    }
  };

  const copyRedirect = async (): Promise<void> => {
    const uri = status?.redirectUri ?? '';
    if (!uri) {
      return;
    }
    const result = await copyTextToClipboard(uri);
    if (!result.ok) {
      return;
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <IntegrationCatalogCard
      logo={(
        <GuestIcon
          icon={resolveGuestIconName(guest.icon)}
          iconSrc={iconSrc}
          className="size-5 text-foreground"
        />
      )}
      name={name}
      description={integration.description}
      status={statusLabel}
      statusTone={statusTone}
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
            {auth === 'oauth' ? (
              <>
                <SettingsStackedField
                  label={t('settings.integrations.guests.field.clientId')}
                  controlClassName="w-full max-w-none"
                >
                  <Input
                    value={clientId}
                    onChange={(event) => setClientId(event.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                    className="h-8 min-w-0 flex-1 rounded-md px-3"
                    disabled={isBusy}
                  />
                </SettingsStackedField>
                <SettingsStackedField
                  label={t('settings.integrations.guests.field.clientSecret')}
                  controlClassName="w-full max-w-none"
                >
                  <Input
                    type="password"
                    value={clientSecret}
                    onChange={(event) => setClientSecret(event.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                    className="h-8 min-w-0 flex-1 rounded-md px-3"
                    disabled={isBusy}
                  />
                </SettingsStackedField>
              </>
            ) : null}
            {needsUsername ? (
              <SettingsStackedField
                label={integration.token?.usernameLabel ?? t('settings.integrations.guests.field.username')}
                controlClassName="w-full max-w-none"
              >
                <Input
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  className="h-8 min-w-0 flex-1 rounded-md px-3"
                  disabled={isBusy}
                />
              </SettingsStackedField>
            ) : null}
            {auth === 'token' ? (
              <SettingsStackedField
                label={t('settings.integrations.guests.field.token')}
                info={t('settings.integrations.guests.field.token.info')}
                controlClassName="w-full max-w-none"
              >
                <Input
                  type="password"
                  value={token}
                  onChange={(event) => setToken(event.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  className="h-8 min-w-0 flex-1 rounded-md px-3"
                  disabled={isBusy}
                />
              </SettingsStackedField>
            ) : null}
            {(integration.settings ?? []).map((field) => (
              <SettingsStackedField
                key={field.id}
                label={field.label}
                controlClassName="w-full max-w-none"
              >
                <Input
                  value={settings[field.id] ?? ''}
                  onChange={(event) => {
                    setSettings((current) => ({ ...current, [field.id]: event.target.value }));
                  }}
                  onBlur={() => void saveDeclaredSettings()}
                  autoComplete="off"
                  spellCheck={false}
                  className="h-8 min-w-0 flex-1 rounded-md px-3"
                  disabled={isBusy}
                />
              </SettingsStackedField>
            ))}
            {auth === 'oauth' ? (
              <SettingsStackedField
                label={t('settings.integrations.guests.field.redirectUri')}
                info={t('settings.integrations.guests.field.redirectUri.info')}
                controlClassName="w-full max-w-none"
              >
                <Input
                  value={status?.redirectUri ?? ''}
                  readOnly
                  className="h-8 min-w-0 flex-1 rounded-md px-3"
                />
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={!status?.redirectUri}
                  onClick={() => void copyRedirect()}
                >
                  {copied
                    ? t('settings.integrations.guests.actions.copied')
                    : t('settings.integrations.guests.actions.copyRedirect')}
                </Button>
              </SettingsStackedField>
            ) : null}
            <div className="flex flex-wrap items-center gap-2">
              {connected ? (
                <Button
                  type="button"
                  size="sm"
                  variant="destructive"
                  disabled={isBusy}
                  onClick={() => void disconnect()}
                >
                  {t('settings.integrations.guests.actions.disconnect')}
                </Button>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  disabled={isBusy || isWaiting}
                  onClick={() => void startConnect()}
                >
                  {isBusy ? <Icon name="loader-4" className="size-3.5 animate-spin" /> : null}
                  {t('settings.integrations.guests.actions.connect')}
                </Button>
              )}
            </div>
          </div>
    </IntegrationCatalogCard>
  );
};

export const GuestIntegrationsSection: React.FC<{ divider?: boolean }> = ({ divider = true }) => {
  const { t } = useI18n();
  const guests = useGuestsStore((state) => state.guests);
  const runtimeKey = useGuestsStore((state) => state.runtimeKey);
  const [channels, setChannels] = React.useState<NotificationChannel[]>([]);
  const [ownerRuntimeKey] = React.useState(getRuntimeKey);
  // Whether the last channel load failed: the section refreshes on every catalog change, and one failure is told once.
  const channelsLoadFailedRef = React.useRef(false);

  // The channels an approved extension serves, with their accounts; a load that
  // fails keeps the last list, never an empty one.
  const refreshChannels = React.useCallback(async () => {
    const loaded = await loadNotificationChannels();
    if (getRuntimeKey() !== ownerRuntimeKey) return;
    if (loaded === null) {
      if (!channelsLoadFailedRef.current) toast.error(t('settings.integrations.channels.toast.loadFailed'));
      channelsLoadFailedRef.current = true;
      return;
    }
    channelsLoadFailedRef.current = false;
    setChannels(loaded);
  }, [ownerRuntimeKey, t]);

  React.useEffect(() => {
    void loadGuestCatalog();
  }, []);

  React.useEffect(() => {
    if (isVSCodeRuntime() || isMobileSurfaceRuntime()) return;
    void refreshChannels();
    // Approving or pausing an extension changes which channels exist.
  }, [refreshChannels, guests]);

  if (isVSCodeRuntime() || isMobileSurfaceRuntime()) {
    return null;
  }

  const cards = guests.filter((guest) => guest.source !== 'bundled' && guest.integration && isGuestActive(guest));
  if (cards.length === 0 && channels.length === 0) {
    return null;
  }

  return (
    <SettingsSection
      title={t('settings.integrations.guests.title')}
      info={t('settings.integrations.guests.info')}
      divider={divider}
      settingsItem="integrations.guests"
      contentClassName="space-y-3"
    >
      {cards.map((guest) => (
        <GuestIntegrationCard key={`${runtimeKey}:${guest.id}`} guest={guest} />
      ))}
      {channels.map((channel) => (
        <NotificationChannelCard
          key={`${runtimeKey}:${channel.providerId}`}
          channel={channel}
          guest={guests.find((guest) => guest.id === channel.guestId) ?? null}
          onChanged={refreshChannels}
        />
      ))}
    </SettingsSection>
  );
};
