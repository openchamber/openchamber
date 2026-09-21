import React from 'react';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { SettingsSection } from '@/components/sections/shared/SettingsSection';
import { useI18n } from '@/lib/i18n';
import { isVSCodeRuntime } from '@/lib/desktop';
import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { GuestIntegrationCard, GuestIntegrationsSection } from './GuestIntegrationsSection';
import { useGuestsStore } from '@/lib/guests/store';
import { isGuestActive } from '@/lib/guests/capabilities';
import { isMobileSurfaceRuntime } from '@/lib/runtimeSurface';
import { GitHubIntegration } from './GitHubIntegration';
import { LinearSettings } from './LinearSettings';

export const IntegrationsPage: React.FC = () => {
  const { t } = useI18n();
  // GitHub sign-in is an OpenChamber server feature; the VS Code extension
  // uses the editor's own GitHub session instead.
  const hasGitHub = !isVSCodeRuntime();
  const hasLinear = Boolean(getRegisteredRuntimeAPIs()?.linear);
  const guests = useGuestsStore((state) => state.guests);
  const runtimeKey = useGuestsStore((state) => state.runtimeKey);
  const builtInGuests = !isVSCodeRuntime() && !isMobileSurfaceRuntime()
    ? guests.filter((guest) => guest.source === 'bundled' && guest.integration && isGuestActive(guest))
    : [];
  const hasBuiltIn = hasGitHub || hasLinear || builtInGuests.length > 0;

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
          {builtInGuests.map((guest) => <GuestIntegrationCard key={`${runtimeKey}:${guest.id}`} guest={guest} />)}
        </SettingsSection>
      ) : null}
      <GuestIntegrationsSection divider={hasBuiltIn} />
    </SettingsPageLayout>
  );
};
