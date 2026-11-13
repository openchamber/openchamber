import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { GuestIcon } from '@/components/layout/GuestRailIcon';
import { SettingsStackedField } from '@/components/sections/shared/SettingsSection';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { IntegrationCatalogCard, type IntegrationCatalogStatusTone } from './IntegrationCatalogCard';
import { useI18n } from '@/lib/i18n';
import { guestPackageIconSrc, resolveGuestIconName } from '@/lib/guests/icon';
import type { InstalledGuest } from '@/lib/guests/types';
import {
  connectNotificationChannel,
  disconnectNotificationChannel,
  type ConnectChannelFailureCode,
  type ConnectChannelInput,
  type NotificationChannel,
} from '@/lib/notifications/channels';
import { reportSettingsSaveState } from '@/lib/persistence';
import { getRuntimeUrlResolver } from '@/lib/runtime-url';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { openExternalUrl } from '@/lib/url';

/** The origin of a server address typed so far, or null while it is not one yet. */
const typedOrigin = (value: string): string | null => {
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : null;
  } catch {
    return null;
  }
};

type NotificationChannelCardProps = {
  channel: NotificationChannel;
  /** The extension's catalog row, for its icon; the channel delivers without it. */
  guest: InstalledGuest | null;
  onChanged: () => Promise<void>;
};

/**
 * The account of one extension notification channel: where it lives (typed
 * for a `user` instance), the token (and a username for `basic`), Connect and
 * Disconnect. Connecting is the whole switch: an approved extension with an
 * account delivers, one without does not.
 */
export const NotificationChannelCard: React.FC<NotificationChannelCardProps> = ({ channel, guest, onChanged }) => {
  const { t } = useI18n();
  const iconSrc = React.useMemo(
    () => (guest ? guestPackageIconSrc(guest.id, guest.icon, getRuntimeUrlResolver().authenticatedAsset) ?? undefined : undefined),
    [guest],
  );
  const [open, setOpen] = React.useState(false);
  const [isBusy, setIsBusy] = React.useState(false);
  const [instance, setInstance] = React.useState(channel.account?.instance ?? '');
  const [username, setUsername] = React.useState('');
  const [token, setToken] = React.useState('');
  const [ownerRuntimeKey] = React.useState(getRuntimeKey);
  const mountedRef = React.useRef(true);
  const isCurrent = () => mountedRef.current && getRuntimeKey() === ownerRuntimeKey;

  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Connecting again keeps the server the account is on; the user retypes it only to move.
  const storedInstance = channel.account?.instance;
  React.useEffect(() => {
    if (storedInstance) setInstance(storedInstance);
  }, [storedInstance]);

  const { label, instances, token: tokenFormat } = channel.channel;
  const account = channel.account;
  const connected = Boolean(account && account.account.status === 'valid');
  const needsAttention = Boolean(account && account.account.status === 'invalid');
  const needsUsername = tokenFormat.username;
  const accountName = account ? (account.account.name || account.account.login || account.account.id) : '';
  // Where a token is made: on the channel's server, the connected one, or the one typed so far.
  const tokenOrigin = instances.kind === 'fixed' ? instances.origin : (account?.instance ?? typedOrigin(instance));
  const createTokenUrl = tokenFormat.createPath && tokenOrigin ? `${tokenOrigin}${tokenFormat.createPath}` : null;

  const statusLabel = needsAttention
    ? t('settings.integrations.channels.status.invalid')
    : connected
      ? accountName || t('settings.integrations.guests.status.connected')
      : t('settings.integrations.guests.status.notConnected');
  const statusTone: IntegrationCatalogStatusTone = needsAttention ? 'warning' : connected ? 'success' : 'neutral';

  const failureText = (code: ConnectChannelFailureCode, message: string | null): string => {
    switch (code) {
      case 'TOKEN_REFUSED':
        return t('settings.integrations.channels.toast.tokenRefused', { name: label });
      case 'TOKEN_REQUIRED':
        return t('settings.integrations.guests.toast.tokenRequired');
      case 'USERNAME_REQUIRED':
        return t('settings.integrations.guests.toast.usernameRequired');
      case 'USERNAME_INVALID':
        return t('settings.integrations.channels.toast.usernameInvalid', { name: label });
      case 'INSTANCE_REQUIRED':
        return t('settings.integrations.channels.toast.instanceRequired');
      case 'UNSUPPORTED_INSTANCE':
        return message || t('settings.integrations.channels.toast.unsupportedInstance', { name: label });
      case 'CHANNEL_UNAVAILABLE':
        return t('settings.integrations.channels.toast.unavailable', { name: channel.name });
      default:
        return message || t('settings.integrations.channels.toast.connectFailed', { name: label });
    }
  };

  const connect = async (): Promise<void> => {
    if (!isCurrent()) return;
    const nextToken = token.trim();
    if (!nextToken) {
      toast.error(t('settings.integrations.guests.toast.tokenRequired'));
      return;
    }
    if (needsUsername && !username.trim()) {
      toast.error(t('settings.integrations.guests.toast.usernameRequired'));
      return;
    }
    if (instances.kind === 'user' && !instance.trim()) {
      toast.error(t('settings.integrations.channels.toast.instanceRequired'));
      return;
    }
    setIsBusy(true);
    reportSettingsSaveState('saving');
    try {
      const input: ConnectChannelInput = { token: nextToken };
      if (needsUsername) input.username = username.trim();
      if (instances.kind === 'user') input.instance = instance.trim();
      const result = await connectNotificationChannel(channel.providerId, input);
      if (!isCurrent()) return;
      if (!result.ok) {
        reportSettingsSaveState('error');
        toast.error(failureText(result.code, result.message));
        return;
      }
      // The server took the token: it leaves the field, as the guest card's does.
      setToken('');
      setUsername('');
      reportSettingsSaveState('saved');
      toast.success(t('settings.integrations.guests.toast.connected', { name: label }));
      await onChanged();
    } finally {
      if (isCurrent()) setIsBusy(false);
    }
  };

  const disconnect = async (): Promise<void> => {
    if (!isCurrent()) return;
    setIsBusy(true);
    try {
      const removed = await disconnectNotificationChannel(channel.providerId);
      if (!isCurrent()) return;
      if (!removed) {
        toast.error(t('settings.integrations.guests.toast.disconnectFailed', { name: label }));
        return;
      }
      toast.success(t('settings.integrations.guests.toast.disconnected', { name: label }));
      await onChanged();
    } finally {
      if (isCurrent()) setIsBusy(false);
    }
  };

  return (
    <IntegrationCatalogCard
      settingsItem={`integrations.channels.${channel.providerId}`}
      logo={(
        <GuestIcon
          icon={resolveGuestIconName(guest?.icon ?? 'notification-3')}
          iconSrc={iconSrc}
          className="size-5 text-foreground"
        />
      )}
      name={label}
      description={t('settings.integrations.channels.description', { name: channel.name })}
      status={statusLabel}
      statusTone={statusTone}
      open={open}
      onOpenChange={setOpen}
    >
      <div className="space-y-3">
        {account ? (
          <p className="typography-meta text-muted-foreground">
            {t('settings.integrations.channels.account', { account: accountName, instance: account.instance })}
          </p>
        ) : null}
        {needsAttention ? (
          // A written-off account is a problem the user fixes here: it stays visible.
          <p className="typography-meta text-[var(--status-warning)]">
            {account?.account.invalidReason === 'instance-changed'
              ? t('settings.integrations.channels.invalid.movedHint', { name: label })
              : t('settings.integrations.channels.invalid.hint', { name: label })}
          </p>
        ) : null}
        {instances.kind === 'user' ? (
          <SettingsStackedField label={instances.label} controlClassName="w-full max-w-none">
            <Input
              value={instance}
              onChange={(event) => setInstance(event.target.value)}
              placeholder={instances.placeholder ?? 'https://'}
              autoComplete="off"
              spellCheck={false}
              className="h-8 min-w-0 flex-1 rounded-md px-3"
              disabled={isBusy}
            />
          </SettingsStackedField>
        ) : null}
        {needsUsername ? (
          <SettingsStackedField label={t('settings.integrations.guests.field.username')} controlClassName="w-full max-w-none">
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
        <SettingsStackedField
          label={t('settings.integrations.guests.field.token')}
          info={t('settings.integrations.channels.field.token.info')}
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
        {createTokenUrl || tokenFormat.scopes.length > 0 ? (
          <div className="typography-meta flex flex-col items-start gap-0.5 text-muted-foreground">
            {createTokenUrl ? (
              <Button size="xs" variant="link" className="h-auto p-0" onClick={() => void openExternalUrl(createTokenUrl)}>
                {t('settings.sourceControl.token.create')}
              </Button>
            ) : null}
            {tokenFormat.scopes.length > 0 ? (
              <span>
                {t('settings.integrations.channels.field.token.scopes')}{' '}
                <span className="font-mono text-foreground">{tokenFormat.scopes.join(', ')}</span>
              </span>
            ) : null}
          </div>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          {account ? (
            <Button type="button" size="sm" variant="destructive" disabled={isBusy} onClick={() => void disconnect()}>
              {t('settings.integrations.guests.actions.disconnect')}
            </Button>
          ) : null}
          <Button type="button" size="sm" disabled={isBusy} onClick={() => void connect()}>
            {isBusy ? <Icon name="loader-4" className="size-3.5 animate-spin" /> : null}
            {account ? t('settings.integrations.channels.actions.reconnect') : t('settings.integrations.guests.actions.connect')}
          </Button>
        </div>
      </div>
    </IntegrationCatalogCard>
  );
};
