import React from 'react';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import { SettingsSection } from '@/components/sections/shared/SettingsSection';
import {
  SETTINGS_CARD_GRID_CLASS,
  SettingsAddCard,
  SettingsCard,
  SettingsCardPill,
  SettingsCardSearch,
} from '@/components/sections/shared/SettingsCards';
import { useI18n } from '@/lib/i18n';
import { matchesRankQuery, rankByQuery } from '@/lib/search/fuzzySearch';
import { splitConnectableProviders, type ConnectableProvider } from './connectableProviders';

const ROW_GRID_CLASS = 'grid grid-cols-1 gap-0.5 @xl:grid-cols-2 @3xl:grid-cols-3';

const ROW_CLASS = 'flex min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left typography-ui-label text-foreground hover:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--interactive-focus-ring)]';

const ProviderRow: React.FC<{ provider: ConnectableProvider; onSelect: (providerId: string) => void }> = ({ provider, onSelect }) => (
  <button type="button" className={ROW_CLASS} onClick={() => onSelect(provider.id)}>
    <ProviderLogo providerId={provider.id} className="size-4 shrink-0" />
    <span className="truncate">{provider.name}</span>
  </button>
);

interface ProviderConnectPickerProps {
  /** Null until the integration list is read. */
  providers: readonly ConnectableProvider[] | null;
  loadFailed: boolean;
  onSelect: (providerId: string) => void;
  onSelectCustom: () => void;
}

/**
 * The connect page before a provider is chosen: popular providers as cards,
 * every other one as a compact row behind "Show all", and a search that
 * covers all of them.
 */
export const ProviderConnectPicker: React.FC<ProviderConnectPickerProps> = ({ providers, loadFailed, onSelect, onSelectCustom }) => {
  const { t } = useI18n();
  const [query, setQuery] = React.useState('');
  const [showAll, setShowAll] = React.useState(false);
  const { popular, others } = React.useMemo(() => splitConnectableProviders(providers ?? []), [providers]);
  const customLabel = t('settings.providers.page.custom.title');

  if (providers === null) {
    return (
      <p className="py-6 typography-meta text-muted-foreground">
        {loadFailed ? t('settings.providers.page.state.unableToLoadProviderList') : t('settings.providers.page.state.loading')}
      </p>
    );
  }

  const search = (
    <SettingsCardSearch
      value={query}
      onChange={setQuery}
      placeholder={t('settings.providers.connect.searchPlaceholder')}
    />
  );

  if (query.trim().length > 0) {
    const matches = rankByQuery(providers, query, (provider) => [provider.name, provider.id]);
    const customMatches = matchesRankQuery([customLabel, 'other', 'custom', 'openai-compatible'], query);
    return (
      <>
        {search}
        {matches.length === 0 && !customMatches ? (
          <p className="py-6 typography-meta text-muted-foreground">{t('settings.providers.page.connect.noProvidersFound')}</p>
        ) : (
          <div className={ROW_GRID_CLASS}>
            {matches.map((provider) => <ProviderRow key={provider.id} provider={provider} onSelect={onSelect} />)}
            {customMatches ? (
              <button type="button" className={ROW_CLASS} onClick={onSelectCustom}>
                <Icon name="add" className="size-4 shrink-0 text-muted-foreground" />
                <span className="truncate">{customLabel}</span>
              </button>
            ) : null}
          </div>
        )}
      </>
    );
  }

  return (
    <>
      {search}
      <SettingsSection title={t('settings.providers.connect.popular')} divider={false} settingsItem="providers.connect">
        <div className={SETTINGS_CARD_GRID_CLASS}>
          {popular.map((provider) => (
            <SettingsCard
              key={provider.id}
              icon={<ProviderLogo providerId={provider.id} className="size-5" />}
              title={provider.name}
              badges={provider.recommended
                ? <SettingsCardPill tone="neutral">{t('settings.providers.connect.recommended')}</SettingsCardPill>
                : null}
              description={t(provider.noteKey)}
              onOpen={() => onSelect(provider.id)}
            />
          ))}
          <SettingsAddCard label={customLabel} hint={t('settings.providers.connect.customHint')} onClick={onSelectCustom} />
        </div>
      </SettingsSection>

      {others.length > 0 ? (
        <SettingsSection title={t('settings.providers.connect.all')}>
          {showAll ? (
            <div className={ROW_GRID_CLASS}>
              {others.map((provider) => <ProviderRow key={provider.id} provider={provider} onSelect={onSelect} />)}
            </div>
          ) : (
            <Button variant="outline" size="sm" className="!font-normal" onClick={() => setShowAll(true)}>
              {t('settings.providers.connect.showAll', { count: others.length })}
            </Button>
          )}
        </SettingsSection>
      ) : null}
    </>
  );
};
