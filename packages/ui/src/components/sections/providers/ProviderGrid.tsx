import React from 'react';
import type { IntegrationInfo } from '@opencode/client';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { SettingsProjectSelector } from '@/components/sections/shared/SettingsProjectSelector';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { rankByQuery } from '@/lib/search/fuzzySearch';
import type { Model, Provider } from '@/lib/opencode/model';
import {
  SETTINGS_CARD_GRID_CLASS,
  SettingsAddCard,
  SettingsCard,
  SettingsCardChip,
  SettingsCardPill,
  SettingsCardSearch,
  type SettingsCardTone,
} from '@/components/sections/shared/SettingsCards';
import { findIntegrationForProvider, getProviderCardStatus, readProviderApiKeySetting, type ProviderCardStatus } from './providerAuth';
import { SETTINGS_CALLOUT_TITLE_CLASS } from '@/components/sections/shared/SettingsSection';
import { cn } from '@/lib/utils';
import { useEnterpriseMode, useEnterprisePolicyStore } from '@/stores/useEnterprisePolicyStore';
import { useRoutingStore } from '@/stores/useRoutingStore';
import { opencodeClient } from '@/lib/opencode/client';
import { openExternalUrl } from '@/lib/url';
import { SettingsInlineLink } from '@/components/sections/classification/JevAccessNote';

const PROVIDER_POLICIES_DOCS_URL = 'https://opencode.ai/v2/docs/policies/';

/** Whether the OpenCode config denies any provider; null while unknown or when the read failed. */
const useConfigDeniesAnyProvider = (directory: string | null): boolean | null => {
  const [restricted, setRestricted] = React.useState<boolean | null>(null);
  React.useEffect(() => {
    let cancelled = false;
    setRestricted(null);
    opencodeClient.configDeniesAnyProvider(directory)
      .then((value) => { if (!cancelled) setRestricted(value); })
      .catch((error) => {
        // Unknown is not "no policy": stay quiet, but leave a trace.
        console.warn('[providers] could not read OpenCode provider policies:', error instanceof Error ? error.message : String(error));
        if (!cancelled) setRestricted(null);
      });
    return () => { cancelled = true; };
  }, [directory]);
  return restricted;
};

/**
 * Enterprise mode keeps OpenChamber from adding providers, but which ones
 * OpenCode may use is its own `provider.use` policy. The config files are
 * readable; rules from a connected OpenCode Console workspace are not (OpenCode
 * keeps them in memory), and they arrive only through its `opencode`
 * integration. So: no policy and no Console is a certain gap and a warning;
 * no policy with Console connected is a maybe and an info line. Nothing extra
 * is said while either answer is unknown.
 */
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
        'mb-4 flex items-start gap-2 rounded-lg border p-3',
        warning
          ? 'border-[var(--status-warning)]/30 bg-[var(--status-warning)]/5'
          : 'border-[var(--status-info-border)] bg-[var(--status-info-background)]/30',
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

/**
 * Classification providers answer OpenChamber's own Jev decisions (safety
 * net, Auto), not OpenCode, so they get one card of their own that opens a
 * dedicated page. Absent where there is no OpenChamber server (VS Code).
 */
const ClassificationCard: React.FC<{ onOpen: () => void }> = ({ onOpen }) => {
  const { t } = useI18n();
  const available = useRoutingStore((state) => state.available);
  const jevAvailable = useRoutingStore((state) => state.jevAvailable);
  // Off is a choice, not a problem to fix, so it gets no warning.
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

interface ProviderGridProps {
  providers: readonly GridProvider[];
  /** Null while the integration list is loading; cards then show no status. */
  integrations: readonly IntegrationInfo[] | null;
  directory: string | null;
  onSelect: (providerId: string) => void;
  onConnect: () => void;
  onOpenClassification: () => void;
}

/**
 * Providers configured in the selected project's own config. Everything else
 * comes from the user's config, credentials or the environment. Read through
 * the OpenChamber-only source endpoint, because the SDK does not expose which
 * config file defined a provider.
 */
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
        // A provider whose source cannot be read just loses its Project chip.
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
  const label = status.kind === 'accounts'
    ? t('settings.providers.card.status.accounts', { count: status.count })
    : status.kind === 'connected'
      ? t('settings.providers.card.status.connected')
      : status.kind === 'environment'
        ? t('settings.providers.card.status.environment')
        : t('settings.providers.card.status.signInNeeded');
  const tone: SettingsCardTone = status.kind === 'signInNeeded'
    ? 'warning'
    : status.kind === 'environment'
      ? 'neutral'
      : 'success';
  return <SettingsCardPill tone={tone}>{label}</SettingsCardPill>;
};

/** Browse view of the Providers page: one card per provider OpenCode reports. */
export const ProviderGrid: React.FC<ProviderGridProps> = ({ providers, integrations, directory, onSelect, onConnect, onOpenClassification }) => {
  const { t } = useI18n();
  const [query, setQuery] = React.useState('');
  const projectIds = useProjectProviderIds(providers, directory);
  const filtered = rankByQuery([...providers], query, (provider) => [provider.name || provider.id, provider.id]);
  const hasQuery = query.trim().length > 0;
  // The server refuses new providers and keys; this only keeps the way in hidden.
  const locked = useEnterpriseMode();

  return (
    <SettingsPageLayout
      title={t('settings.page.providers.title')}
      description={t('settings.providers.grid.description')}
      headerEnd={<SettingsProjectSelector className="w-full min-w-0 @xl:w-56" />}
    >
      {locked ? <EnterpriseProvidersNotice directory={directory} integrations={integrations} /> : null}
      {providers.length > 0 ? (
        <SettingsCardSearch value={query} onChange={setQuery} placeholder={t('settings.providers.grid.searchPlaceholder')} />
      ) : null}

      {providers.length === 0 ? (
        <p className="py-6 typography-meta text-muted-foreground">{t('settings.providers.grid.empty')}</p>
      ) : filtered.length === 0 ? (
        <p className="py-6 typography-meta text-muted-foreground">{t('settings.providers.grid.noMatches', { query: query.trim() })}</p>
      ) : null}

      <div className={SETTINGS_CARD_GRID_CLASS}>
        {/* The one way in to connecting a provider, so it leads the grid. */}
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
          });
          return (
            <SettingsCard
              key={provider.id}
              icon={<ProviderLogo providerId={provider.id} className="size-5" />}
              title={provider.name || provider.id}
              subtitle={provider.id}
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
    </SettingsPageLayout>
  );
};
