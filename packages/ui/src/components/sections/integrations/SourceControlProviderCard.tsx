import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ProviderIcon } from '@/components/sourceControl/ProviderIcon';
import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { useI18n } from '@/lib/i18n';
import type { SourceControlIdentity } from '@/lib/api/types';
import type { SourceControlProviderDescriptor } from '@/lib/source-control/providers/descriptor';
import { getRuntimeKey } from '@/lib/runtime-switch';
import {
  SETTINGS_CONTROL_CLUSTER_CLASS,
  SettingsControlGroup,
  SettingsFieldRow,
} from '@/components/sections/shared/SettingsSection';
import { getSourceControlAuthKey, useSourceControlAuthStore } from '@/stores/useSourceControlAuthStore';
import { GitHubComAccountSection } from '@/components/sections/openchamber/GitHubComAccountSection';
import { ProviderInstanceAccounts } from '@/components/sections/openchamber/ProviderInstanceAccounts';
import {
  hasUnknownSettingsField,
  normalizeInstanceInput,
  providerSettingsCopy,
} from '@/components/sections/openchamber/sourceControlProviderSettings';
import { IntegrationCatalogCard } from './IntegrationCatalogCard';

/**
 * One source-control provider on Settings → Integrations → Built-in
 * integrations, drawn from the descriptor the server serves: the collapsed row
 * answers "am I connected?" across every instance of the provider, the body
 * lists each instance with its accounts.
 *
 * A provider with a special first-party flow (`instances.legacyFlow`, the
 * github.com device flow) shows that flow first and its other instances
 * beneath; which section is shown is decided by the descriptor flag, never by
 * the provider id.
 */
export const SourceControlProviderCard: React.FC<{ descriptor: SourceControlProviderDescriptor }> = ({ descriptor }) => {
  const { t } = useI18n();
  const sourceControl = getRegisteredRuntimeAPIs()?.sourceControl;
  const identities = useSourceControlAuthStore((state) => state.identities);
  const entries = useSourceControlAuthStore((state) => state.entries);
  const refreshInstances = useSourceControlAuthStore((state) => state.refreshInstances);
  const [open, setOpen] = React.useState(false);
  const [pendingIdentity, setPendingIdentity] = React.useState<SourceControlIdentity | null>(null);
  const [instanceInput, setInstanceInput] = React.useState('');
  const [isAddingInstance, setIsAddingInstance] = React.useState(false);
  const [instanceFailed, setInstanceFailed] = React.useState(false);
  const clearPendingIdentity = React.useCallback(() => setPendingIdentity(null), []);
  const copy = providerSettingsCopy(descriptor);
  const provider = descriptor.label;
  const { instances } = descriptor;
  const legacyFlow = instances.legacyFlow?.kind === 'github-com-device' ? instances.legacyFlow : null;
  // Settings search anchors: `lib/settings/search.ts` builds the same ids per served provider.
  const settingsItem = `integrations.source-control.${descriptor.id}`;

  // One object per descriptor: the instance block re-reads its capabilities when its identity changes.
  const defaultIdentity = React.useMemo(() => (
    instances.defaultInstance && instances.defaultInstance !== legacyFlow?.instance
      ? { provider: descriptor.id, instance: instances.defaultInstance }
      : null
  ), [descriptor.id, instances.defaultInstance, legacyFlow?.instance]);

  React.useEffect(() => {
    if (sourceControl) void refreshInstances(sourceControl);
  }, [refreshInstances, sourceControl]);

  if (!sourceControl) return null;

  const providerIdentities = identities.filter((item) => item.provider === descriptor.id);
  const instanceIdentities = providerIdentities.filter((item) => item.instance !== legacyFlow?.instance);
  if (pendingIdentity && !instanceIdentities.some((item) => item.instance === pendingIdentity.instance)) {
    instanceIdentities.push(pendingIdentity);
  }
  if (instanceIdentities.length === 0 && defaultIdentity) instanceIdentities.push(defaultIdentity);
  // A provider that keeps one instance still needs a way to name it when it has
  // no default; a provider whose settings take no instance address has none to add.
  const takesInstanceUrl = descriptor.settings.fields.some((field) => field.kind === 'instance-url');
  const canAddInstance = takesInstanceUrl && (instances.multiple || instanceIdentities.length === 0);

  // The pill counts every instance, the special-flow one included even before it is listed.
  const legacyIdentity = legacyFlow && !providerIdentities.some((item) => item.instance === legacyFlow.instance)
    ? { provider: descriptor.id, instance: legacyFlow.instance }
    : null;
  const statusIdentities = legacyIdentity ? [...providerIdentities, legacyIdentity] : providerIdentities;
  const instanceEntries = statusIdentities.map((identity) => entries[getSourceControlAuthKey(identity)]);
  const validAccounts = instanceEntries
    .flatMap((entry) => (entry?.status?.status === 'connected' ? entry.status.accounts : []))
    .filter((account) => account.status === 'valid');
  // Prefer the account the user is acting as; the first valid one is an
  // arbitrary pick once several instances are configured.
  const connectedAccount = validAccounts.find((account) => account.current) ?? validAccounts[0] ?? null;
  const connected = connectedAccount !== null;
  const isChecking = instanceEntries.some((entry) => entry?.isLoading && !entry.hasChecked);
  const statusLabel = isChecking && !connected
    ? t('common.loading')
    : connected
      ? validAccounts.length > 1
        ? t('settings.sourceControl.accounts.connectedCount', { count: validAccounts.length })
        : connectedAccount.user.username.trim() || t(copy.connected)
      : t(copy.notConnected);

  const applyInstance = () => {
    const instance = normalizeInstanceInput(descriptor, instanceInput);
    if (!instance) {
      setInstanceFailed(true);
      return;
    }
    setPendingIdentity({ provider: descriptor.id, instance });
    setInstanceInput('');
    setIsAddingInstance(false);
    setInstanceFailed(false);
  };

  const cancelAddInstance = () => {
    setInstanceInput('');
    setIsAddingInstance(false);
    setInstanceFailed(false);
  };

  // A field kind this version cannot draw would leave an untranslated or
  // half-working form; the instance setup asks for an update instead.
  const instanceSetup = hasUnknownSettingsField(descriptor) ? (
    <p className="typography-meta text-muted-foreground">{t(copy.updateApp, { provider })}</p>
  ) : (
    <>
      {instanceIdentities.length > 0 ? (
        <div className="divide-y divide-[var(--interactive-border)]">
          {instanceIdentities.map((item) => (
            <ProviderInstanceAccounts
              key={`${getRuntimeKey()}:${item.instance}`}
              descriptor={descriptor}
              identity={item}
              sourceControl={sourceControl}
              onSaved={pendingIdentity?.instance === item.instance ? clearPendingIdentity : undefined}
            />
          ))}
        </div>
      ) : null}

      {canAddInstance ? (
        isAddingInstance ? (
          <SettingsFieldRow
            label={t(copy.instanceLabel, { provider })}
            info={t(copy.instanceInfo)}
            description={instanceFailed ? t(copy.operationFailed) : undefined}
          >
            <div className={`${SETTINGS_CONTROL_CLUSTER_CLASS} flex flex-col gap-2 @xl:flex-row @xl:items-center`}>
              <Input
                className="h-8 w-full min-w-0 rounded-md"
                value={instanceInput}
                onChange={(event) => setInstanceInput(event.target.value)}
                placeholder={instances.placeholder}
                aria-label={t(copy.instanceLabel, { provider })}
              />
              <Button className="w-full @xl:w-auto" size="sm" onClick={applyInstance}>{t(copy.useInstance)}</Button>
              <Button className="w-full @xl:w-auto" size="sm" variant="ghost" onClick={cancelAddInstance}>
                {t('settings.common.actions.cancel')}
              </Button>
            </div>
          </SettingsFieldRow>
        ) : (
          <div>
            <Button size="sm" variant="outline" onClick={() => setIsAddingInstance(true)}>
              {t(copy.addInstance)}
            </Button>
          </div>
        )
      ) : null}
    </>
  );

  return (
    <IntegrationCatalogCard
      settingsItem={settingsItem}
      logo={<ProviderIcon descriptor={descriptor} variant="fill" className="size-5 text-foreground" />}
      name={provider}
      description={t(copy.description, { provider })}
      status={statusLabel}
      statusTone={connected ? 'success' : 'neutral'}
      open={open}
      onOpenChange={setOpen}
    >
      <div className="space-y-3" data-settings-item={`${settingsItem}.connect`}>
        {legacyFlow ? (
          <>
            <GitHubComAccountSection />
            <SettingsControlGroup title={t(copy.instancesTitle)} contentClassName="space-y-3">
              {instanceSetup}
            </SettingsControlGroup>
          </>
        ) : instanceSetup}
      </div>
    </IntegrationCatalogCard>
  );
};
