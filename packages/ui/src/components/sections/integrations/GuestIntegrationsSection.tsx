import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { GuestIcon } from '@/components/layout/GuestRailIcon';
import { SettingsSection, SettingsStackedField } from '@/components/sections/shared/SettingsSection';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Input } from '@/components/ui/input';
import { focusDesktopWindow, isDesktopShell, isVSCodeRuntime } from '@/lib/desktop';
import { isMobileSurfaceRuntime } from '@/lib/runtimeSurface';
import { copyTextToClipboard } from '@/lib/clipboard';
import { useI18n } from '@/lib/i18n';
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
import { openExternalUrl } from '@/lib/url';
import { cn } from '@/lib/utils';

type GuestIntegrationCardProps = {
  guest: InstalledGuest;
};

const GuestIntegrationCard: React.FC<GuestIntegrationCardProps> = ({ guest }) => {
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
  const [settings, setSettings] = React.useState<Record<string, string>>({});
  const [copied, setCopied] = React.useState(false);
  const pollTimerRef = React.useRef<number | null>(null);

  const stopWaiting = React.useCallback(() => {
    if (pollTimerRef.current != null) {
      window.clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    setIsWaiting(false);
  }, []);

  React.useEffect(() => {
    void refresh(guest.id);
    return () => {
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
  const connected = Boolean(status?.connection.connected);
  const account = status?.connection.account.trim() || '';
  const statusLabel = isWaiting
    ? t('settings.integrations.guests.status.waiting')
    : connected
      ? (account || t('settings.integrations.guests.status.connected'))
      : t('settings.integrations.guests.status.notConnected');
  const statusClassName = isWaiting
    ? 'bg-[var(--status-warning)]/15 text-[var(--status-warning)]'
    : connected
      ? 'bg-[var(--status-success)]/15 text-[var(--status-success)]'
      : 'bg-[var(--surface-muted)] text-muted-foreground';
  const expanded = isWaiting || open;
  const name = integration.name;

  const saveClient = async (): Promise<boolean> => {
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

  const saveDeclaredSettings = async (): Promise<boolean> => {
    reportSettingsSaveState('saving');
    const saved = await saveGuestSettings(guest.id, settings);
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
    const nextToken = token.trim();
    if (!nextToken) {
      if (connected) {
        return true;
      }
      toast.error(t('settings.integrations.guests.toast.tokenRequired'));
      return false;
    }
    reportSettingsSaveState('saving');
    const saved = await saveGuestAccessToken(guest.id, nextToken);
    if (!saved) {
      reportSettingsSaveState('error');
      toast.error(t('settings.integrations.guests.toast.tokenInvalid'));
      return false;
    }
    setStatus(guest.id, saved);
    setToken('');
    reportSettingsSaveState('saved');
    return true;
  };

  const saveForm = async (): Promise<boolean> => {
    if (auth === 'oauth') {
      const saved = await saveClient();
      if (!saved) {
        return false;
      }
    } else if (auth === 'token' && token.trim()) {
      const saved = await saveToken();
      if (!saved) {
        return false;
      }
    }
    if ((integration.settings ?? []).length > 0) {
      return saveDeclaredSettings();
    }
    return true;
  };

  const startConnect = async (): Promise<void> => {
    stopWaiting();
    setIsBusy(true);
    const previous = status?.connection ?? { connected: false, account: '' };
    try {
      if (auth === 'token') {
        const saved = await saveToken();
        if (saved) {
          if ((integration.settings ?? []).length > 0) {
            await saveDeclaredSettings();
          }
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
          if (Date.now() > deadline) {
            stopWaiting();
            toast.error(t('settings.integrations.guests.toast.authorizationFailed', { name }));
            return;
          }
          const next = await refresh(guest.id);
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
      console.error('Failed to start guest connect:', error);
      toast.error(t('settings.integrations.guests.toast.startFailed', { name }));
      stopWaiting();
    } finally {
      setIsBusy(false);
    }
  };

  const disconnect = async (): Promise<void> => {
    setIsBusy(true);
    try {
      stopWaiting();
      const next = await disconnectGuestOauth(guest.id);
      if (!next) {
        toast.error(t('settings.integrations.guests.toast.disconnectFailed', { name }));
        return;
      }
      setStatus(guest.id, next);
      toast.success(t('settings.integrations.guests.toast.disconnected', { name }));
    } catch (error) {
      console.error('Failed to disconnect guest:', error);
      toast.error(t('settings.integrations.guests.toast.disconnectFailed', { name }));
    } finally {
      setIsBusy(false);
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
    <Collapsible
      open={expanded}
      onOpenChange={(nextOpen) => {
        if (isWaiting) {
          setOpen(true);
          return;
        }
        setOpen(nextOpen);
      }}
    >
      <div className="overflow-hidden rounded-xl border border-[var(--interactive-border)] bg-[var(--surface-elevated)]">
        <CollapsibleTrigger
          className="flex w-full min-w-0 items-center gap-3 px-4 py-3 text-left hover:bg-[var(--interactive-hover)]/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[var(--interactive-focus-ring)]"
        >
          <div className="flex size-10 shrink-0 items-center justify-center rounded-[10px] bg-[var(--surface-muted)]">
            <GuestIcon
              icon={resolveGuestIconName(guest.icon)}
              iconSrc={iconSrc}
              className="size-5 text-foreground"
            />
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold text-foreground">{name}</div>
            <p className="mt-0.5 line-clamp-1 text-xs leading-snug text-muted-foreground">
              {integration.description}
            </p>
          </div>
          <span
            aria-live="polite"
            className={cn('max-w-36 shrink-0 truncate rounded-full px-2 py-0.5 text-[10px] font-medium', statusClassName)}
          >
            {statusLabel}
          </span>
          <Icon
            name="arrow-down-s"
            className={cn(
              'size-4 shrink-0 text-muted-foreground transition-transform duration-150 ease-out motion-reduce:transition-none',
              expanded && 'rotate-180',
            )}
          />
        </CollapsibleTrigger>
        <CollapsibleContent className="border-t border-[var(--interactive-border)] px-4 py-4">
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
              {auth !== 'host' || (integration.settings ?? []).length > 0 ? (
                <Button
                  type="button"
                  size="sm"
                  disabled={isBusy}
                  onClick={() => void saveForm()}
                >
                  {t('settings.integrations.guests.actions.save')}
                </Button>
              ) : null}
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
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
};

export const GuestIntegrationsSection: React.FC<{ divider?: boolean }> = ({ divider = true }) => {
  const { t } = useI18n();
  const guests = useGuestsStore((state) => state.guests);

  React.useEffect(() => {
    void loadGuestCatalog();
  }, []);

  if (isVSCodeRuntime() || isMobileSurfaceRuntime()) {
    return null;
  }

  const cards = guests.filter((guest) => guest.integration);
  if (cards.length === 0) {
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
        <GuestIntegrationCard key={guest.id} guest={guest} />
      ))}
    </SettingsSection>
  );
};
