import React from 'react';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { SettingsSection } from '@/components/sections/shared/SettingsSection';
import { useI18n } from '@/lib/i18n';
import { isVSCodeRuntime } from '@/lib/desktop';
import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { useGuestsStore } from '@/lib/guests/store';
import { GuestIntegrationsSection } from './GuestIntegrationsSection';
import { GitHubIntegration } from './GitHubIntegration';
import { LinearSettings } from './LinearSettings';
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
  // GitHub sign-in is an OpenChamber server feature; the VS Code extension
  // uses the editor's own GitHub session instead.
  const hasGitHub = !isVSCodeRuntime();
  const hasLinear = Boolean(getRegisteredRuntimeAPIs()?.linear);
  const hasBuiltIn = hasGitHub || hasLinear;
  const hasGuestIntegrations = useGuestsStore(
    (state) => !isVSCodeRuntime() && state.guests.some((guest) => Boolean(guest.integration) && guest.enabled !== false),
  );

  return (
    <SettingsPageLayout
      title={t('settings.page.integrations.title')}
      description={t('settings.page.integrations.description')}
      showSaveStatus
    >
      {hasBuiltIn ? (
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
      ) : null}
      <GuestIntegrationsSection divider={hasBuiltIn} />
      <ThirdPartyIntegrationsSection
        divider={hasBuiltIn || hasGuestIntegrations}
        onOpenProviderSetup={onOpenProviderSetup}
        onOpenPluginManager={onOpenPluginManager}
      />
    </SettingsPageLayout>
  );
};
