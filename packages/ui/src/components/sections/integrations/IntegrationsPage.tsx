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
import { useEnterpriseMode } from '@/stores/useEnterprisePolicyStore';
import { useSourceControlProviders } from '@/lib/source-control/providers/registry';
import { useTrackerDescriptors } from '@/lib/trackers/registry';
import { SourceControlProviderCard } from './SourceControlProviderCard';
import { TrackerSettings } from './TrackerSettings';
import { ThirdPartyIntegrationsSection } from './ThirdPartyIntegrationsSection';
import { CatalogExtensionsSection } from './CatalogExtensionsSection';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { useDeviceInfo } from '@/lib/device';
import { useUIStore } from '@/stores/useUIStore';

export const IntegrationsPage: React.FC = () => {
  const { t } = useI18n();
  // Source-control sign-in is an OpenChamber server feature; VS Code uses the
  // editor's own Git and GitHub integration instead.
  const sourceControlProviders = useSourceControlProviders();
  const servedSourceControl = isVSCodeRuntime() ? [] : sourceControlProviders;
  // Trackers exist where the runtime has the API; the server says which.
  const trackerDescriptors = useTrackerDescriptors();
  const servedTrackers = getRegisteredRuntimeAPIs()?.trackers ? trackerDescriptors : [];
  const guests = useGuestsStore((state) => state.guests);
  const runtimeKey = useGuestsStore((state) => state.runtimeKey);
  const builtInGuests = !isVSCodeRuntime() && !isMobileSurfaceRuntime()
    ? guests.filter((guest) => guest.source === 'bundled' && guest.integration && isGuestActive(guest))
    : [];
  const hasBuiltIn = servedSourceControl.length > 0 || servedTrackers.length > 0 || builtInGuests.length > 0;
  // Each card here installs a plugin that adds a model provider. In enterprise
  // mode providers come from the administrator's OpenCode config, whose
  // `provider.use` policy also governs plugin providers, so none is offered.
  const enterpriseMode = useEnterpriseMode();
  const hasThirdParty = !enterpriseMode;
  // The catalog is a main-window page, opened the way the sidebar opens it;
  // enterprise mode hides it until administrators can curate its sources.
  const { isMobile } = useDeviceInfo();
  const canBrowseCatalog = !enterpriseMode && !isMobile && !isVSCodeRuntime() && !isMobileSurfaceRuntime();
  const openCatalog = () => {
    const ui = useUIStore.getState();
    ui.setSettingsDialogOpen(false);
    ui.setIntegrationsCatalogOpen(true);
  };

  return (
    <SettingsPageLayout
      title={t('settings.page.integrations.title')}
      description={t('settings.page.integrations.description')}
      showSaveStatus
      headerEnd={canBrowseCatalog ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-9 shrink-0 gap-1.5"
          data-settings-item="integrations.browse"
          title={t('settings.integrations.browse.hint')}
          onClick={openCatalog}
        >
          <Icon name="store-2" className="size-4" />
          {t('settings.integrations.browse.label')}
        </Button>
      ) : null}
    >
      {hasBuiltIn ? (
        <SettingsSection
          title={t('settings.integrations.firstParty.title')}
          info={t('settings.integrations.firstParty.info')}
          divider={false}
          settingsItem="integrations.first-party"
          contentClassName="space-y-3"
        >
          {servedSourceControl.map((descriptor) => (
            <SourceControlProviderCard key={descriptor.id} descriptor={descriptor} />
          ))}
          {servedTrackers.map((descriptor) => (
            <TrackerSettings key={descriptor.id} descriptor={descriptor} />
          ))}
          {builtInGuests.map((guest) => <GuestIntegrationCard key={`${runtimeKey}:${guest.id}`} guest={guest} />)}
        </SettingsSection>
      ) : null}
      {hasThirdParty ? <ThirdPartyIntegrationsSection divider={hasBuiltIn} /> : null}
      <CatalogExtensionsSection divider={hasBuiltIn || hasThirdParty} />
      <GuestIntegrationsSection />
    </SettingsPageLayout>
  );
};
