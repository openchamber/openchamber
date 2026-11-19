import React from 'react';
import type { Integration as IntegrationInfo } from '@/lib/opencode/model';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { SettingsProjectSelector } from '@/components/sections/shared/SettingsProjectSelector';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import { Icon } from '@/components/icon/Icon';
import { useI18n, type I18nKey } from '@/lib/i18n';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { rankByQuery } from '@/lib/search/fuzzySearch';
import type { Model, Provider } from '@/lib/opencode/model';
import {
  SETTINGS_CARD_GRID_CLASS,
  SettingsAddCard,
  SettingsCard,
  SettingsCardChip,
  SettingsCardPill,
  SettingsCardToolbar,
  type SettingsCardTone,
} from '@/components/sections/shared/SettingsCards';
import { findIntegrationForProvider, getProviderCardStatus, readProviderApiKeySetting, usesMachineCredentials, type ProviderCardStatus } from './providerAuth';
import { SETTINGS_CALLOUT_TITLE_CLASS, SettingsSection } from '@/components/sections/shared/SettingsSection';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useEnterpriseMode, useEnterprisePolicyStore } from '@/stores/useEnterprisePolicyStore';
import { useRoutingStore } from '@/stores/useRoutingStore';
import { opencodeClient } from '@/lib/opencode/client';
import { openExternalUrl } from '@/lib/url';
import { SettingsInlineLink } from '@/components/sections/classification/JevAccessNote';

const PROVIDER_POLICIES_DOCS_URL = 'https://opencode.ai/v2/docs/policies/';

const useConfigDeniesAnyProvider = (directory: string | null): boolean | null => {
  const [restricted, setRestricted] = React.useState<boolean | null>(null);
  React.useEffect(() => {
    let cancelled = false;
    setRestricted(null);
    opencodeClient.configDeniesAnyProvider(directory)
      .then((value) => { if (!cancelled) setRestricted(value); })
      .catch((error) => {
        console.warn('[providers] could not read OpenCode provider policies:', error instanceof Error ? error.message : String(error));
        if (!cancelled) setRestricted(null);
      });
    return () => { cancelled = true; };
  }, [directory]);
  return restricted;
};

const EnterpriseProvidersNotice: React.FC<{ directory: string | null; integrations: readonly IntegrationInfo[] | null }> = ({ directory, integrations }) => {
  const { t } = useI18n();
  const restricted = useConfigDeniesAnyProvider(directory);
  const organization = useEnterprisePolicyStore((state) => state.organization);
  const policyUnreadable = useEnterprisePolicyStore((state) => state.policyError !== null);
  const consoleConnected = integrations === null
    ? null
    : (findIntegrationForProvider(integrations, 'opencode')?.connections?.length ?? 0) > 0;
  const gap = restricted !== false || consoleConnected === null
    ? null
    : consoleConnected ? 'console' : 'open';
  const warning = gap === 'open';
  const policyLink = (
    <SettingsInlineLink onClick={() => { void openExternalUrl(PROVIDER_POLICIES_DOCS_URL); }}>
      {t('settings.providers.enterprisePolicyLink')}
    </SettingsInlineLink>
  );

  return (
    <div
      className={cn(
        'mb-4 flex items-start gap-2 rounded-lg p-3',
        warning
          ? 'bg-[var(--status-warning)]/10'
          : 'bg-[var(--status-info-background)]/60',
      )}
    >
      <Icon
        name={warning ? 'error-warning' : 'information'}
        className={cn('mt-0.5 size-4 shrink-0', warning ? 'text-[var(--status-warning)]' : 'text-[var(--status-info)]')}
      />
      <div className="min-w-0 space-y-1.5">
        <p className={SETTINGS_CALLOUT_TITLE_CLASS}>{t('settings.providers.enterpriseTitle')}</p>
        {organization ? (
          <p className="typography-meta text-foreground">{t('settings.providers.enterpriseManagedBy', { organization })}</p>
        ) : null}
        {policyUnreadable ? (
          <p className="typography-meta text-foreground">{t('settings.providers.enterprisePolicyUnreadable')}</p>
        ) : null}
        <p className="typography-meta text-muted-foreground">{t('settings.providers.enterpriseMode')}</p>
        {gap === 'open' ? (
          <p className="typography-meta text-foreground">
            {t('settings.providers.enterprisePolicyMissing')}{' '}{policyLink}
          </p>
        ) : null}
        {gap === 'console' ? (
          <p className="typography-meta text-muted-foreground">
            {t('settings.providers.enterprisePolicyConsole')}{' '}{policyLink}
          </p>
        ) : null}
      </div>
    </div>
  );
};

const ClassificationCard: React.FC<{ onOpen: () => void }> = ({ onOpen }) => {
  const { t } = useI18n();
  const available = useRoutingStore((state) => state.available);
  const jevAvailable = useRoutingStore((state) => state.jevAvailable);
  const off = useRoutingStore((state) => state.classifier?.selected === 'off');
  if (!available) return null;
  return (
    <SettingsCard
      icon={<ProviderLogo providerId="typesafe" className="size-5" />}
      title={t('settings.classification.page.title')}
      subtitle="jev"
      badges={(
        <SettingsCardPill tone={jevAvailable ? 'success' : off ? 'neutral' : 'warning'}>
          {jevAvailable
            ? t('settings.classification.card.ready')
            : off ? t('settings.classification.card.off') : t('settings.classification.card.notSetUp')}
        </SettingsCardPill>
      )}
      footer={<span className="min-w-0 truncate">{t('settings.classification.card.usedFor')}</span>}
      onOpen={onOpen}
    />
  );
};

type GridProvider = Provider & { models: Model[] };

const BILLING_KEY_BY_PROVIDER = new Map<string, I18nKey>([
  ['opencode', 'settings.providers.card.billing.payPerUse'],
  ['opencode-go', 'settings.providers.card.billing.subscription'],
]);

interface ProviderGridProps {
  providers: readonly GridProvider[];
  integrations: readonly IntegrationInfo[] | null;
  directory: string | null;
  onSelect: (providerId: string) => void;
  onConnect: () => void;
  onOpenClassification: () => void;
  disabledProviders?: readonly string[] | null;
  onEnableProvider?: (providerId: string) => void;
}

const useProjectProviderIds = (providers: readonly GridProvider[], directory: string | null): ReadonlySet<string> => {
  const [projectIds, setProjectIds] = React.useState<ReadonlySet<string>>(() => new Set());

  React.useEffect(() => {
    let cancelled = false;
    const query = directory ? `?directory=${encodeURIComponent(directory)}` : '';
    void Promise.all(providers.map(async (provider) => {
      try {
        const response = await runtimeFetch(`/api/provider/${encodeURIComponent(provider.id)}/source${query}`, {
          method: 'GET',
          headers: { Accept: 'application/json' },
        });
        if (!response.ok) return null;
        const payload = await response.json().catch(() => null);
        const sources = payload?.sources ?? payload?.data?.sources;
        return sources?.project?.exists === true ? provider.id : null;
      } catch {
        return null;
      }
    })).then((ids) => {
      if (!cancelled) setProjectIds(new Set(ids.filter((id): id is string => id !== null)));
    });
    return () => {
      cancelled = true;
    };
  }, [directory, providers]);

  return projectIds;
};

const StatusPill: React.FC<{ status: ProviderCardStatus }> = ({ status }) => {
  const { t } = useI18n();
  let label: string;
  switch (status.kind) {
    case 'reauthNeeded': label = t('settings.providers.card.status.reauthNeeded'); break;
    case 'accounts': label = t('settings.providers.card.status.accounts', { count: status.count }); break;
    case 'connected': label = t('settings.providers.card.status.connected'); break;
    case 'noModels': label = t('settings.providers.card.status.noModels'); break;
    case 'environment': label = t('settings.providers.card.status.environment'); break;
    case 'signInNeeded': label = t('settings.providers.card.status.signInNeeded'); break;
  }
  const tone: SettingsCardTone = status.kind === 'signInNeeded' || status.kind === 'reauthNeeded' || status.kind === 'noModels'
    ? 'warning'
    : status.kind === 'environment'
      ? 'neutral'
      : 'success';
  return <SettingsCardPill tone={tone}>{label}</SettingsCardPill>;
};

export const ProviderGrid: React.FC<ProviderGridProps> = ({ providers, integrations, directory, onSelect, onConnect, onOpenClassification, disabledProviders, onEnableProvider }) => {
  const { t } = useI18n();
  const [query, setQuery] = React.useState('');
  const projectIds = useProjectProviderIds(providers, directory);
  const alphabetical = React.useMemo(() => [...providers].sort((a, b) =>
    (a.name || a.id).localeCompare(b.name || b.id, undefined, { sensitivity: 'base' })), [providers]);
  const filtered = rankByQuery(alphabetical, query, (provider) => [provider.name || provider.id, provider.id]);
  const hasQuery = query.trim().length > 0;
  const locked = useEnterpriseMode();

  return (
    <SettingsPageLayout
      title={t('settings.page.providers.title')}
      namedBySidebar
      className="[&>section:first-of-type]:pt-8"
    >
      {locked ? <EnterpriseProvidersNotice directory={directory} integrations={integrations} /> : null}
      <SettingsCardToolbar
        search={providers.length > 0 ? { value: query, onChange: setQuery, placeholder: t('settings.providers.grid.searchPlaceholder') } : null}
        actions={<SettingsProjectSelector className="min-w-0 w-56" />}
      />

      {providers.length === 0 ? (
        <p className="py-6 typography-meta text-muted-foreground">{t('settings.providers.grid.empty')}</p>
      ) : filtered.length === 0 ? (
        <p className="py-6 typography-meta text-muted-foreground">{t('settings.providers.grid.noMatches', { query: query.trim() })}</p>
      ) : null}

      <div className={SETTINGS_CARD_GRID_CLASS}>
        {hasQuery || locked ? null : (
          <SettingsAddCard
            label={t('settings.providers.grid.connect')}
            hint={t('settings.providers.grid.connectHint')}
            onClick={onConnect}
          />
        )}
        {hasQuery ? null : <ClassificationCard onOpen={onOpenClassification} />}
        {filtered.map((provider) => {
          const status = getProviderCardStatus({
            integrations,
            providerId: provider.id,
            optionsApiKey: readProviderApiKeySetting(provider),
            machineCredentials: usesMachineCredentials(provider),
            noModels: provider.models.length === 0,
          });
          const billingKey = BILLING_KEY_BY_PROVIDER.get(provider.id);
          return (
            <SettingsCard
              key={provider.id}
              icon={<ProviderLogo providerId={provider.id} className="size-5" />}
              title={provider.name || provider.id}
              description={billingKey ? t(billingKey) : undefined}
              badges={status ? <StatusPill status={status} /> : null}
              footer={(
                <>
                  <span className="inline-flex items-center gap-1" aria-label={t('settings.providers.card.models', { count: provider.models.length })}>
                    <Icon name="stack" className="size-3.5 opacity-70" aria-hidden />
                    <span className="tabular-nums">{provider.models.length}</span>
                  </span>
                  {projectIds.has(provider.id) ? <SettingsCardChip>{t('settings.providers.card.source.project')}</SettingsCardChip> : null}
                </>
              )}
              onOpen={() => onSelect(provider.id)}
            />
          );
        })}
      </div>

      {disabledProviders && disabledProviders.length > 0 && onEnableProvider ? (
        <SettingsSection title={t('settings.providers.disabled.title')} info={t('settings.providers.disabled.info')}>
          <div className="space-y-1">
            {disabledProviders.map((providerId) => (
              <div key={providerId} className="flex items-center gap-2 py-1">
                <ProviderLogo providerId={providerId} className="size-4 shrink-0 opacity-60" />
                <span className="min-w-0 flex-1 truncate typography-ui-label text-muted-foreground">{providerId}</span>
                <Button size="xs" variant="outline" className="!font-normal" onClick={() => onEnableProvider(providerId)}>
                  {t('settings.providers.disabled.enable')}
                </Button>
              </div>
            ))}
          </div>
        </SettingsSection>
      ) : null}
    </SettingsPageLayout>
  );
};
