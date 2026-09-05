import React from 'react';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { SettingsSection } from '@/components/sections/shared/SettingsSection';
import { useI18n } from '@/lib/i18n';
import { isVSCodeRuntime } from '@/lib/desktop';
import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { GitHubIntegration } from './GitHubIntegration';
import { LinearSettings } from './LinearSettings';

export const IntegrationsPage: React.FC = () => {
  const { t } = useI18n();
  // GitHub sign-in is an OpenChamber server feature; the VS Code extension
  // uses the editor's own GitHub session instead.
  const hasGitHub = !isVSCodeRuntime();
  const hasLinear = Boolean(getRegisteredRuntimeAPIs()?.linear);

  return (
    <SettingsPageLayout
      title={t('settings.page.integrations.title')}
      description={t('settings.page.integrations.description')}
      showSaveStatus
    >
      <SettingsSection
        title={t('settings.integrations.firstParty.title')}
        info={t('settings.integrations.firstParty.info')}
        divider={false}
        settingsItem="integrations.first-party"
        contentClassName="space-y-3"
      >
        {hasGitHub ? <GitHubIntegration /> : null}
        {hasLinear ? <LinearSettings /> : null}
      </SettingsSection>
    </SettingsPageLayout>
  );
};
