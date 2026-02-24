import React from 'react';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { Checkbox } from '@/components/ui/checkbox';
import { UsageCard } from './UsageCard';
import { QUOTA_PROVIDERS } from '@/lib/quota';
import { useQuotaAutoRefresh, useQuotaStore } from '@/stores/useQuotaStore';
import { updateDesktopSettings } from '@/lib/persistence';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { RiArrowDownSLine, RiArrowRightSLine, RiInformationLine } from '@remixicon/react';
import type { UsageWindows, QuotaProviderId } from '@/types';
import { getAllModelFamilies, getDisplayModelName, sortModelFamilies, groupModelsByFamilyWithGetter } from '@/lib/quota/model-families';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

const formatTime = (timestamp: number | null) => {
  if (!timestamp) return '-';
  try {
    return new Date(timestamp).toLocaleTimeString(undefined, {
      hour: 'numeric',
      minute: '2-digit'
    });
  } catch {
    return '-';
  }
};

interface ModelInfo {
  name: string;
  windows: UsageWindows;
}

export const UsagePage: React.FC = () => {
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
  const providerName = providerMeta?.name ?? selectedProviderId ?? 'Usage';
  const usage = selectedResult?.usage;
  const showInDropdown = selectedProviderId ? dropdownProviderIds.includes(selectedProviderId) : false;
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
        <p className="typography-body">Select a provider to view usage details.</p>
      </div>
    );
  }

  return (
    <ScrollableOverlay keyboardAvoid outerClassName="h-full" className="w-full">
      <div className="mx-auto w-full max-w-3xl p-3 sm:p-6 sm:pt-8">

        {/* Header */}
        <div className="mb-4 flex items-center gap-3">
          <ProviderLogo providerId={selectedProviderId} className="h-5 w-5 shrink-0" />
          <div className="min-w-0">
            <h2 className="typography-ui-header font-semibold text-foreground truncate">
              {providerName} Usage
            </h2>
            <p className="typography-meta text-muted-foreground truncate">
              {isLoading ? (
                <span className="animate-pulse">Refreshing usage...</span>
              ) : (
                `Last updated: ${formatTime(lastUpdated)}`
              )}
            </p>
          </div>
        </div>

        {/* Options */}
        <div className="mb-8 px-2">
          <div
            className="group flex cursor-pointer items-center gap-2 py-1.5"
            role="button"
            tabIndex={0}
            aria-pressed={showInDropdown}
            onClick={() => handleDropdownToggle(!showInDropdown)}
            onKeyDown={(event) => {
              if (event.key === ' ' || event.key === 'Enter') {
                event.preventDefault();
                handleDropdownToggle(!showInDropdown);
              }
            }}
          >
            <Checkbox
              checked={showInDropdown}
              onChange={handleDropdownToggle}
              ariaLabel="Show in header menu"
            />
            <div className="flex min-w-0 items-center gap-1.5">
              <span className="typography-ui-label text-foreground">Show in Header Menu</span>
              <Tooltip delayDuration={1000}>
                <TooltipTrigger asChild>
                  <RiInformationLine className="h-3.5 w-3.5 text-muted-foreground/60 cursor-help" />
                </TooltipTrigger>
                <TooltipContent sideOffset={8} className="max-w-xs">
                  When enabled, this provider's usage will be visible in the quick access dropdown menu in the app header.
                </TooltipContent>
              </Tooltip>
            </div>
          </div>
        </div>

        {/* State Messages */}
        {!selectedResult && (
          <div className="mb-8 px-2">
            <p className="typography-ui-label text-foreground">No usage data available yet.</p>
          </div>
        )}

        {error && (
          <div className="mb-8 rounded-lg border border-[var(--status-error-border)] bg-[var(--status-error-background)] px-4 py-3">
            <p className="typography-ui-label font-medium text-[var(--status-error)]">Failed to refresh usage data</p>
            <p className="typography-meta text-[var(--status-error)]/80 mt-1">{error}</p>
          </div>
        )}

        {selectedResult && !selectedResult.configured && (
          <div className="mb-8 rounded-lg border border-[var(--status-warning-border)] bg-[var(--status-warning-background)] px-4 py-3">
            <p className="typography-ui-label font-medium text-[var(--status-warning)]">Provider not configured</p>
            <p className="typography-meta text-[var(--status-warning)]/80 mt-1">
              Add credentials in the Providers tab to enable usage tracking.
            </p>
          </div>
        )}

        {/* Overall Usage Windows */}
        {usage?.windows && Object.keys(usage.windows).length > 0 && (
          <div className="mb-8">
            <section className="px-2 pb-2 pt-0">
              <div className="divide-y divide-[var(--surface-subtle)]">
                {Object.entries(usage.windows).map(([label, window]) => (
                  <UsageCard key={label} title={label} window={window} />
                ))}
              </div>
            </section>
          </div>
        )}

        {/* Models Section */}
        {providerModels.length > 0 && (
          <div className="mb-8">
            <div className="mb-1 px-1">
              <h3 className="typography-ui-header font-medium text-foreground">Model Quotas</h3>
            </div>

            <div className="space-y-3">
              {/* Predefined families */}
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
                          <RiArrowRightSLine className="h-4 w-4 text-muted-foreground group-hover:text-foreground transition-colors" />
                        ) : (
                          <RiArrowDownSLine className="h-4 w-4 text-muted-foreground group-hover:text-foreground transition-colors" />
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

              {/* Other family */}
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
                          <span className="typography-ui-label font-normal text-foreground">Other Models</span>
                          <span className="typography-micro text-muted-foreground">
                            ({otherModels.length})
                          </span>
                        </div>
                        {isCollapsed ? (
                          <RiArrowRightSLine className="h-4 w-4 text-muted-foreground group-hover:text-foreground transition-colors" />
                        ) : (
                          <RiArrowDownSLine className="h-4 w-4 text-muted-foreground group-hover:text-foreground transition-colors" />
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
            </div>
          </div>
        )}

        {selectedResult?.configured && usage && Object.keys(usage.windows ?? {}).length === 0 &&
          providerModels.length === 0 && (
          <div className="mb-8 px-2">
            <p className="typography-ui-label text-foreground">No quota windows reported</p>
            <p className="typography-meta text-muted-foreground mt-1">This provider does not currently report any rate limits or usage quotas.</p>
          </div>
        )}

      </div>
    </ScrollableOverlay>
  );
};
