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
import { openExternalUrl } from '@/lib/url';
import { useClassifierSourceName } from './classifierSources';
import { CustomEndpointFields } from './CustomEndpointFields';
import { SettingsInlineLink } from './JevAccessNote';

// The docs keep the list of features Jev answers for, so this page never goes stale.
const CLASSIFICATION_DOCS_URL = 'https://docs.openchamber.dev/classification-providers/';

interface ClassificationProvidersPageProps {
  titleLeading: React.ReactNode;
  /** Opens the OpenCode provider whose API key a source reads. */
  onOpenProvider: (providerId: string) => void;
}

/**
 * The "missing key" line with a link to the provider that holds the key. The
 * option row selects on click and swallows Enter and Space, so the link keeps
 * its events to itself.
 */
const MissingKeyDescription: React.FC<{ text: string; linkLabel: string; onOpen: () => void }> = ({ text, linkLabel, onOpen }) => (
  <>
    {text}{' '}
    <span onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
      <SettingsInlineLink onClick={onOpen}>{linkLabel}</SettingsInlineLink>
    </span>
  </>
);

/**
 * Settings → Providers → Classification providers: where Jev requests go, for
 * every feature that asks Jev. Not an OpenCode provider,
 * so it has its own page instead of the provider detail view. The server owns
 * the pick and the TypeSafe key (`packages/web/server/lib/routing`).
 */
export const ClassificationProvidersPage: React.FC<ClassificationProvidersPageProps> = ({ titleLeading, onOpenProvider }) => {
  const { t } = useI18n();
  const available = useRoutingStore((state) => state.available);
  const loaded = useRoutingStore((state) => state.loaded);
  const loadError = useRoutingStore((state) => state.loadError);
  const classifier = useRoutingStore((state) => state.classifier);
  const tokenPresent = useRoutingStore((state) => state.tokenPresent);
  const customEndpoint = useRoutingStore((state) => state.customEndpoint);
  // The server refuses every other pick and any key; the controls only mirror that.
  const locked = useRoutingStore((state) => state.enterpriseMode);
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

  const status = locked
    ? (customEndpoint?.pinned ? t('settings.classification.status.enterprisePinned') : t('settings.classification.status.enterprise'))
    : !classifier || classifier.selected === 'off'
    ? null
    : classifier.effective === null
      ? t('settings.classification.status.none')
      : classifier.effective !== classifier.selected && effectiveName
        ? t('settings.classification.status.fallback', { provider: effectiveName })
        : null;

  const promoUsable = usable('zen-promo');
  const zenKeyUsable = usable('zen-key');
  const openrouterUsable = usable('openrouter');
  const vercelUsable = usable('vercel');
  const customUsable = usable('custom');

  return (
    <SettingsPageLayout
      title={t('settings.classification.page.title')}
      titleLeading={titleLeading}
      description={(
        <p className={SETTINGS_DESCRIPTION_CLASS}>
          {t('settings.classification.page.description')}{' '}
          <SettingsInlineLink onClick={() => { void openExternalUrl(CLASSIFICATION_DOCS_URL); }}>
            {t('settings.classification.page.docsLink')}
          </SettingsInlineLink>
        </p>
      )}
      showSaveStatus
    >
      {loadError ? <p className={SETTINGS_DESCRIPTION_CLASS}>{t('settings.routing.loadError', { error: loadError })}</p> : null}
      {!loaded ? null : !available || !classifier ? (
        <p className={SETTINGS_DESCRIPTION_CLASS}>{t('settings.classification.unavailable')}</p>
      ) : (
        <>
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
              <SettingsRadioOption
                selected={classifier.selected === 'off'}
                onSelect={() => void pick('off')}
                label={t('settings.classification.source.off.name')}
                description={t('settings.classification.source.off.description')}
              />
              {/* Enterprise mode leaves Off as the only choice. */}
              {locked ? null : (
                <>
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
                      : (
                        <MissingKeyDescription
                          text={t('settings.classification.source.zenKey.missing')}
                          linkLabel={t('settings.classification.source.openProvider', { provider: 'OpenCode Zen' })}
                          onOpen={() => onOpenProvider('opencode')}
                        />
                      )}
                  />
                  <SettingsRadioOption
                    selected={classifier.selected === 'openrouter'}
                    onSelect={() => void pick('openrouter')}
                    disabled={!openrouterUsable}
                    label={t('settings.classification.source.openrouter.name')}
                    description={openrouterUsable
                      ? t('settings.classification.source.openrouter.description')
                      : (
                        <MissingKeyDescription
                          text={t('settings.classification.source.openrouter.missing')}
                          linkLabel={t('settings.classification.source.openProvider', { provider: 'OpenRouter' })}
                          onOpen={() => onOpenProvider('openrouter')}
                        />
                      )}
                  />
                  <SettingsRadioOption
                    selected={classifier.selected === 'vercel'}
                    onSelect={() => void pick('vercel')}
                    disabled={!vercelUsable}
                    label={t('settings.classification.source.vercel.name')}
                    description={vercelUsable
                      ? t('settings.classification.source.vercel.description')
                      : (
                        <MissingKeyDescription
                          text={t('settings.classification.source.vercel.missing')}
                          linkLabel={t('settings.classification.source.openProvider', { provider: 'Vercel AI Gateway' })}
                          onOpen={() => onOpenProvider('vercel')}
                        />
                      )}
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
                </>
              )}
              {/* An endpoint pinned by the server environment stays a choice in enterprise mode. */}
              {!locked || customEndpoint?.pinned ? (
                <SettingsRadioOption
                  selected={classifier.selected === 'custom'}
                  onSelect={() => void pick('custom')}
                  disabled={!customUsable}
                  label={t('settings.classification.source.custom.name')}
                  description={customEndpoint && customUsable
                    ? t('settings.classification.source.custom.description', { url: customEndpoint.url })
                    : t('settings.classification.source.custom.missing')}
                />
              ) : null}
            </SettingsRadioGroup>

            {locked ? null : (
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
            )}
            {tokenError ? <p className={SETTINGS_DESCRIPTION_CLASS}>{tokenError}</p> : null}
          </div>
        </SettingsSection>
        {!locked || customEndpoint?.pinned ? <CustomEndpointFields /> : null}
        </>
      )}
    </SettingsPageLayout>
  );
};
