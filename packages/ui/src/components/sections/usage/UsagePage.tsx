import React from 'react';
import { UsageCard } from './UsageCard';
import { QuotaCredentials } from './QuotaCredentials';
import { QUOTA_PROVIDERS } from '@/lib/quota';
import { useQuotaAutoRefresh, useQuotaStore } from '@/stores/useQuotaStore';
import { updateDesktopSettings } from '@/lib/persistence';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import type { UsageWindows, QuotaProviderId } from '@/types';
import { getAllModelFamilies, getDisplayModelName, sortModelFamilies, groupModelsByFamilyWithGetter } from '@/lib/quota/model-families';
import { Icon } from "@/components/icon/Icon";
import { useI18n } from '@/lib/i18n';
import { formatTimeForPreference } from '@/lib/timeFormat';
import { useUIStore, type TimeFormatPreference } from '@/stores/useUIStore';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import {
  SettingsSection,
  SettingsCheckboxRow,
} from '@/components/sections/shared/SettingsSection';

const formatTime = (timestamp: number | null, timeFormatPreference: TimeFormatPreference) => {
  if (!timestamp) return '-';
  try {
    return formatTimeForPreference(timestamp, timeFormatPreference, { fallback: '-' });
  } catch {
    return '-';
  }
};

interface ModelInfo {
  name: string;
  windows: UsageWindows;
}

export const UsagePage: React.FC = () => {
  const { t } = useI18n();
  const timeFormatPreference = useUIStore((state) => state.timeFormatPreference);
  const results = useQuotaStore((state) => state.results);
  const selectedProviderId = useQuotaStore((state) => state.selectedProviderId);
  const setSelectedProvider = useQuotaStore((state) => state.setSelectedProvider);
  const loadSettings = useQuotaStore((state) => state.loadSettings);
  const fetchAllQuotas = useQuotaStore((state) => state.fetchAllQuotas);
  const isLoading = useQuotaStore((state) => state.isLoading);
  const lastUpdated = useQuotaStore((state) => state.lastUpdated);
  const error = useQuotaStore((state) => state.error);
  const dropdownProviderIds = useQuotaStore((state) => state.dropdownProviderIds);
  const setDropdownProviderIds = useQuotaStore((state) => state.setDropdownProviderIds);
  const selectedModels = useQuotaStore((state) => state.selectedModels);
  const toggleModelSelected = useQuotaStore((state) => state.toggleModelSelected);
  const applyDefaultSelections = useQuotaStore((state) => state.applyDefaultSelections);

  useQuotaAutoRefresh();

  React.useEffect(() => {
    void loadSettings();
    void fetchAllQuotas();
  }, [loadSettings, fetchAllQuotas]);

  React.useEffect(() => {
    if (selectedProviderId) {
      return;
    }
    if (results.length === 0) {
      return;
    }
    const firstConfigured = results.find((entry) => entry.configured)?.providerId;
    setSelectedProvider(firstConfigured ?? QUOTA_PROVIDERS[0]?.id ?? null);
  }, [results, selectedProviderId, setSelectedProvider]);

  const selectedResult = results.find((entry) => entry.providerId === selectedProviderId) ?? null;

  const providerMeta = QUOTA_PROVIDERS.find((provider) => provider.id === selectedProviderId);
  const providerName = providerMeta?.name ?? selectedProviderId ?? t('settings.usage.sidebar.title');
  const usage = selectedResult?.usage;
  const showInDropdown = selectedProviderId ? dropdownProviderIds.includes(selectedProviderId) : false;
  const hasCredentialsForm = selectedProviderId === 'opencode-go' || selectedProviderId === 'ollama-cloud' || selectedProviderId === 'cursor';
  const handleDropdownToggle = React.useCallback((enabled: boolean) => {
    if (!selectedProviderId) {
      return;
    }
    const next = enabled
      ? Array.from(new Set([...dropdownProviderIds, selectedProviderId]))
      : dropdownProviderIds.filter((id) => id !== selectedProviderId);
    setDropdownProviderIds(next);
    void updateDesktopSettings({ usageDropdownProviders: next });
  }, [dropdownProviderIds, selectedProviderId, setDropdownProviderIds]);

  const providerModels = React.useMemo((): ModelInfo[] => {
    if (!usage?.models) return [];
    return Object.entries(usage.models)
      .map(([name, modelUsage]) => ({ name, windows: modelUsage }))
      .filter((model) => Object.keys(model.windows.windows).length > 0);
  }, [usage?.models]);

  React.useEffect(() => {
    if (selectedProviderId && providerModels.length > 0) {
      applyDefaultSelections(selectedProviderId, providerModels.map((m) => m.name));
    }
  }, [selectedProviderId, providerModels, applyDefaultSelections]);

  const modelsByFamily = React.useMemo(() => {
    if (!selectedProviderId || providerModels.length === 0) {
      return new Map<string | null, ModelInfo[]>();
    }
    return groupModelsByFamilyWithGetter(
      providerModels,
      (model) => model.name,
      selectedProviderId as QuotaProviderId
    );
  }, [providerModels, selectedProviderId]);

  const sortedFamilies = React.useMemo(() => {
    if (!selectedProviderId) return [];
    const families = getAllModelFamilies(selectedProviderId as QuotaProviderId);
    return sortModelFamilies(families);
  }, [selectedProviderId]);

  const [collapsedFamilies, setCollapsedFamilies] = React.useState<Record<string, boolean>>(() => {
    return {};
  });

  const toggleFamilyCollapsed = React.useCallback((familyId: string) => {
    setCollapsedFamilies((prev) => ({
      ...prev,
      [familyId]: !prev[familyId],
    }));
  }, []);

  const handleModelToggle = React.useCallback((modelName: string) => {
    if (!selectedProviderId) return;
    toggleModelSelected(selectedProviderId, modelName);
    const currentSelected = selectedModels[selectedProviderId] ?? [];
    const isSelected = currentSelected.includes(modelName);
    const nextSelected = isSelected
      ? currentSelected.filter((m) => m !== modelName)
      : [...currentSelected, modelName];
    const nextSettings: Record<string, string[]> = { ...selectedModels, [selectedProviderId]: nextSelected };
    void updateDesktopSettings({ usageSelectedModels: nextSettings });
  }, [selectedProviderId, selectedModels, toggleModelSelected]);

  const providerSelectedModels = selectedProviderId ? (selectedModels[selectedProviderId] ?? []) : [];

  if (!selectedProviderId) {
    return (
        <div className="flex h-full items-center justify-center text-muted-foreground">
        <p className="typography-body">{t('settings.usage.page.empty.selectProvider')}</p>
      </div>
    );
  }

  return (
    <SettingsPageLayout
      title={t('settings.usage.page.header.providerUsage', { provider: providerName })}
      titleLeading={<ProviderLogo providerId={selectedProviderId} className="h-5 w-5 shrink-0" />}
      description={
        isLoading ? (
          <span className="animate-pulse typography-settings-description text-muted-foreground">{t('settings.usage.page.header.refreshing')}</span>
        ) : (
          t('settings.usage.page.header.lastUpdated', { time: formatTime(lastUpdated, timeFormatPreference) })
        )
      }
      showSaveStatus
    >
      <SettingsSection divider={false} settingsItem="usage.header-menu">
        <SettingsCheckboxRow
          checked={showInDropdown}
          onChange={handleDropdownToggle}
          label={t('settings.usage.page.options.showInHeader')}
          ariaLabel={t('settings.usage.page.options.showInHeaderAria')}
          info={t('settings.usage.page.options.showInHeaderTooltip')}
        />
      </SettingsSection>

      {!selectedResult && (
        <p className="typography-ui-label text-foreground pb-8">{t('settings.usage.page.state.noData')}</p>
      )}

      {error && (
        <div className="mb-8 rounded-lg border border-[var(--status-error-border)] bg-[var(--status-error-background)] px-4 py-3">
          <p className="typography-ui-label font-medium text-[var(--status-error)]">{t('settings.usage.page.state.refreshFailedTitle')}</p>
          <p className="typography-meta text-[var(--status-error)]/80 mt-1">{error}</p>
        </div>
      )}

      {/* Providers with an inline credentials form don't need the "go to Providers" banner — the form IS the fix. */}
      {selectedResult && !selectedResult.configured && !hasCredentialsForm && (
        <div className="mb-8 rounded-lg border border-[var(--status-warning-border)] bg-[var(--status-warning-background)] px-4 py-3">
          <p className="typography-ui-label font-medium text-[var(--status-warning)]">{t('settings.usage.page.state.providerNotConfiguredTitle')}</p>
          <p className="typography-meta text-[var(--status-warning)]/80 mt-1">
            {t('settings.usage.page.state.providerNotConfiguredDescription')}
          </p>
        </div>
      )}

      {(selectedProviderId === 'opencode-go' || selectedProviderId === 'ollama-cloud' || selectedProviderId === 'cursor') && (
        <QuotaCredentials providerId={selectedProviderId} providerName={providerName} />
      )}

      {usage?.windows && Object.keys(usage.windows).length > 0 && (
        <SettingsSection settingsItem="usage.model-quotas">
          <div className="divide-y divide-[var(--surface-subtle)]">
            {Object.entries(usage.windows).map(([label, window]) => (
              <UsageCard key={label} title={label} window={window} />
            ))}
          </div>
        </SettingsSection>
      )}

      {providerModels.length > 0 && (
        <SettingsSection
          title={t('settings.usage.page.section.modelQuotas')}
          contentClassName="space-y-3"
        >
          {sortedFamilies.map((family) => {
            const familyModels = modelsByFamily.get(family.id) ?? [];
            if (familyModels.length === 0) return null;

            const isCollapsed = collapsedFamilies[family.id] ?? false;

            return (
              <section key={family.id} className="p-2">
                <Collapsible
                  open={!isCollapsed}
                  onOpenChange={() => toggleFamilyCollapsed(family.id)}
                >
                  <CollapsibleTrigger className="flex w-full items-center justify-between py-0.5 group">
                    <div className="flex items-center gap-1.5 text-left">
                      <span className="typography-ui-label font-normal text-foreground">{family.label}</span>
                      <span className="typography-micro text-muted-foreground">
                        ({familyModels.length})
                      </span>
                    </div>
                    {isCollapsed ? (
                      <Icon name="arrow-right-s" className="h-4 w-4 text-muted-foreground group-hover:text-foreground transition-colors" />
                    ) : (
                      <Icon name="arrow-down-s" className="h-4 w-4 text-muted-foreground group-hover:text-foreground transition-colors" />
                    )}
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <div className="divide-y divide-[var(--surface-subtle)] mt-1">
                      {familyModels.map((model) => {
                        const entries = Object.entries(model.windows.windows);
                        if (entries.length === 0) return null;
                        const [label, window] = entries[0];
                        const isSelected = providerSelectedModels.includes(model.name);

                        return (
                          <UsageCard
                            key={model.name}
                            title={label}
                            subtitle={getDisplayModelName(model.name)}
                            window={window}
                            showToggle
                            toggleEnabled={isSelected}
                            onToggle={() => handleModelToggle(model.name)}
                          />
                        );
                      })}
                    </div>
                  </CollapsibleContent>
                </Collapsible>
              </section>
            );
          })}

          {(() => {
            const otherModels = modelsByFamily.get(null) ?? [];
            if (otherModels.length === 0) return null;

            const isCollapsed = collapsedFamilies['other'] ?? false;

            return (
              <section className="p-2">
                <Collapsible
                  open={!isCollapsed}
                  onOpenChange={() => toggleFamilyCollapsed('other')}
                >
                  <CollapsibleTrigger className="flex w-full items-center justify-between py-0.5 group">
                    <div className="flex items-center gap-1.5 text-left">
                      <span className="typography-ui-label font-normal text-foreground">{t('settings.usage.page.section.otherModels')}</span>
                      <span className="typography-micro text-muted-foreground">
                        ({otherModels.length})
                      </span>
                    </div>
                    {isCollapsed ? (
                      <Icon name="arrow-right-s" className="h-4 w-4 text-muted-foreground group-hover:text-foreground transition-colors" />
                    ) : (
                      <Icon name="arrow-down-s" className="h-4 w-4 text-muted-foreground group-hover:text-foreground transition-colors" />
                    )}
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <div className="divide-y divide-[var(--surface-subtle)] mt-1">
                      {otherModels.map((model) => {
                        const entries = Object.entries(model.windows.windows);
                        if (entries.length === 0) return null;
                        const [label, window] = entries[0];
                        const isSelected = providerSelectedModels.includes(model.name);

                        return (
                          <UsageCard
                            key={model.name}
                            title={label}
                            subtitle={getDisplayModelName(model.name)}
                            window={window}
                            showToggle
                            toggleEnabled={isSelected}
                            onToggle={() => handleModelToggle(model.name)}
                          />
                        );
                      })}
                    </div>
                  </CollapsibleContent>
                </Collapsible>
              </section>
            );
          })()}
        </SettingsSection>
      )}

      {selectedResult?.configured && usage && Object.keys(usage.windows ?? {}).length === 0 &&
        providerModels.length === 0 && (
        <div className="pb-8">
          <p className="typography-ui-label text-foreground">{t('settings.usage.page.state.noQuotaWindowsTitle')}</p>
          <p className="typography-meta text-muted-foreground mt-1">{t('settings.usage.page.state.noQuotaWindowsDescription')}</p>
        </div>
      )}
    </SettingsPageLayout>
  );
};
