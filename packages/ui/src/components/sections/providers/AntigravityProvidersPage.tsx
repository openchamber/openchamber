import * as React from 'react';

import { Icon } from '@/components/icon/Icon';
import {
  SETTINGS_CALLOUT_TITLE_CLASS,
  SETTINGS_DESCRIPTION_CLASS,
  SettingsCheckboxRow,
  SettingsFieldRow,
  SettingsSection,
} from '@/components/sections/shared/SettingsSection';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { fetchAntigravityStatus, type AntigravityStatus } from '@/lib/antigravity';
import { useI18n } from '@/lib/i18n';
import { updateDesktopSettings } from '@/lib/persistence';
import { openExternalUrl } from '@/lib/url';
import { useEnterpriseMode } from '@/stores/useEnterprisePolicyStore';
import { useUIStore } from '@/stores/useUIStore';
import { cn } from '@/lib/utils';

const ANTIGRAVITY_CLI_DOCS_URL = 'https://antigravity.google/docs/getting-started/';

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; status: AntigravityStatus }
  | { kind: 'failed'; message: string }
  | { kind: 'blocked' };

interface AntigravityProvidersPageProps {
  /** Back to the provider grid, same as every other provider page. */
  titleLeading: React.ReactNode;
}

/**
 * Settings → Providers → Antigravity CLI.
 *
 * Not an OpenCode provider: delegation adds the `agy` tool and `/agy`, and
 * Antigravity stays out of the model picker. The CLI keeps its own Google
 * sign-in and runs delegated tasks with its own tools and permissions, so this
 * page configures the hand-off, not a model.
 */
export const AntigravityProvidersPage: React.FC<AntigravityProvidersPageProps> = ({ titleLeading }) => {
  const { t } = useI18n();
  const enterpriseLocked = useEnterpriseMode();
  const enabled = useUIStore((state) => state.antigravityDelegationEnabled);
  const setEnabled = useUIStore((state) => state.setAntigravityDelegationEnabled);
  const model = useUIStore((state) => state.antigravityDelegationModel);
  const setModel = useUIStore((state) => state.setAntigravityDelegationModel);
  const skipPermissions = useUIStore((state) => state.antigravityDelegationSkipPermissions);
  const setSkipPermissions = useUIStore((state) => state.setAntigravityDelegationSkipPermissions);
  const [load, setLoad] = React.useState<LoadState>({ kind: 'loading' });

  const readStatus = React.useCallback(async (refresh: boolean) => {
    try {
      const status = await fetchAntigravityStatus({ refresh });
      setLoad({ kind: 'ready', status });
    } catch (error) {
      setLoad({ kind: 'failed', message: error instanceof Error ? error.message : String(error) });
    }
  }, []);

  React.useEffect(() => {
    // Enterprise mode keeps the CLI from being started at all, so the page
    // does not ask for its status.
    if (enterpriseLocked) {
      setLoad({ kind: 'blocked' });
      return;
    }
    void readStatus(false);
  }, [enterpriseLocked, readStatus]);

  const status = load.kind === 'ready' ? load.status : null;
  // The server also reports a blocked read when the policy appeared after this
  // page loaded, so the notice follows either source.
  const blocked = enterpriseLocked || status?.blocked === true;
  // An external OpenCode server never receives the managed plugin.
  const external = status?.managed === false;
  const models = status?.models ?? [];
  const usable = status?.installed === true && models.length > 0 && !blocked && !external;
  // A model the CLI no longer lists stays named until the user picks another,
  // rather than being swapped silently.
  const modelKnown = model.length === 0 || models.some((entry) => entry.id === model);

  const handleEnabled = (value: boolean) => {
    setEnabled(value);
    void updateDesktopSettings({ antigravityDelegationEnabled: value });
  };

  const handleModel = (value: string) => {
    setModel(value);
    void updateDesktopSettings({ antigravityDelegationModel: value });
  };

  const handleSkipPermissions = (value: boolean) => {
    setSkipPermissions(value);
    void updateDesktopSettings({ antigravityDelegationSkipPermissions: value });
  };

  return (
    <SettingsPageLayout
      title={t('settings.providers.antigravity.page.title')}
      titleLeading={titleLeading}
      description={<p className={SETTINGS_DESCRIPTION_CLASS}>{t('settings.providers.antigravity.page.description')}</p>}
      showSaveStatus
    >
      <p className={SETTINGS_DESCRIPTION_CLASS}>{t('settings.providers.antigravity.page.note')}</p>

      {external && !blocked ? (
        <div className="flex items-start gap-2 rounded-lg bg-[var(--status-info-background)]/60 p-3">
          <Icon name="information" className="mt-0.5 size-4 shrink-0 text-[var(--status-info)]" />
          <p className="min-w-0 typography-meta text-foreground">
            {t('settings.providers.antigravity.external')}
          </p>
        </div>
      ) : null}

      {blocked ? (
        <div className="flex items-start gap-2 rounded-lg bg-[var(--status-warning)]/10 p-3">
          <Icon name="error-warning" className="mt-0.5 size-4 shrink-0 text-[var(--status-warning)]" />
          <div className="min-w-0 space-y-1">
            <p className={SETTINGS_CALLOUT_TITLE_CLASS}>{t('settings.providers.enterpriseTitle')}</p>
            <p className={cn(SETTINGS_DESCRIPTION_CLASS, 'text-foreground')}>
              {t('settings.providers.antigravity.enterprise')}
            </p>
          </div>
        </div>
      ) : null}

      {blocked ? null : (
        <SettingsSection title={t('settings.providers.antigravity.status.section')}>
          {load.kind === 'loading' ? (
            <p className={SETTINGS_DESCRIPTION_CLASS}>{t('settings.providers.antigravity.status.loading')}</p>
          ) : load.kind === 'failed' ? (
            <div className="space-y-2">
              <p className={SETTINGS_DESCRIPTION_CLASS}>{t('settings.providers.antigravity.status.failed', { message: load.message })}</p>
              <Button variant="outline" size="sm" onClick={() => { setLoad({ kind: 'loading' }); void readStatus(true); }}>
                {t('settings.providers.antigravity.status.checkAgain')}
              </Button>
            </div>
          ) : status && !status.installed ? (
            <div className="space-y-2">
              <p className={SETTINGS_DESCRIPTION_CLASS}>{t('settings.providers.antigravity.status.missing')}</p>
              <p className={SETTINGS_DESCRIPTION_CLASS}>{t('settings.providers.antigravity.install.label')}</p>
              <Button variant="outline" size="sm" onClick={() => { void openExternalUrl(ANTIGRAVITY_CLI_DOCS_URL); }}>
                {t('settings.providers.antigravity.install.link')}
              </Button>
            </div>
          ) : status ? (
            <div className="space-y-2">
              <p className={SETTINGS_DESCRIPTION_CLASS}>
                {status.version
                  ? t('settings.providers.antigravity.status.installed', { version: status.version })
                  : t('settings.providers.antigravity.status.installedNoVersion')}
                {models.length > 0 ? ` · ${t('settings.providers.antigravity.status.models', { count: models.length })}` : null}
              </p>
              {status.error ? (
                <>
                  <p className={SETTINGS_DESCRIPTION_CLASS}>
                    {t('settings.providers.antigravity.status.failed', { message: status.error.message })}
                  </p>
                  <p className={SETTINGS_DESCRIPTION_CLASS}>{t('settings.providers.antigravity.signIn.label')}</p>
                </>
              ) : null}
              <Button variant="outline" size="sm" onClick={() => { setLoad({ kind: 'loading' }); void readStatus(true); }}>
                {t('settings.providers.antigravity.status.checkAgain')}
              </Button>
            </div>
          ) : null}
        </SettingsSection>
      )}

      <SettingsSection title={t('settings.providers.antigravity.page.delegationSection')}>
        <SettingsCheckboxRow
          checked={enabled}
          onChange={handleEnabled}
          // A checked switch stays usable when the CLI later disappears, so
          // the user can still turn it off.
          disabled={!usable && !enabled}
          settingsItem="providers.antigravity.enable"
          label={t('settings.providers.antigravity.enable.label')}
          info={t('settings.providers.antigravity.enable.info')}
          description={!usable && !enabled && !blocked && !external ? t('settings.providers.antigravity.enable.needsCli') : undefined}
        />

        <SettingsFieldRow
          label={t('settings.providers.antigravity.model.label')}
          info={t('settings.providers.antigravity.model.info')}
          settingsItem="providers.antigravity.model"
        >
          <Select<string>
            value={model}
            onValueChange={handleModel}
            disabled={!enabled || models.length === 0}
          >
            <SelectTrigger
              className="w-auto min-w-0 max-w-[18rem]"
              aria-label={t('settings.providers.antigravity.model.label')}
            >
              <SelectValue>
                {(value) => {
                  if (!value) return t('settings.providers.antigravity.model.placeholder');
                  const known = models.find((entry) => entry.id === value);
                  if (known) return known.name;
                  return models.length === 0
                    ? t('settings.providers.antigravity.model.empty')
                    : t('settings.providers.antigravity.model.unavailable', { model: value });
                }}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {!modelKnown ? (
                <SelectItem value={model} disabled>
                  {t('settings.providers.antigravity.model.unavailable', { model })}
                </SelectItem>
              ) : null}
              {models.map((entry) => (
                <SelectItem key={entry.id} value={entry.id}>
                  <span className="truncate">{entry.name}</span>
                  <span className="ms-2 truncate typography-meta text-muted-foreground">{entry.id}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </SettingsFieldRow>

        <SettingsCheckboxRow
          checked={skipPermissions}
          onChange={handleSkipPermissions}
          disabled={!enabled || blocked || external}
          settingsItem="providers.antigravity.skip-permissions"
          label={t('settings.providers.antigravity.skipPermissions.label')}
          info={t('settings.providers.antigravity.skipPermissions.info')}
        />
        {skipPermissions && enabled ? (
          <p className="typography-meta text-[var(--status-warning)]">
            {t('settings.providers.antigravity.skipPermissions.warning')}
          </p>
        ) : null}
      </SettingsSection>
    </SettingsPageLayout>
  );
};
