import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { SETTINGS_DESCRIPTION_CLASS } from '@/components/sections/shared/SettingsSection';
import { useI18n } from '@/lib/i18n';
import { ThirdPartyIntegrationsSection } from './ThirdPartyIntegrationsSection';

interface IntegrationsPageProps {
  onOpenProviderSetup: (providerId: string) => Promise<boolean>;
  onOpenPluginManager: () => void;
}

export const IntegrationsPage: React.FC<IntegrationsPageProps> = ({
  onOpenProviderSetup,
  onOpenPluginManager,
}) => {
  const { t } = useI18n();

  return (
    <SettingsPageLayout
      title={t('settings.page.integrations.title')}
      description={(
        <div className="space-y-3">
          <p className={SETTINGS_DESCRIPTION_CLASS}>{t('settings.page.integrations.description')}</p>
          <div role="alert" className="flex items-start gap-2 rounded-lg border border-[var(--status-warning-border)] bg-[var(--status-warning-background)] p-3">
            <Icon name="error-warning" className="mt-0.5 size-4 shrink-0 text-[var(--status-warning)]" />
            <p className="typography-meta text-[var(--status-warning)]">
              {t('settings.integrations.experimentalWarning')}
            </p>
          </div>
        </div>
      )}
      showSaveStatus={false}
    >
      <ThirdPartyIntegrationsSection
        divider={false}
        onOpenProviderSetup={onOpenProviderSetup}
        onOpenPluginManager={onOpenPluginManager}
      />
    </SettingsPageLayout>
  );
};
