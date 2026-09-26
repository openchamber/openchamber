import React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import {
  SettingsFieldRow,
  SettingsRadioGroup,
  SettingsRadioOption,
  SettingsSection,
  SETTINGS_DESCRIPTION_CLASS,
  SETTINGS_FIELDS_STACK_CLASS,
  SETTINGS_HELPER_CLASS,
} from '@/components/sections/shared/SettingsSection';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import { useI18n } from '@/lib/i18n';
import { reportSettingsSaveState } from '@/lib/persistence';
import type { ClassifierSource } from '@/lib/routing/routingApi';
import { useRoutingStore } from '@/stores/useRoutingStore';
import { useClassifierSourceName } from './classifierSources';

interface ClassificationProvidersPageProps {
  titleLeading: React.ReactNode;
}

/**
 * Settings → Providers → Classification providers: where Jev requests go, for
 * the permission safety net and Auto model routing. Not an OpenCode provider,
 * so it has its own page instead of the provider detail view. The server owns
 * the pick and the TypeSafe key (`packages/web/server/lib/routing`).
 */
export const ClassificationProvidersPage: React.FC<ClassificationProvidersPageProps> = ({ titleLeading }) => {
  const { t } = useI18n();
  const available = useRoutingStore((state) => state.available);
  const loaded = useRoutingStore((state) => state.loaded);
  const loadError = useRoutingStore((state) => state.loadError);
  const classifier = useRoutingStore((state) => state.classifier);
  const tokenPresent = useRoutingStore((state) => state.tokenPresent);
  const load = useRoutingStore((state) => state.load);
  const setClassifierSource = useRoutingStore((state) => state.setClassifierSource);
  const setToken = useRoutingStore((state) => state.setToken);
  const clearToken = useRoutingStore((state) => state.clearToken);
  const effectiveName = useClassifierSourceName(classifier?.effective ?? null);

  const [tokenInput, setTokenInput] = React.useState('');
  const [tokenBusy, setTokenBusy] = React.useState(false);
  const [tokenError, setTokenError] = React.useState<string | null>(null);

  React.useEffect(() => {
    void load();
  }, [load]);

  const usable = (source: ClassifierSource) => classifier?.sources.find((entry) => entry.id === source)?.usable === true;

  const pick = async (source: ClassifierSource) => {
    reportSettingsSaveState('saving');
    try {
      await setClassifierSource(source);
      reportSettingsSaveState('saved');
    } catch {
      reportSettingsSaveState('error');
    }
  };

  const handleSaveToken = async () => {
    const token = tokenInput.trim();
    if (!token) return;
    setTokenBusy(true);
    setTokenError(null);
    try {
      // The server also picks TypeSafe: pasting a key is choosing it.
      await setToken(token);
      setTokenInput('');
    } catch (error) {
      setTokenError(error instanceof Error ? error.message : String(error));
    } finally {
      setTokenBusy(false);
    }
  };

  const handleClearToken = async () => {
    setTokenBusy(true);
    setTokenError(null);
    try {
      await clearToken();
    } catch (error) {
      setTokenError(error instanceof Error ? error.message : String(error));
    } finally {
      setTokenBusy(false);
    }
  };

  const status = !classifier
    ? null
    : classifier.effective === null
      ? t('settings.classification.status.none')
      : classifier.effective !== classifier.selected && effectiveName
        ? t('settings.classification.status.fallback', { provider: effectiveName })
        : null;

  const promoUsable = usable('zen-promo');
  const zenKeyUsable = usable('zen-key');

  return (
    <SettingsPageLayout
      title={t('settings.classification.page.title')}
      titleLeading={titleLeading}
      description={t('settings.classification.page.description')}
      showSaveStatus
    >
      {loadError ? <p className={SETTINGS_DESCRIPTION_CLASS}>{t('settings.routing.loadError', { error: loadError })}</p> : null}
      {!loaded ? null : !available || !classifier ? (
        <p className={SETTINGS_DESCRIPTION_CLASS}>{t('settings.classification.unavailable')}</p>
      ) : (
        <SettingsSection
          title={(
            <span className="flex items-center gap-2">
              <ProviderLogo providerId="typesafe" className="size-4 shrink-0" />
              {t('settings.classification.jev.title')}
            </span>
          )}
          info={t('settings.classification.jev.info')}
          divider={false}
          settingsItem="providers.classification"
        >
          <div className={SETTINGS_FIELDS_STACK_CLASS}>
            {status ? <p className={SETTINGS_HELPER_CLASS}>{status}</p> : null}
            <SettingsRadioGroup aria-label={t('settings.classification.jev.title')}>
              {/* The promotion is offered only while it runs; after that it is not a choice. */}
              {promoUsable || classifier.selected === 'zen-promo' ? (
                <SettingsRadioOption
                  selected={classifier.selected === 'zen-promo'}
                  onSelect={() => void pick('zen-promo')}
                  disabled={!promoUsable}
                  label={t('settings.classification.source.zenPromo.name')}
                  description={promoUsable
                    ? t('settings.classification.source.zenPromo.description')
                    : t('settings.classification.source.zenPromo.ended')}
                />
              ) : null}
              <SettingsRadioOption
                selected={classifier.selected === 'zen-key'}
                onSelect={() => void pick('zen-key')}
                disabled={!zenKeyUsable}
                label={t('settings.classification.source.zenKey.name')}
                description={zenKeyUsable
                  ? t('settings.classification.source.zenKey.description')
                  : t('settings.classification.source.zenKey.missing')}
              />
              <SettingsRadioOption
                selected={classifier.selected === 'typesafe'}
                onSelect={() => void pick('typesafe')}
                disabled={!tokenPresent}
                label={t('settings.classification.source.typesafe.name')}
                description={tokenPresent
                  ? t('settings.classification.source.typesafe.description')
                  : t('settings.classification.source.typesafe.missing')}
              />
            </SettingsRadioGroup>

            <SettingsFieldRow
              label={t('settings.routing.token.label')}
              info={t('settings.routing.token.info')}
            >
              <div className="flex w-full min-w-0 items-center gap-2">
                <Input
                  type="password"
                  autoComplete="off"
                  value={tokenInput}
                  onChange={(event) => setTokenInput(event.target.value)}
                  onKeyDown={(event) => { if (event.key === 'Enter') void handleSaveToken(); }}
                  placeholder={tokenPresent ? t('settings.routing.token.replacePlaceholder') : t('settings.routing.token.placeholder')}
                  aria-label={t('settings.routing.token.label')}
                  className="h-8 rounded-md px-3 min-w-0 flex-1"
                  disabled={tokenBusy}
                />
                <Button size="sm" variant="outline" onClick={() => void handleSaveToken()} disabled={tokenBusy || tokenInput.trim().length === 0}>
                  {t('settings.routing.token.save')}
                </Button>
                {tokenPresent ? (
                  <Button size="sm" variant="ghost" onClick={() => void handleClearToken()} disabled={tokenBusy}>
                    {t('settings.routing.token.remove')}
                  </Button>
                ) : null}
              </div>
            </SettingsFieldRow>
            {tokenError ? <p className={SETTINGS_DESCRIPTION_CLASS}>{tokenError}</p> : null}
          </div>
        </SettingsSection>
      )}
    </SettingsPageLayout>
  );
};
