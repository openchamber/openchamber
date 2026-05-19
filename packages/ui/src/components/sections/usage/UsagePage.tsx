import React from 'react';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
import type { UsageWindows, QuotaProviderId } from '@/types';
import { getAllModelFamilies, getDisplayModelName, sortModelFamilies, groupModelsByFamilyWithGetter } from '@/lib/quota/model-families';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Icon } from "@/components/icon/Icon";
import { useI18n } from '@/lib/i18n';
import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';

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
  const { t } = useI18n();
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
  const fetchProviderQuota = useQuotaStore((state) => state.fetchProviderQuota);

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
  const [opencodeGoWorkspaceId, setOpencodeGoWorkspaceId] = React.useState('');
  const [opencodeGoSessionCookie, setOpencodeGoSessionCookie] = React.useState('');
  const [isSavingOpencodeGoAccess, setIsSavingOpencodeGoAccess] = React.useState(false);
  const [opencodeGoAccessMessage, setOpencodeGoAccessMessage] = React.useState<string | null>(null);
  const [opencodeGoAccessError, setOpencodeGoAccessError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;

    const loadOpencodeGoAccess = async () => {
      try {
        const runtimeSettings = getRegisteredRuntimeAPIs()?.settings;
        if (runtimeSettings) {
          const result = await runtimeSettings.load();
          if (cancelled) return;
          const settings = result?.settings as Record<string, unknown> | undefined;
          setOpencodeGoWorkspaceId(typeof settings?.opencodeGoWorkspaceId === 'string' ? settings.opencodeGoWorkspaceId : '');
          setOpencodeGoSessionCookie(typeof settings?.opencodeGoSessionCookie === 'string' ? settings.opencodeGoSessionCookie : '');
          return;
        }

        const response = await fetch('/api/config/settings', {
          method: 'GET',
          headers: { Accept: 'application/json' },
        });
        const settings = await response.json().catch(() => null) as Record<string, unknown> | null;
        if (cancelled) return;
        setOpencodeGoWorkspaceId(typeof settings?.opencodeGoWorkspaceId === 'string' ? settings.opencodeGoWorkspaceId : '');
        setOpencodeGoSessionCookie(typeof settings?.opencodeGoSessionCookie === 'string' ? settings.opencodeGoSessionCookie : '');
      } catch (error) {
        console.warn('Failed to load OpenCode Go access settings:', error);
      }
    };

    void loadOpencodeGoAccess();
    return () => {
      cancelled = true;
    };
  }, []);

  const saveOpencodeGoAccess = React.useCallback(async () => {
    setIsSavingOpencodeGoAccess(true);
    setOpencodeGoAccessMessage(null);
    setOpencodeGoAccessError(null);

    const payload = {
      opencodeGoWorkspaceId: opencodeGoWorkspaceId.trim(),
      opencodeGoSessionCookie: opencodeGoSessionCookie.trim(),
    };

    try {
      const runtimeSettings = getRegisteredRuntimeAPIs()?.settings;
      if (runtimeSettings) {
        await runtimeSettings.save(payload);
      } else {
        const response = await fetch('/api/config/settings', {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify(payload),
        });
        if (!response.ok) {
          const data = await response.json().catch(() => null);
          throw new Error(typeof data?.error === 'string' ? data.error : 'Failed to save OpenCode Go access settings');
        }
      }

      await fetchProviderQuota('opencode-go');
      setOpencodeGoAccessMessage('Saved. OpenCode Go usage has been refreshed.');
    } catch (error) {
      setOpencodeGoAccessError(error instanceof Error ? error.message : 'Failed to save OpenCode Go access settings');
    } finally {
      setIsSavingOpencodeGoAccess(false);
    }
  }, [fetchProviderQuota, opencodeGoSessionCookie, opencodeGoWorkspaceId]);

  if (!selectedProviderId) {
    return (
        <div className="flex h-full items-center justify-center text-muted-foreground">
        <p className="typography-body">{t('settings.usage.page.empty.selectProvider')}</p>
      </div>
    );
  }

  return (
    <ScrollableOverlay outerClassName="h-full" className="w-full">
      <div className="mx-auto w-full max-w-3xl p-3 sm:p-6 sm:pt-8">

        {/* Header */}
        <div className="mb-4 flex items-center gap-3">
          <ProviderLogo providerId={selectedProviderId} className="h-5 w-5 shrink-0" />
          <div className="min-w-0">
            <h2 className="typography-ui-header font-semibold text-foreground truncate">
              {t('settings.usage.page.header.providerUsage', { provider: providerName })}
            </h2>
            <p className="typography-meta text-muted-foreground truncate">
              {isLoading ? (
                <span className="animate-pulse">{t('settings.usage.page.header.refreshing')}</span>
              ) : (
                t('settings.usage.page.header.lastUpdated', { time: formatTime(lastUpdated) })
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
                ariaLabel={t('settings.usage.page.options.showInHeaderAria')}
              />
              <div className="flex min-w-0 items-center gap-1.5">
              <span className="typography-ui-label text-foreground">{t('settings.usage.page.options.showInHeader')}</span>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Icon name="information" className="h-3.5 w-3.5 text-muted-foreground/60 cursor-help" />
                </TooltipTrigger>
                <TooltipContent sideOffset={8} className="max-w-xs">
                  {t('settings.usage.page.options.showInHeaderTooltip')}
                </TooltipContent>
              </Tooltip>
            </div>
          </div>
        </div>

        {/* State Messages */}
        {!selectedResult && (
          <div className="mb-8 px-2">
            <p className="typography-ui-label text-foreground">{t('settings.usage.page.state.noData')}</p>
          </div>
        )}

        {error && (
          <div className="mb-8 rounded-lg border border-[var(--status-error-border)] bg-[var(--status-error-background)] px-4 py-3">
            <p className="typography-ui-label font-medium text-[var(--status-error)]">{t('settings.usage.page.state.refreshFailedTitle')}</p>
            <p className="typography-meta text-[var(--status-error)]/80 mt-1">{error}</p>
          </div>
        )}

        {selectedResult && !selectedResult.configured && (
          <div className="mb-8 rounded-lg border border-[var(--status-warning-border)] bg-[var(--status-warning-background)] px-4 py-3">
            <p className="typography-ui-label font-medium text-[var(--status-warning)]">{t('settings.usage.page.state.providerNotConfiguredTitle')}</p>
            <p className="typography-meta text-[var(--status-warning)]/80 mt-1">
              {t('settings.usage.page.state.providerNotConfiguredDescription')}
            </p>
          </div>
        )}

        {selectedProviderId === 'opencode-go' && (
          <div className="mb-8">
            <div className="mb-1 px-1">
              <h3 className="typography-ui-header font-medium text-foreground">Dashboard Access</h3>
              <p className="typography-meta mt-1 text-muted-foreground">
                OpenCode Go subscription usage comes from the opencode.ai dashboard. The API key is not enough on its own, so add your workspace ID and a logged-in dashboard session here.
              </p>
            </div>
            <section className="space-y-3 p-2">
              <div className="space-y-1.5">
                <span className="typography-ui-label text-foreground">Workspace ID</span>
                <Input
                  className="h-7"
                  value={opencodeGoWorkspaceId}
                  onChange={(event) => setOpencodeGoWorkspaceId(event.target.value)}
                  placeholder="wrk_..."
                />
              </div>
              <div className="space-y-1.5">
                <span className="typography-ui-label text-foreground">Dashboard Session Cookie</span>
                <Input
                  type="password"
                  className="h-7"
                  value={opencodeGoSessionCookie}
                  onChange={(event) => setOpencodeGoSessionCookie(event.target.value)}
                  placeholder="Paste the auth cookie value"
                />
                <p className="typography-meta text-muted-foreground">
                  Paste the `auth` cookie value from a logged-in `opencode.ai` dashboard session. This is stored locally in your OpenChamber settings.
                </p>
              </div>
              <div className="flex items-center gap-2 pt-1">
                <Button size="sm" onClick={() => void saveOpencodeGoAccess()} disabled={isSavingOpencodeGoAccess}>
                  {isSavingOpencodeGoAccess ? 'Saving…' : 'Save and Refresh'}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setOpencodeGoWorkspaceId('');
                    setOpencodeGoSessionCookie('');
                    setOpencodeGoAccessMessage(null);
                    setOpencodeGoAccessError(null);
                  }}
                  disabled={isSavingOpencodeGoAccess}
                >
                  Clear Draft
                </Button>
              </div>
              {opencodeGoAccessMessage && (
                <p className="typography-meta text-[var(--status-success)]">{opencodeGoAccessMessage}</p>
              )}
              {opencodeGoAccessError && (
                <p className="typography-meta text-[var(--status-error)]">{opencodeGoAccessError}</p>
              )}
            </section>
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
              <h3 className="typography-ui-header font-medium text-foreground">{t('settings.usage.page.section.modelQuotas')}</h3>
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
            </div>
          </div>
        )}

        {selectedResult?.configured && usage && Object.keys(usage.windows ?? {}).length === 0 &&
          providerModels.length === 0 && (
          <div className="mb-8 px-2">
            <p className="typography-ui-label text-foreground">{t('settings.usage.page.state.noQuotaWindowsTitle')}</p>
            <p className="typography-meta text-muted-foreground mt-1">{t('settings.usage.page.state.noQuotaWindowsDescription')}</p>
          </div>
        )}

      </div>
    </ScrollableOverlay>
  );
};
