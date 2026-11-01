import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui';
import { GuestIcon } from '@/components/layout/GuestRailIcon';
import { SettingsChipGroup, SettingsStackedField } from '@/components/sections/shared/SettingsSection';
import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { useTrackerAuthEntry, useTrackerAuthStore } from '@/stores/useTrackerAuthStore';
import type { TrackerAuthStatus, TrackerConnectResult, TrackerConnectTokenInput, TrackerDescriptor } from '@/lib/api/types';
import type { PublicTracker } from '@openchamber/sdk';
import type { InstalledGuest } from '@/lib/guests/types';
import { guestPackageIconSrc, resolveGuestIconName } from '@/lib/guests/icon';
import { getRuntimeUrlResolver } from '@/lib/runtime-url';
import { trackerPresentation } from '@/lib/trackers/presentation';
import { copyTextToClipboard } from '@/lib/clipboard';
import { openExternalUrl } from '@/lib/url';
import { reportSettingsSaveState } from '@/lib/persistence';
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
  const accounts = status?.accounts ?? [];
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

/** The origin of a server address typed so far, or null while it is not one yet. */
const typedOrigin = (value: string): string | null => {
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : null;
  } catch {
    return null;
  }
};

/** An extension's tracker: its catalog row, for the icon and the name, and the public slice of its contribution. */
export type TrackerSettingsExtension = { guest: InstalledGuest; tracker: PublicTracker };

type TrackerSettingsProps = {
  descriptor: TrackerDescriptor;
  /** Present for an extension tracker, drawn under Extension accounts; absent for a built-in one. */
  extension?: TrackerSettingsExtension;
};

/**
 * One tracker on Settings → Integrations, drawn from the descriptor the server
 * serves: connect through the browser and wait for the account to appear,
 * disconnect, and switch between accounts where the tracker keeps several
 * (`multipleAccounts`). Project mapping and session comments show where the
 * tracker's capabilities offer them.
 *
 * An extension tracker (`extension` given) is the same card with the ways in
 * its manifest declares: a pasted token (with a username for `basic`), the
 * browser sign-in once the user saved the OAuth client it registered, and the
 * server address first when the accounts live on a server the user names.
 * Everything the card learns about accounts comes back through the status;
 * no token or client secret ever returns from the server.
 */
export const TrackerSettings: React.FC<TrackerSettingsProps> = ({ descriptor, extension }) => {
  const { t } = useI18n();
  const trackers = getRegisteredRuntimeAPIs()?.trackers;
  const providerId = descriptor.id;
  const provider = descriptor.name;
  const copy = trackerSettingsCopy(providerId);
  const { capabilities } = descriptor;
  const { status, isLoading, hasChecked } = useTrackerAuthEntry(providerId);
  const refreshTrackerStatus = useTrackerAuthStore((state) => state.refreshStatus);
  const setTrackerStatus = useTrackerAuthStore((state) => state.setStatus);
  const iconSrc = React.useMemo(
    () => (extension ? guestPackageIconSrc(extension.guest.id, extension.guest.icon, getRuntimeUrlResolver().authenticatedAsset) ?? undefined : undefined),
    [extension],
  );

  const [isBusy, setIsBusy] = React.useState(false);
  const [isWaiting, setIsWaiting] = React.useState(false);
  const [open, setOpen] = React.useState(false);
  const [instance, setInstance] = React.useState('');
  const [username, setUsername] = React.useState('');
  const [token, setToken] = React.useState('');
  const [clientId, setClientId] = React.useState('');
  const [clientSecret, setClientSecret] = React.useState('');
  const [copied, setCopied] = React.useState(false);
  // An extension tracker that takes both ways in shows one form at a time; browser sign-in first, as the descriptor orders them.
  const [method, setMethod] = React.useState<'oauth' | 'token'>(descriptor.authMethods.includes('oauth') ? 'oauth' : 'token');
  // Another account's form opens on Add account; while one is connected the card stays quiet.
  const [adding, setAdding] = React.useState(false);
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

  const connect = status?.connect;
  const takesToken = Boolean(extension) && descriptor.authMethods.includes('token');
  const takesOauth = descriptor.authMethods.includes('oauth');
  // The server an extension tracker's accounts live on: fixed by the manifest,
  // the one connected, or the one typed before the first account.
  const needsInstance = Boolean(extension) && connect?.instances.kind === 'user' && !connect.instance;
  const instanceOrigin = connect?.instance ?? (needsInstance ? typedOrigin(instance) : null);
  const tokenFormat = extension?.tracker.token;
  const needsUsername = takesToken && tokenFormat?.username === true;
  const createTokenUrl = tokenFormat?.createPath && instanceOrigin ? `${instanceOrigin}${tokenFormat.createPath}` : null;

  const failureText = React.useCallback((result: Extract<TrackerConnectResult, { ok: false }>): string => {
    switch (result.code) {
      case 'TOKEN_REQUIRED': return t('settings.integrations.tracker.toast.tokenRequired');
      case 'TOKEN_REFUSED': return t('settings.integrations.tracker.toast.tokenRefused', { provider });
      case 'USERNAME_REQUIRED': return t('settings.integrations.tracker.toast.usernameRequired');
      case 'USERNAME_INVALID': return t('settings.integrations.tracker.toast.usernameInvalid', { provider });
      case 'INSTANCE_REQUIRED': return t('settings.integrations.tracker.toast.instanceRequired');
      case 'INSTANCE_MISMATCH': return t('settings.integrations.tracker.toast.instanceMismatch');
      case 'UNSUPPORTED_INSTANCE': return result.message || t('settings.integrations.tracker.toast.unsupportedInstance', { provider });
      case 'CLIENT_MISSING': return t('settings.integrations.tracker.toast.clientRequired');
      case 'TRACKER_UNAVAILABLE': return t('settings.integrations.tracker.toast.unavailable', { provider });
      case 'CONNECT_SUPERSEDED': return t('settings.integrations.tracker.toast.superseded');
      default: return result.message || t('settings.integrations.tracker.toast.connectFailed', { provider });
    }
  }, [provider, t]);

  /** The instance the connect routes take: only while the card asks for one. */
  const instanceInput = needsInstance ? instance.trim() || undefined : undefined;

  const startConnect = React.useCallback(async () => {
    if (!trackers) return;
    stopWaiting();
    setIsBusy(true);
    const previous = snapshotAccounts(useTrackerAuthStore.getState().entries[providerId]?.status ?? null);
    try {
      if (extension) {
        if (needsInstance && !instance.trim()) {
          toast.error(t('settings.integrations.tracker.toast.instanceRequired'));
          return;
        }
        // The client the user registered goes first; an empty id keeps the saved one.
        const nextClientId = clientId.trim();
        if (nextClientId || !connect?.hasClient) {
          if (!nextClientId) {
            toast.error(t('settings.integrations.tracker.toast.clientRequired'));
            return;
          }
          reportSettingsSaveState('saving');
          const saved = await trackers.authSaveOAuthClient(providerId, { instance: instanceInput, clientId: nextClientId, clientSecret: clientSecret.trim() || undefined });
          if (!saved.ok) {
            reportSettingsSaveState('error');
            toast.error(failureText(saved));
            return;
          }
          reportSettingsSaveState('saved');
          setClientSecret('');
        }
      }
      const payload = await trackers.authStart(providerId, isDesktopShell() ? 'desktop' : 'web', { instance: instanceInput });
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
            setClientId('');
            setAdding(false);
            toast.success(t(copy.toastConnected, { provider }));
            void focusDesktopWindow();
          }
        })();
      }, AUTHORIZATION_POLL_MS);
    } catch (error) {
      // An extension tracker refuses a start with its own reason (a full tracker, another server): show it.
      toast.error(t(copy.toastStartConnectFailed, { provider }), extension && error instanceof Error && error.message ? { description: error.message } : undefined);
      stopWaiting();
    } finally {
      setIsBusy(false);
    }
  }, [clientId, clientSecret, connect?.hasClient, copy, extension, failureText, instance, instanceInput, needsInstance, provider, providerId, refreshTrackerStatus, stopWaiting, t, trackers]);

  const connectToken = React.useCallback(async () => {
    if (!trackers) return;
    const nextToken = token.trim();
    if (!nextToken) {
      toast.error(t('settings.integrations.tracker.toast.tokenRequired'));
      return;
    }
    if (needsUsername && !username.trim()) {
      toast.error(t('settings.integrations.tracker.toast.usernameRequired'));
      return;
    }
    if (needsInstance && !instance.trim()) {
      toast.error(t('settings.integrations.tracker.toast.instanceRequired'));
      return;
    }
    setIsBusy(true);
    reportSettingsSaveState('saving');
    try {
      const input: TrackerConnectTokenInput = { token: nextToken };
      if (needsUsername) input.username = username.trim();
      if (needsInstance) input.instance = instance.trim();
      const result = await trackers.authConnectToken(providerId, input);
      if (!result.ok) {
        reportSettingsSaveState('error');
        toast.error(failureText(result));
        return;
      }
      // The server took the token: it leaves the field.
      setToken('');
      setUsername('');
      setAdding(false);
      reportSettingsSaveState('saved');
      await refreshTrackerStatus(trackers, providerId, { force: true });
      toast.success(t(copy.toastConnected, { provider }));
    } finally {
      setIsBusy(false);
    }
  }, [copy, failureText, instance, needsInstance, needsUsername, provider, providerId, refreshTrackerStatus, t, token, trackers, username]);

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

  const copyRedirect = async (): Promise<void> => {
    const uri = connect?.redirectUri ?? '';
    if (!uri) return;
    const result = await copyTextToClipboard(uri);
    if (!result.ok) return;
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  if (!trackers) return null;

  const icon = trackerPresentation(providerId).icon;
  // Browser sign-in is the one method a built-in draws; one that only takes
  // another asks for an update instead of showing a dead Connect. An extension
  // tracker draws every method its manifest declares.
  const canConnect = takesOauth || takesToken;
  const connected = Boolean(status?.connected);
  const account = status?.connected ? status.account ?? null : null;
  const user = account?.user;
  // Disconnected with stored accounts: every one of them was written off (the server refused its credential).
  const storedAccounts = status?.accounts ?? [];
  const needsAttention = account?.status === 'invalid' || (!connected && storedAccounts.some((entry) => entry.status === 'invalid'));
  const otherAccounts = capabilities.multipleAccounts && status?.connected
    ? (status.accounts ?? []).filter((entry) => !entry.current)
    : [];
  const displayName = user?.name?.trim() || t(copy.unknownUser);
  // A built-in's account name is the workspace; an extension's is the person again, so it shows once.
  const workspaceName = account?.name?.trim() && account.name.trim() !== displayName ? account.name.trim() : null;
  const writtenOff = !connected ? storedAccounts.find((entry) => entry.status === 'invalid') ?? null : null;
  const statusLabel = isWaiting
    ? t(copy.waiting)
    : isLoading && !hasChecked
      ? t('common.loading')
      : needsAttention
        ? t('settings.integrations.tracker.status.invalid')
        : connected
          ? (account?.name?.trim() || t(copy.connected))
          : t(copy.notConnected);
  const expanded = isWaiting || open;
  const settingsItem = `integrations.${providerId}`;
  // An extension tracker's forms: always while nobody is connected, and for
  // another account once the user asks for one (a tracker with several).
  const showForms = Boolean(extension) && (!connected || (capabilities.multipleAccounts && adding));
  const bothMethods = takesOauth && takesToken;
  const formMethod: 'oauth' | 'token' = !takesToken ? 'oauth' : !takesOauth ? 'token' : method;
  const fieldClass = 'h-8 min-w-0 flex-1 rounded-md px-3';

  const connectForms = showForms ? (
    <div className="space-y-3">
      {bothMethods ? (
        <SettingsChipGroup
          aria-label={t('settings.integrations.tracker.method.label')}
          value={formMethod}
          onChange={setMethod}
          options={[
            { value: 'oauth', label: t('settings.integrations.tracker.method.oauth') },
            { value: 'token', label: t('settings.integrations.tracker.method.token') },
          ]}
        />
      ) : null}
      {needsInstance && connect?.instances.kind === 'user' ? (
        <SettingsStackedField label={connect.instances.label} controlClassName="w-full max-w-none">
          <Input
            value={instance}
            onChange={(event) => setInstance(event.target.value)}
            placeholder={connect.instances.placeholder ?? 'https://'}
            autoComplete="off"
            spellCheck={false}
            className={fieldClass}
            disabled={isBusy || isWaiting}
          />
        </SettingsStackedField>
      ) : null}
      {formMethod === 'oauth' && !connect?.hasClient ? (
        <>
          <SettingsStackedField label={t('settings.integrations.tracker.field.clientId')} controlClassName="w-full max-w-none">
            <Input value={clientId} onChange={(event) => setClientId(event.target.value)} autoComplete="off" spellCheck={false} className={fieldClass} disabled={isBusy || isWaiting} />
          </SettingsStackedField>
          <SettingsStackedField label={t('settings.integrations.tracker.field.clientSecret')} controlClassName="w-full max-w-none">
            <Input type="password" value={clientSecret} onChange={(event) => setClientSecret(event.target.value)} autoComplete="off" spellCheck={false} className={fieldClass} disabled={isBusy || isWaiting} />
          </SettingsStackedField>
          {connect?.redirectUri ? (
            <SettingsStackedField
              label={t('settings.integrations.tracker.field.redirectUri')}
              info={t('settings.integrations.tracker.field.redirectUri.info', { provider })}
              controlClassName="w-full max-w-none"
            >
              <Input value={connect.redirectUri} readOnly className={fieldClass} />
              <Button type="button" size="sm" variant="outline" onClick={() => void copyRedirect()}>
                {copied ? t('settings.integrations.tracker.actions.copied') : t('settings.integrations.tracker.actions.copyRedirect')}
              </Button>
            </SettingsStackedField>
          ) : null}
        </>
      ) : null}
      {formMethod === 'token' ? (
        <>
          {needsUsername ? (
            <SettingsStackedField label={t('settings.integrations.tracker.field.username')} controlClassName="w-full max-w-none">
              <Input value={username} onChange={(event) => setUsername(event.target.value)} autoComplete="off" spellCheck={false} className={fieldClass} disabled={isBusy} />
            </SettingsStackedField>
          ) : null}
          <SettingsStackedField
            label={t('settings.integrations.tracker.field.token')}
            info={t('settings.integrations.tracker.field.token.info', { provider })}
            controlClassName="w-full max-w-none"
          >
            <Input type="password" value={token} onChange={(event) => setToken(event.target.value)} autoComplete="off" spellCheck={false} className={fieldClass} disabled={isBusy} />
          </SettingsStackedField>
          {createTokenUrl || (tokenFormat?.scopes.length ?? 0) > 0 ? (
            <div className="typography-meta flex flex-col items-start gap-0.5 text-muted-foreground">
              {createTokenUrl ? (
                <Button size="xs" variant="link" className="h-auto p-0" onClick={() => void openExternalUrl(createTokenUrl)}>
                  {t('settings.sourceControl.token.create')}
                </Button>
              ) : null}
              {tokenFormat && tokenFormat.scopes.length > 0 ? (
                <span>
                  {t('settings.integrations.tracker.field.token.scopes')}{' '}
                  <span className="font-mono text-foreground">{tokenFormat.scopes.join(', ')}</span>
                </span>
              ) : null}
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  ) : null;

  /** Add account: a built-in, or an extension whose only step left is the browser, signs in at once; otherwise the form opens. */
  const addAccount = () => {
    if (!extension || (formMethod === 'oauth' && !bothMethods && connect?.hasClient && !needsInstance)) {
      void startConnect();
      return;
    }
    setAdding(true);
  };

  const connectButtons = (
    <div className="flex flex-wrap items-center gap-2">
      {showForms ? (
        <Button
          type="button"
          size="sm"
          variant="default"
          onClick={() => void (formMethod === 'token' ? connectToken() : startConnect())}
          disabled={isBusy || isWaiting || (isLoading && !hasChecked)}
        >
          {isBusy ? <Icon name="loader-4" className="size-3.5 animate-spin" /> : null}
          {t(copy.connect, { provider })}
        </Button>
      ) : null}
      {!extension && takesOauth && !connected ? (
        <Button type="button" size="sm" variant="default" onClick={() => void startConnect()} disabled={isBusy || isWaiting || (isLoading && !hasChecked)}>
          {isBusy ? <Icon name="loader-4" className="size-3.5 animate-spin" /> : null}
          {t(copy.connect, { provider })}
        </Button>
      ) : null}
      {connected && capabilities.multipleAccounts && canConnect && !showForms ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={addAccount}
          disabled={isBusy || isWaiting}
          data-settings-item={`${settingsItem}.add-workspace`}
        >
          {t(copy.addAccount, { provider })}
        </Button>
      ) : null}
      {connected && showForms ? (
        <Button type="button" size="sm" variant="ghost" onClick={() => { stopWaiting(); setAdding(false); }} disabled={isBusy}>
          {t('settings.common.actions.cancel')}
        </Button>
      ) : null}
      {connected || storedAccounts.length > 0 ? (
        // Disconnect also removes a written-off account, which frees the server for another one.
        <Button type="button" size="sm" variant="destructive" onClick={() => void disconnect()} disabled={isBusy}>
          {t(copy.disconnect)}
        </Button>
      ) : null}
    </div>
  );

  return (
    <IntegrationCatalogCard
      settingsItem={settingsItem}
      logo={extension ? (
        <GuestIcon icon={resolveGuestIconName(extension.guest.icon)} iconSrc={iconSrc} className="size-5 text-foreground" />
      ) : (
        <Icon name={icon} className="size-5 text-foreground" />
      )}
      name={provider}
      description={extension ? t('settings.integrations.tracker.extension.description', { name: extension.guest.name }) : t(copy.description, { provider })}
      status={statusLabel}
      statusTone={isWaiting ? 'warning' : needsAttention ? 'warning' : connected ? 'success' : 'neutral'}
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
              {workspaceName ? <p className="mt-0.5 truncate text-xs text-muted-foreground">{workspaceName}</p> : null}
              {connect?.instance ? (
                <p className="mt-0.5 truncate text-xs text-muted-foreground">{t('settings.integrations.tracker.account.instance', { instance: connect.instance })}</p>
              ) : null}
            </div>
          </div>
        ) : isWaiting ? (
          <p className="text-xs text-muted-foreground">{t(copy.flowDescription, { provider })}</p>
        ) : null}
        {needsAttention ? (
          // A written-off account is a problem the user fixes here: it stays visible, with the server it was on.
          <div className="space-y-0.5">
            {writtenOff?.name ? <div className="truncate text-sm font-medium text-foreground">{writtenOff.name}</div> : null}
            {!connected && connect?.instance ? (
              <p className="truncate text-xs text-muted-foreground">{t('settings.integrations.tracker.account.instance', { instance: connect.instance })}</p>
            ) : null}
            <p className="typography-meta text-[var(--status-warning)]">{t('settings.integrations.tracker.invalid.hint', { provider })}</p>
          </div>
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
                        {entry.status === 'invalid' ? (
                          <p className="truncate text-xs text-[var(--status-warning)]">{t('settings.integrations.tracker.status.invalid')}</p>
                        ) : entry.user?.name && entry.user.name !== entry.name ? (
                          <p className="truncate text-xs text-muted-foreground">{entry.user.name}</p>
                        ) : null}
                      </div>
                      <Button type="button" size="sm" variant="ghost" onClick={() => void activateAccount(entry.id)} disabled={isBusy || entry.status === 'invalid'}>
                        {t(copy.switchTo)}
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
            {connectForms}
            {connectButtons}
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
          <>
            {connectForms}
            {connectButtons}
          </>
        ) : (
          <p className="typography-meta text-muted-foreground">{t(copy.unsupportedSignIn, { provider })}</p>
        )}
      </div>
    </IntegrationCatalogCard>
  );
};
