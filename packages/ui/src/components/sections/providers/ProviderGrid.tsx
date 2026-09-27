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
import { getProviderCardStatus, readProviderApiKeySetting, type ProviderCardStatus } from './providerAuth';
import { useRoutingStore } from '@/stores/useRoutingStore';

/**
 * Classification providers answer OpenChamber's own Jev decisions (safety
 * net, Auto), not OpenCode, so they get one card of their own that opens a
 * dedicated page. Absent where there is no OpenChamber server (VS Code).
 */
const ClassificationCard: React.FC<{ onOpen: () => void }> = ({ onOpen }) => {
  const { t } = useI18n();
  const available = useRoutingStore((state) => state.available);
  const jevAvailable = useRoutingStore((state) => state.jevAvailable);
  if (!available) return null;
  return (
    <SettingsCard
      icon={<ProviderLogo providerId="typesafe" className="size-5" />}
      title={t('settings.classification.page.title')}
      subtitle="jev"
      badges={(
        <SettingsCardPill tone={jevAvailable ? 'success' : 'warning'}>
          {jevAvailable ? t('settings.classification.card.ready') : t('settings.classification.card.notSetUp')}
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

  return (
    <SettingsPageLayout
      title={t('settings.page.providers.title')}
      description={t('settings.providers.grid.description')}
      headerEnd={<SettingsProjectSelector className="w-full min-w-0 @xl:w-56" />}
    >
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
        {hasQuery ? null : (
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
