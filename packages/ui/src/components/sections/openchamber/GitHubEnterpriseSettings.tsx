import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { getManagedCredentialSourceLabelKey } from '@/lib/source-control/identity';
import type {
  SourceControlCapabilities,
  SourceControlAPI,
  SourceControlIdentity,
} from '@/lib/api/types';
import {
  SETTINGS_CONTROL_CLUSTER_CLASS,
  SETTINGS_FIELDS_STACK_CLASS,
  SettingsControlGroup,
  SettingsFieldRow,
} from '@/components/sections/shared/SettingsSection';
import { getRuntimeKey, subscribeRuntimeEndpointWillChange } from '@/lib/runtime-switch';
import { useSourceControlAuthEntry, useSourceControlAuthStore } from '@/stores/useSourceControlAuthStore';
import { SourceControlAccountList } from './SourceControlAccountList';

/** Sub-block inside the card body, same row chrome the GitLab card uses for its instances. */
const INSTANCE_BLOCK_CLASS = 'overflow-hidden rounded-md border border-[var(--surface-subtle)] bg-[var(--surface-muted)]';
const INSTANCE_ROW_CLASS = 'px-3 py-3';
const INSTANCE_ROW_DIVIDER_CLASS = 'border-t border-[var(--surface-subtle)]';

/**
 * The instance field accepts what the server's github normalization does: a host
 * or an https:// origin without user info, port, query or path. github.com
 * itself is the gh-carded connect and is refused here so it cannot be added
 * twice.
 */
const normalizeGitHubEnterpriseIdentity = (value: string): SourceControlIdentity | null => {
  const trimmed = value.trim().toLowerCase().replace(/\.$/, '');
  let host = trimmed;
  if (trimmed.includes('://')) {
    try {
      const url = new URL(trimmed);
      if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash
        || (url.pathname && url.pathname !== '/')) {
        return null;
      }
      host = url.hostname.toLowerCase().replace(/\.$/, '');
    } catch {
      return null;
    }
  }
  if (!host || host === 'github.com') return null;
  return { provider: 'github', instance: host };
};

interface GitHubEnterpriseInstanceItemProps {
  identity: SourceControlIdentity;
  sourceControl: SourceControlAPI;
  onSaved?: () => void;
}

const GitHubEnterpriseInstanceItem: React.FC<GitHubEnterpriseInstanceItemProps> = ({ identity, sourceControl, onSaved }) => {
  const { t } = useI18n();
  const refreshInstances = useSourceControlAuthStore((state) => state.refreshInstances);
  const refreshStatus = useSourceControlAuthStore((state) => state.refreshStatus);
  const setStatus = useSourceControlAuthStore((state) => state.setStatus);
  const authEntry = useSourceControlAuthEntry(identity);
  const [capabilities, setCapabilities] = React.useState<SourceControlCapabilities | null>(null);
  const [capabilitiesFailed, setCapabilitiesFailed] = React.useState(false);
  const [capabilitiesAttempt, setCapabilitiesAttempt] = React.useState(0);
  const [token, setToken] = React.useState('');
  const [isAddingAccount, setIsAddingAccount] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [operationFailed, setOperationFailed] = React.useState(false);
  const [tokenRejected, setTokenRejected] = React.useState(false);
  const runtimeGenerationRef = React.useRef(0);
  const captureRuntime = React.useCallback(() => {
    const runtimeKey = getRuntimeKey();
    const generation = runtimeGenerationRef.current;
    return () => generation === runtimeGenerationRef.current && runtimeKey === getRuntimeKey();
  }, []);
  const status = authEntry?.status ?? null;
  const accounts = status?.accounts ?? [];
  const cli = status && 'cli' in status ? status.cli : undefined;

  React.useEffect(() => {
    const unsubscribe = subscribeRuntimeEndpointWillChange(() => {
      runtimeGenerationRef.current += 1;
    });
    return () => {
      runtimeGenerationRef.current += 1;
      unsubscribe();
    };
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    const isCurrentRuntime = captureRuntime();
    setCapabilitiesFailed(false);
    void Promise.all([
      sourceControl.capabilities(identity),
      refreshStatus(sourceControl, identity),
    ]).then(([nextCapabilities]) => {
      if (!cancelled && isCurrentRuntime()) setCapabilities(nextCapabilities);
    }).catch(() => {
      if (!cancelled && isCurrentRuntime()) setCapabilitiesFailed(true);
    });
    return () => { cancelled = true; };
  }, [capabilitiesAttempt, captureRuntime, identity, refreshStatus, sourceControl]);

  const saveToken = async () => {
    if (!token.trim()) return;
    const isCurrentRuntime = captureRuntime();
    setBusy(true);
    setOperationFailed(false);
    setTokenRejected(false);
    try {
      const nextStatus = await sourceControl.authSetToken(identity, token.trim());
      if (!isCurrentRuntime()) return;
      setStatus(identity, nextStatus);
      setToken('');
      setIsAddingAccount(false);
      await refreshStatus(sourceControl, identity, { force: true });
      if (!isCurrentRuntime()) return;
      await refreshInstances(sourceControl, { force: true });
      if (!isCurrentRuntime()) return;
      onSaved?.();
    } catch (error) {
      if (!isCurrentRuntime()) return;
      // The server says whether the token itself was refused; anything else is
      // a failure the person cannot fix by editing what they pasted.
      if (error instanceof Error && 'code' in error && error.code === 'INVALID_TOKEN') setTokenRejected(true);
      else setOperationFailed(true);
    } finally {
      if (isCurrentRuntime()) setBusy(false);
    }
  };

  const removeAccount = async (accountId: string) => {
    const isCurrentRuntime = captureRuntime();
    setBusy(true);
    setOperationFailed(false);
    setTokenRejected(false);
    try {
      await sourceControl.authDisconnect(identity, accountId);
      if (!isCurrentRuntime()) return;
      await refreshStatus(sourceControl, identity, { force: true });
      if (!isCurrentRuntime()) return;
      await refreshInstances(sourceControl, { force: true });
    } catch {
      if (isCurrentRuntime()) setOperationFailed(true);
    } finally {
      if (isCurrentRuntime()) setBusy(false);
    }
  };

  const switchToAccount = async (accountId: string) => {
    const isCurrentRuntime = captureRuntime();
    setBusy(true);
    setOperationFailed(false);
    setTokenRejected(false);
    try {
      const nextStatus = await sourceControl.authActivate(identity, accountId);
      if (isCurrentRuntime()) setStatus(identity, nextStatus);
    } catch {
      if (isCurrentRuntime()) setOperationFailed(true);
    } finally {
      if (isCurrentRuntime()) setBusy(false);
    }
  };

  const toggleCli = async () => {
    if (!cli) return;
    const isCurrentRuntime = captureRuntime();
    setBusy(true);
    setOperationFailed(false);
    setTokenRejected(false);
    try {
      await sourceControl.authSetCliDisabled(identity, !cli.disabled);
      if (!isCurrentRuntime()) return;
      await refreshStatus(sourceControl, identity, { force: true });
    } catch {
      if (isCurrentRuntime()) setOperationFailed(true);
    } finally {
      if (isCurrentRuntime()) setBusy(false);
    }
  };

  const connected = accounts.length > 0;
  const showConnectionMethods = !connected || isAddingAccount;

  let statusMessage: string | null;
  if (authEntry?.isLoading) {
    statusMessage = t('settings.sourceControl.status.checking');
  } else if (tokenRejected) {
    statusMessage = t('settings.github.enterprise.status.tokenRejected');
  } else if (operationFailed || capabilitiesFailed || status?.status === 'unreachable') {
    statusMessage = t('settings.github.enterprise.status.operationFailed');
  } else if (accounts.length > 0) {
    statusMessage = null;
  } else {
    statusMessage = t('settings.github.enterprise.status.notConnected');
  }

  return (
    <div className={INSTANCE_BLOCK_CLASS}>
      <div className={cn(INSTANCE_ROW_CLASS, 'flex items-start justify-between gap-4')}>
        <div className="min-w-0">
          <div className="typography-ui-label truncate text-foreground">{identity.instance}</div>
          {statusMessage ? (
            <div className="typography-meta mt-0.5 text-muted-foreground">
              {statusMessage}
            </div>
          ) : null}
        </div>
        {capabilitiesFailed || status?.status === 'unreachable' ? (
          <Button size="sm" variant="outline" disabled={busy || authEntry?.isLoading} onClick={() => setCapabilitiesAttempt((attempt) => attempt + 1)}>
            {t('sessionAuth.error.retry')}
          </Button>
        ) : null}
      </div>

      {accounts.length > 0 ? (
        <div className={cn(INSTANCE_ROW_CLASS, INSTANCE_ROW_DIVIDER_CLASS)}>
          <SourceControlAccountList
            accounts={accounts}
            avatarAlt={(username) => username}
            currentLabel={t('settings.sourceControl.accounts.inUse')}
            sourceLabel={(account) => t(account.source === 'cli' ? 'settings.github.enterprise.cli.label' : getManagedCredentialSourceLabelKey(account.source))}
            statusLabel={(account) => account.status === 'valid'
              ? null
              : t('settings.sourceControl.accounts.needsAuthentication')}
            renderActions={(account) => (
              <>
                {account.status === 'invalid' && account.source !== 'cli' ? (
                  <Button size="sm" variant="outline" onClick={() => setIsAddingAccount(true)} disabled={busy}>
                    {t('settings.sourceControl.actions.reauthenticate')}
                  </Button>
                ) : null}
                {/* The gh login is used only after a switch to it; the header switcher is not there while nothing is connected. */}
                {account.source === 'cli' && !account.current ? (
                  <Button size="sm" variant="outline" onClick={() => void switchToAccount(account.id)} disabled={busy}>
                    {t('settings.github.enterprise.actions.useCli')}
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => account.source === 'cli' ? toggleCli() : removeAccount(account.id)}
                  disabled={busy}
                >
                  {account.source === 'cli' ? t('settings.github.enterprise.actions.disableCli') : t('settings.sourceControl.actions.remove')}
                </Button>
              </>
            )}
          />
        </div>
      ) : null}

      {connected && !isAddingAccount && (
        <div className={cn(INSTANCE_ROW_CLASS, INSTANCE_ROW_DIVIDER_CLASS)}>
          <Button size="sm" variant="outline" onClick={() => setIsAddingAccount(true)} disabled={busy}>
            {t('settings.github.page.actions.addAccount')}
          </Button>
        </div>
      )}

      {showConnectionMethods && (
        <div className={cn(SETTINGS_FIELDS_STACK_CLASS, INSTANCE_ROW_CLASS, INSTANCE_ROW_DIVIDER_CLASS)}>
          {capabilities?.authenticationMethods.pat.available && (
            <SettingsFieldRow label={t('settings.github.enterprise.token.label')} info={t('settings.github.enterprise.token.info')}>
              <div className={`${SETTINGS_CONTROL_CLUSTER_CLASS} flex flex-col gap-2 @xl:flex-row @xl:items-center`}>
                <Input
                  className="h-8 w-full min-w-0 rounded-md"
                  type="password"
                  value={token}
                  onChange={(event) => setToken(event.target.value)}
                  aria-label={t('settings.github.enterprise.token.label')}
                />
                <Button className="w-full @xl:w-auto" size="sm" onClick={saveToken} disabled={busy || !token.trim()}>{t('settings.common.actions.saveChanges')}</Button>
              </div>
            </SettingsFieldRow>
          )}
          {isAddingAccount && (
            <div className="flex justify-end">
              <Button size="sm" variant="ghost" onClick={() => {
                setIsAddingAccount(false);
                setToken('');
                setOperationFailed(false);
                setTokenRejected(false);
              }} disabled={busy}>
                {t('settings.common.actions.cancel')}
              </Button>
            </div>
          )}
        </div>
      )}

      {/* While the gh login is listed, its own row carries the switch; before any
          account connects the account row's Use offer turns this host's gh on,
          the same offer the GitLab card makes for glab. */}
      {(connected || cli?.disabled) && cli && (cli.available || cli.disabled)
        && (cli.disabled || !accounts.some((account) => account.source === 'cli')) && (
        <div className={cn(INSTANCE_ROW_CLASS, INSTANCE_ROW_DIVIDER_CLASS)}>
          <SettingsFieldRow label={t('settings.github.enterprise.cli.label')} info={t('settings.github.enterprise.cli.info')}>
            <Button size="sm" variant="outline" onClick={toggleCli} disabled={busy}>
              {cli.disabled ? t('settings.github.enterprise.actions.enableCli') : t('settings.github.enterprise.actions.disableCli')}
            </Button>
          </SettingsFieldRow>
        </div>
      )}
    </div>
  );
};

/**
 * The GitHub Enterprise instances group of Settings → Integrations → Built-in
 * integrations, inside the GitHub card. Same instance blocks, account rows and
 * wording as the GitLab card beside it: an instance connects with a personal
 * access token, lists its accounts, and offers the gh login through an explicit
 * per-host Use offer, so both providers feel identical.
 */
export const GitHubEnterpriseSettings: React.FC = () => {
  const { t } = useI18n();
  const sourceControl = getRegisteredRuntimeAPIs()?.sourceControl;
  const identities = useSourceControlAuthStore((state) => state.identities);
  const [instanceInput, setInstanceInput] = React.useState('');
  const [isAddingInstance, setIsAddingInstance] = React.useState(false);
  const [instanceFailed, setInstanceFailed] = React.useState(false);
  const [pendingIdentity, setPendingIdentity] = React.useState<SourceControlIdentity | null>(null);
  const clearPendingIdentity = React.useCallback(() => setPendingIdentity(null), []);
  const refreshInstances = useSourceControlAuthStore((state) => state.refreshInstances);
  const enterpriseIdentities = identities.filter((item) => item.provider === 'github' && item.instance !== 'github.com');
  const visibleIdentities = pendingIdentity && !enterpriseIdentities.some((item) => item.instance === pendingIdentity.instance)
    ? [...enterpriseIdentities, pendingIdentity]
    : [...enterpriseIdentities];

  React.useEffect(() => {
    if (sourceControl) void refreshInstances(sourceControl);
  }, [refreshInstances, sourceControl]);

  const applyInstance = () => {
    const normalized = normalizeGitHubEnterpriseIdentity(instanceInput);
    if (!normalized) {
      setInstanceFailed(true);
      return;
    }
    setPendingIdentity(normalized);
    setInstanceInput('');
    setIsAddingInstance(false);
    setInstanceFailed(false);
  };

  if (!sourceControl) return null;

  return (
    <SettingsControlGroup
      title={t('settings.github.enterprise.instances.title')}
      contentClassName="space-y-3"
      settingsItem="git.github-enterprise-connect"
    >
      {visibleIdentities.length > 0 ? visibleIdentities.map((item) => (
        <GitHubEnterpriseInstanceItem
          key={`${getRuntimeKey()}:${item.instance}`}
          identity={item}
          sourceControl={sourceControl}
          onSaved={pendingIdentity?.instance === item.instance ? clearPendingIdentity : undefined}
        />
      )) : null}

      {isAddingInstance ? (
        <div className={cn(INSTANCE_BLOCK_CLASS, INSTANCE_ROW_CLASS)}>
          <SettingsFieldRow
            label={t('settings.github.enterprise.instance.customLabel')}
            info={t('settings.github.enterprise.instance.customInfo')}
            description={instanceFailed ? t('settings.github.enterprise.status.operationFailed') : undefined}
          >
            <div className={`${SETTINGS_CONTROL_CLUSTER_CLASS} flex flex-col gap-2 @xl:flex-row @xl:items-center`}>
              <Input
                className="h-8 w-full min-w-0 rounded-md"
                value={instanceInput}
                onChange={(event) => setInstanceInput(event.target.value)}
                placeholder="https://github.example.com"
                aria-label={t('settings.github.enterprise.instance.customLabel')}
              />
              <Button className="w-full @xl:w-auto" size="sm" onClick={applyInstance}>{t('settings.github.enterprise.actions.useInstance')}</Button>
              <Button className="w-full @xl:w-auto" size="sm" variant="ghost" onClick={() => {
                setInstanceInput('');
                setIsAddingInstance(false);
                setInstanceFailed(false);
              }}>
                {t('settings.common.actions.cancel')}
              </Button>
            </div>
          </SettingsFieldRow>
        </div>
      ) : (
        <Button size="sm" variant="outline" onClick={() => setIsAddingInstance(true)}>
          {t('settings.github.enterprise.actions.addInstance')}
        </Button>
      )}
    </SettingsControlGroup>
  );
};
