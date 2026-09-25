import { matchesRankQuery, rankByQuery } from '@/lib/search/fuzzySearch';
import React from 'react';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { SettingsSection, SETTINGS_CUSTOM_TRIGGER_CLASS } from '@/components/sections/shared/SettingsSection';
import { SettingsInfoHint } from '@/components/sections/shared/SettingsInfoHint';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import { selectProvidersForDirectory, useConfigStore } from '@/stores/useConfigStore';
import { useSettingsDirectory } from '@/hooks/useSettingsDirectory';
import { useUIStore } from '@/stores/useUIStore';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { toast } from '@/components/ui';
import { Icon } from "@/components/icon/Icon";
import type { IconName } from "@/components/icon/icons";
import { cn } from '@/lib/utils';
import type { ModelMetadata } from '@/types';
import { getCurrentIntlLocale, useI18n } from '@/lib/i18n';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { opencodeClient } from '@/lib/opencode/client';
import { listWebSearchProviders } from '@/lib/opencode/websearch';
import type { IntegrationInfo } from '@opencode/client';
import type { Provider } from '@/lib/opencode/model';
import { z } from 'zod';
import { requiresProviderAuth, shouldLoadAvailableProviders } from './providerAvailability';
import {
  providerHasCredentials,
  shouldAutoOpenAuthPanel,
  shouldShowApiKeyAuth,
  shouldShowModelsSection,
  findIntegrationForProvider,
  getCredentialConnections,
  getOAuthMethods,
  getProviderConnections,
  getSignInIntegrationId,
} from './providerAuth';
import { CustomProviderForm } from './CustomProviderForm';

import { ProviderOAuthMethods } from './ProviderOAuthMethods';
import {
  buildIntegrationKeyRequest,
  buildProviderUpsertRequest,
  CUSTOM_PROVIDER_ID,
  isConfigDefinedCustomProvider,
  providerToEditFormState,
  resolveProviderConfigScope,
  storedProviderEntrySchema,
  type CustomProviderFormState,
  type CustomProviderPersistPlan,
  type ProviderConfigScope,
  type StoredProviderEntry,
} from './custom-provider-form';

const formatCompactNumber = (value: number) => new Intl.NumberFormat(getCurrentIntlLocale(), {
  notation: 'compact',
  compactDisplay: 'short',
  maximumFractionDigits: 1,
  minimumFractionDigits: 0,
}).format(value);

const formatTokens = (value?: number | null) => {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return null;
  }
  if (value === 0) {
    return '0';
  }
  const formatted = formatCompactNumber(value);
  return formatted.endsWith('.0') ? formatted.slice(0, -2) : formatted;
};

const ADD_PROVIDER_ID = '__add_provider__';

interface ProviderOption {
  id: string;
  name?: string;
}

interface ProviderSourceInfo {
  exists: boolean;
  path?: string | null;
}

interface ProviderSources {
  user: ProviderSourceInfo;
  project: ProviderSourceInfo;
  custom?: ProviderSourceInfo;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const normalizeProviderEntry = (entry: unknown): ProviderOption | null => {
  if (typeof entry === 'string') {
    return { id: entry };
  }
  if (!isRecord(entry)) {
    return null;
  }
  const idCandidate =
    (typeof entry.id === 'string' && entry.id) ||
    (typeof entry.providerID === 'string' && entry.providerID) ||
    (typeof entry.slug === 'string' && entry.slug) ||
    (typeof entry.name === 'string' && entry.name);
  if (!idCandidate) {
    return null;
  }
  const nameCandidate = typeof entry.name === 'string' ? entry.name : undefined;
  return { id: idCandidate, name: nameCandidate };
};

const parseProvidersPayload = (payload: unknown): ProviderOption[] => {
  let entries: unknown[] = [];

  if (Array.isArray(payload)) {
    entries = payload;
  } else if (isRecord(payload)) {
    if (Array.isArray(payload.all)) {
      entries = payload.all;
    } else if (Array.isArray(payload.providers)) {
      entries = payload.providers;
    }
  }

  const mapped = entries
    .map((entry) => normalizeProviderEntry(entry))
    .filter((entry): entry is ProviderOption => Boolean(entry));

  const seen = new Set<string>();
  return mapped.filter((entry) => {
    if (seen.has(entry.id)) {
      return false;
    }
    seen.add(entry.id);
    return true;
  });
};

/**
 * An API key written straight into the provider entry. OpenCode 2 keeps request
 * settings under `settings`, an open record whose typed keys (timeout,
 * compaction, transport since 2.0.10) never include the key itself, so it is
 * read as a free-form entry and kept only when it is a string.
 */
const providerApiKeySetting = z.string();
const readProviderApiKeySetting = (provider: Pick<Provider, 'settings'> | undefined): string | null =>
  providerApiKeySetting.safeParse(provider?.settings?.apiKey).data ?? null;

export const ProvidersPage: React.FC = () => {
  const { t } = useI18n();
  // Settings browses whichever project its own selector points at; the app
  // stays where it is.
  const settingsDirectory = useSettingsDirectory();
  const providers = useConfigStore((state) => selectProvidersForDirectory(state, settingsDirectory));
  const selectedProviderId = useConfigStore((state) => state.selectedProviderId);
  const setSelectedProvider = useConfigStore((state) => state.setSelectedProvider);
  const getModelMetadata = useConfigStore((state) => state.getModelMetadata);
  const hiddenModels = useUIStore((state) => state.hiddenModels);
  const toggleHiddenModel = useUIStore((state) => state.toggleHiddenModel);
  const hideAllModels = useUIStore((state) => state.hideAllModels);
  const showAllModels = useUIStore((state) => state.showAllModels);

  const [integrations, setIntegrations] = React.useState<IntegrationInfo[] | null>(null);
  const [authLoading, setAuthLoading] = React.useState(false);
  const [apiKeyInputs, setApiKeyInputs] = React.useState<Record<string, string>>({});
  const [authBusyKey, setAuthBusyKey] = React.useState<string | null>(null);
  const [modelQuery, setModelQuery] = React.useState('');
  const [availableProviders, setAvailableProviders] = React.useState<ProviderOption[]>([]);
  const [availableLoading, setAvailableLoading] = React.useState(false);
  const [availableError, setAvailableError] = React.useState<string | null>(null);
  const [candidateProviderId, setCandidateProviderId] = React.useState('');
  const [providerSearchQuery, setProviderSearchQuery] = React.useState('');
  const [providerDropdownOpen, setProviderDropdownOpen] = React.useState(false);
  const [providerSources, setProviderSources] = React.useState<Record<string, ProviderSources>>({});
  // The config-file entry per provider; the edit form starts from it, not from
  // the live provider (which lacks `env` and carries generated reasoning levels).
  const [storedProviderConfigs, setStoredProviderConfigs] = React.useState<Record<string, StoredProviderEntry | null>>({});
  // Bumped after auth writes so the source snapshot is refetched even when the
  // selected provider id is unchanged (OAuth/API key success path).
  const [providerSourcesRevision, setProviderSourcesRevision] = React.useState(0);
  // Bumped after a credential write so the integration snapshot (which owns the
  // "connected" signal in v2) is refetched even when the selection is unchanged.
  const [integrationsRevision, setIntegrationsRevision] = React.useState(0);
  const [showAuthPanel, setShowAuthPanel] = React.useState(false);
  const [authPanelDismissedForId, setAuthPanelDismissedForId] = React.useState<string | null>(null);
  const [editingCustomProviderId, setEditingCustomProviderId] = React.useState<string | null>(null);
  const [editingCustomFormInitial, setEditingCustomFormInitial] = React.useState<CustomProviderFormState | null>(null);
  const [editingCustomScope, setEditingCustomScope] = React.useState<ProviderConfigScope | null>(null);
  const [customAuthFailureHint, setCustomAuthFailureHint] = React.useState<string | null>(null);
  const [lastCustomPersistId, setLastCustomPersistId] = React.useState<string | null>(null);
  const isAddMode = selectedProviderId === ADD_PROVIDER_ID;
  const isCustomCreateMode = isAddMode && candidateProviderId === CUSTOM_PROVIDER_ID;
  const isCustomEditMode = Boolean(
    editingCustomProviderId
    && selectedProviderId
    && editingCustomProviderId === selectedProviderId
    && !isAddMode,
  );

  React.useEffect(() => {
    if (!selectedProviderId && providers.length > 0) {
      setSelectedProvider(providers[0].id);
    }
  }, [providers, selectedProviderId, setSelectedProvider]);

  React.useEffect(() => {
    // Auth methods drive which credential UI to show (API key vs OAuth). Keep
    // them loaded for the active provider view so OAuth-only plugins never fall
    // back to an API key form merely because methods were never fetched, and so
    // an already-listed provider can still offer re-authentication.
    if (!selectedProviderId) {
      return;
    }

    let isMounted = true;

    const loadIntegrations = async () => {
      setAuthLoading(true);
      try {
        const { data } = await opencodeClient.getSdkClient().integration.list();
        if (!isMounted) return;
        setIntegrations(data);
      } catch (error) {
        if (!isMounted) return;
        console.error('Failed to load provider integrations:', error);
        toast.error(t('settings.providers.page.toast.authMethodsLoadFailed'));
      } finally {
        if (isMounted) {
          setAuthLoading(false);
        }
      }
    };

    loadIntegrations();

    return () => {
      isMounted = false;
    };
  }, [selectedProviderId, integrationsRevision, t]);

  React.useEffect(() => {
    if (!shouldLoadAvailableProviders(isAddMode)) {
      return;
    }

    let isMounted = true;

    const loadAvailableProviders = async () => {
      setAvailableLoading(true);
      setAvailableError(null);
      try {
        // v2's provider list is what is configured or connected right now;
        // the providers a user can still sign in to are the integrations.
        // MCP servers with OAuth register as integrations too and are not
        // providers, so they are left out. So are web search providers (Exa,
        // Tavily, ...), whose keys live in Settings → Web search; when that
        // list cannot be read they stay in rather than hide real providers.
        const [{ data }, webSearchProviders] = await Promise.all([
          opencodeClient.getSdkClient().integration.list(),
          listWebSearchProviders(opencodeClient.getDirectory() ?? null).catch(() => null),
        ]);
        if (!isMounted) return;
        const webSearchIds = new Set((webSearchProviders ?? []).map((provider) => provider.id));
        setAvailableProviders(parseProvidersPayload(
          data.filter((integration) => !integration.id.startsWith('mcp_')
            && !webSearchIds.has(integration.id)
            && integration.connections.length === 0),
        ));
      } catch (error) {
        if (!isMounted) return;
        console.error('Failed to load available providers:', error);
        setAvailableError(t('settings.providers.page.state.unableToLoadProviderList'));
      } finally {
        if (isMounted) {
          setAvailableLoading(false);
        }
      }
    };

    loadAvailableProviders();

    return () => {
      isMounted = false;
    };
  }, [isAddMode, t]);

  const connectedProviderIds = React.useMemo(
    () => new Set(providers.map((provider) => provider.id)),
    [providers]
  );

  const unconnectedProviders = React.useMemo(
    () =>
      availableProviders
        .filter((provider) => !connectedProviderIds.has(provider.id))
        .sort((a, b) => {
          const labelA = (a.name || a.id).toLowerCase();
          const labelB = (b.name || b.id).toLowerCase();
          return labelA.localeCompare(labelB);
        }),
    [availableProviders, connectedProviderIds]
  );

  React.useEffect(() => {
    if (selectedProviderId !== ADD_PROVIDER_ID) {
      return;
    }

    if (
      candidateProviderId
      && candidateProviderId !== CUSTOM_PROVIDER_ID
      && !unconnectedProviders.some((provider) => provider.id === candidateProviderId)
    ) {
      setCandidateProviderId('');
    }
  }, [selectedProviderId, candidateProviderId, unconnectedProviders]);

  React.useEffect(() => {
    if (selectedProviderId === ADD_PROVIDER_ID) {
      setShowAuthPanel(true);
      setAuthPanelDismissedForId(null);
      setEditingCustomProviderId(null);
      setEditingCustomFormInitial(null);
      setEditingCustomScope(null);
      setCustomAuthFailureHint(null);
      return;
    }

    setShowAuthPanel(false);
    setAuthPanelDismissedForId(null);
    if (editingCustomProviderId && editingCustomProviderId !== selectedProviderId) {
      setEditingCustomProviderId(null);
      setEditingCustomFormInitial(null);
      setEditingCustomScope(null);
      setCustomAuthFailureHint(null);
    }
  }, [selectedProviderId, editingCustomProviderId]);

  // Unauthenticated providers (OAuth-only plugins before login) should open the
  // auth panel instead of a false "Connected" summary. Respect an explicit Hide.
  React.useEffect(() => {
    if (!selectedProviderId || selectedProviderId === ADD_PROVIDER_ID) {
      return;
    }
    const sources = providerSources[selectedProviderId];
    if (!sources || integrations === null) {
      return;
    }
    const provider = providers.find((entry) => entry.id === selectedProviderId);
    const hasCreds = providerHasCredentials({
      connections: getProviderConnections(integrations, selectedProviderId),
      optionsApiKey: readProviderApiKeySetting(provider),
    });
    const isEditableCustomProvider = Boolean(
      provider && isConfigDefinedCustomProvider(provider, sources)
    );
    if (
      shouldAutoOpenAuthPanel({
        integrationsLoaded: true,
        hasCredentials: hasCreds,
        userDismissed: authPanelDismissedForId === selectedProviderId,
        isEditableCustomProvider,
      })
    ) {
      setShowAuthPanel(true);
    }
  }, [selectedProviderId, providerSources, providers, integrations, authPanelDismissedForId]);

  React.useEffect(() => {
    if (!selectedProviderId || selectedProviderId === ADD_PROVIDER_ID) {
      return;
    }

    let cancelled = false;

    const loadSources = async () => {
      try {
        // OpenChamber-only metadata endpoint: the SDK exposes provider data but
        // not local auth/source-file provenance used by this settings UI.
        const query = settingsDirectory ? `?directory=${encodeURIComponent(settingsDirectory)}` : '';
        const response = await runtimeFetch(`/api/provider/${encodeURIComponent(selectedProviderId)}/source${query}`, {
          method: 'GET',
          headers: { Accept: 'application/json' },
        });

        const payload = await response.json().catch(() => null);
        if (!response.ok) {
          throw new Error(payload?.error || t('settings.providers.page.toast.providerSourcesLoadFailed'));
        }

        const sources = (payload?.sources ?? payload?.data?.sources) as ProviderSources | undefined;
        if (!cancelled && sources) {
          setProviderSources((prev) => ({
            ...prev,
            [selectedProviderId]: sources,
          }));
          setStoredProviderConfigs((prev) => ({
            ...prev,
            // A missing or malformed entry falls back to live data in the form.
            [selectedProviderId]: storedProviderEntrySchema.safeParse(payload?.config ?? payload?.data?.config).data ?? null,
          }));
        }
      } catch (error) {
        if (!cancelled) {
          console.error('Failed to load provider sources:', error);
        }
      }
    };

    loadSources();

    return () => {
      cancelled = true;
    };
  }, [selectedProviderId, providerSourcesRevision, settingsDirectory, t]);

  const refreshProviderSources = React.useCallback(() => {
    setProviderSourcesRevision((revision) => revision + 1);
  }, []);

  const refreshIntegrations = React.useCallback(() => {
    setIntegrationsRevision((revision) => revision + 1);
  }, []);

  const markAuthWriteSucceeded = React.useCallback((providerId: string) => {
    // Optimistically record a connection so a providers refresh that has not yet
    // landed cannot reopen the panel / hide models with a stale
    // "Credentials missing" summary before the integration refetch arrives.
    setIntegrations((prev) => (prev ?? []).map((integration) => (
      integration.id === providerId && integration.connections.length === 0
        ? { ...integration, connections: [{ type: 'credential', id: `pending:${providerId}`, label: providerId, method: 'key' }] }
        : integration
    )));
    setAuthPanelDismissedForId(null);
    setShowAuthPanel(false);
    setSelectedProvider(providerId);
    refreshProviderSources();
    refreshIntegrations();
  }, [refreshIntegrations, refreshProviderSources, setSelectedProvider]);

  const selectedProvider = providers.find((provider) => provider.id === selectedProviderId);
  const selectedSources = selectedProviderId ? providerSources[selectedProviderId] : undefined;

  const handleSaveApiKey = async (providerId: string) => {
    const apiKey = apiKeyInputs[providerId]?.trim() ?? '';
    if (!apiKey) {
      toast.error(t('settings.providers.page.toast.apiKeyRequired'));
      return;
    }

    const busyKey = `api:${providerId}`;
    setAuthBusyKey(busyKey);

    try {
      await opencodeClient.getSdkClient().integration.connect.key({
        integrationID: providerId,
        key: apiKey,
      });

      toast.success(t('settings.providers.page.toast.apiKeySaved'));
      setApiKeyInputs((prev) => ({ ...prev, [providerId]: '' }));
      // OpenCode owns the credential and announces the catalog change itself
      // (`credential.updated` → catalog refresh); nothing to reload here.
      markAuthWriteSucceeded(providerId);
    } catch (error) {
      console.error('Failed to save API key:', error);
      toast.error(t('settings.providers.page.toast.apiKeySaveFailed'));
    } finally {
      setAuthBusyKey(null);
    }
  };

  const handleSaveCustomProvider = async (plan: CustomProviderPersistPlan) => {
    const busyKey = `custom:${plan.providerID}`;
    setAuthBusyKey(busyKey);
    setLastCustomPersistId(plan.providerID);
    setCustomAuthFailureHint(null);

    try {
      // Auth first so a failed key write cannot leave an orphan config that
      // blocks create validation, and so PUT can pass hasStoredAuth for literal keys.
      const keyRequest = buildIntegrationKeyRequest(plan);
      if (keyRequest) {
        await opencodeClient.getSdkClient().integration.connect.key(keyRequest);
      }

      const upsertBody = buildProviderUpsertRequest(plan, {
        // Create defaults to user. Edit must rewrite the winning config layer
        // (custom > project > user) so project/custom providers are not copied
        // into a global user override.
        scope: editingCustomProviderId
          ? (editingCustomScope ?? resolveProviderConfigScope(providerSources[editingCustomProviderId]))
          : 'user',
      });
      const response = await runtimeFetch(`/api/provider${settingsDirectory ? `?directory=${encodeURIComponent(settingsDirectory)}` : ''}`, {
        method: 'PUT',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(upsertBody),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        if (keyRequest) {
          setCustomAuthFailureHint(t('settings.providers.page.custom.authFailure.configAfterAuth'));
        }
        throw new Error(payload?.error || t('settings.providers.page.toast.customProviderSaveFailed'));
      }

      toast.success(t('settings.providers.page.toast.customProviderSaved', { provider: plan.name }));
      setCandidateProviderId('');
      setEditingCustomProviderId(null);
      setEditingCustomFormInitial(null);
      setEditingCustomScope(null);
      setCustomAuthFailureHint(null);
      setLastCustomPersistId(null);
      // OpenCode watches its config file and rebuilds the catalog on its own.
      markAuthWriteSucceeded(plan.providerID);
    } catch (error) {
      console.error('Failed to save custom provider:', error);
      toast.error(
        error instanceof Error && error.message
          ? error.message
          : t('settings.providers.page.toast.customProviderSaveFailed'),
      );
    } finally {
      setAuthBusyKey(null);
    }
  };

  const handleOAuthConnected = (providerId: string) => {
    setShowAuthPanel(false);
    // Optimistic mark + sources refetch so the page does not stick on a stale
    // "Credentials missing" summary while the providers refresh lands.
    markAuthWriteSucceeded(providerId);
  };

  const handleDisconnectProvider = async (providerId: string) => {
    const busyKey = `disconnect:${providerId}`;
    setAuthBusyKey(busyKey);

    try {
      // v2 keeps credentials in OpenCode, one record per stored login; the
      // provider is disconnected once every one of them is gone. Env-backed
      // connections are not removable from here — they live in the environment.
      const credentials = getCredentialConnections(
        findIntegrationForProvider(integrations ?? [], providerId),
      );
      const sdk = opencodeClient.getSdkClient();
      for (const credential of credentials) {
        await sdk.credential.remove({ credentialID: credential.id });
      }

      toast.success(t('settings.providers.page.toast.providerDisconnected'));
      setAuthPanelDismissedForId(null);
      refreshProviderSources();
      refreshIntegrations();
    } catch (error) {
      console.error('Failed to disconnect provider:', error);
      toast.error(t('settings.providers.page.toast.providerDisconnectFailed'));
    } finally {
      setAuthBusyKey(null);
    }
  };

  const handleDisconnectCustomProvider = async (providerId: string) => {
    if (!providerId) {
      return;
    }
    await handleDisconnectProvider(providerId);
    setEditingCustomProviderId(null);
    setEditingCustomFormInitial(null);
    setEditingCustomScope(null);
    setCustomAuthFailureHint(null);
    setLastCustomPersistId(null);
    setCandidateProviderId('');
  };

  if (!isAddMode && providers.length === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center text-muted-foreground">
          <Icon name="stack" className="mx-auto mb-3 h-12 w-12 opacity-50" />
          <p className="typography-body">{t('settings.providers.page.empty.noProvidersDetected')}</p>
          <p className="typography-meta mt-1 opacity-75">{t('settings.providers.page.empty.checkOpenCodeConfiguration')}</p>
        </div>
      </div>
    );
  }

  if (isAddMode) {
    return (
      <SettingsPageLayout
        title={t('settings.providers.page.connect.title')}
        showSaveStatus={false}
      >
        <SettingsSection
          title={t('settings.providers.page.connect.selectProviderTitle')}
          divider={false}
          settingsItem="providers.connect"
        >
              <div className="flex flex-wrap items-center gap-2 py-1.5">
                <span className="typography-ui-label text-foreground">{t('settings.providers.page.connect.providerField')}</span>
                  {availableLoading ? (
                    <p className="typography-meta text-muted-foreground">{t('settings.providers.page.state.loading')}</p>
                  ) : availableError ? (
                    <p className="typography-meta text-muted-foreground">{availableError}</p>
                  ) : (
                    <DropdownMenu open={providerDropdownOpen} onOpenChange={(open) => {
                      setProviderDropdownOpen(open);
                      if (!open) setProviderSearchQuery('');
                    }}>
                      <DropdownMenuTrigger asChild>
                        <button
                          type="button"
                          className={SETTINGS_CUSTOM_TRIGGER_CLASS}
                        >
                          <span className="flex items-center gap-2 min-w-0">
                            {candidateProviderId && candidateProviderId !== CUSTOM_PROVIDER_ID ? (
                              <ProviderLogo providerId={candidateProviderId} className="h-3.5 w-3.5 flex-shrink-0" />
                            ) : null}
                            <span className={cn("truncate typography-ui-label font-normal", candidateProviderId ? "text-foreground" : "text-muted-foreground")}>
                              {candidateProviderId === CUSTOM_PROVIDER_ID
                                ? t('settings.providers.page.custom.optionLabel')
                                : candidateProviderId
                                  ? (unconnectedProviders.find(p => p.id === candidateProviderId)?.name || candidateProviderId)
                                  : t('settings.providers.page.connect.selectProviderPlaceholder')}
                            </span>
                          </span>
                          <Icon name="arrow-down-s" className="h-4 w-4 flex-shrink-0 text-muted-foreground/50" />
                        </button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent
                        align="start"
                        className="w-[280px] p-0"
                        onCloseAutoFocus={(e) => e.preventDefault()}
                      >
                        <div
                          className="flex items-center gap-2 border-b border-[var(--surface-subtle)] px-3 py-2"
                          onKeyDown={(e) => e.stopPropagation()}
                        >
                          <Icon name="search" className="h-4 w-4 text-muted-foreground" />
                          <input
                            type="text"
                            value={providerSearchQuery}
                            onChange={(e) => setProviderSearchQuery(e.target.value)}
                            onKeyDown={(e) => e.stopPropagation()}
                            placeholder={t('settings.providers.page.connect.searchProvidersPlaceholder')}
                            className="flex-1 bg-transparent typography-meta outline-none placeholder:text-muted-foreground"
                            autoFocus
                          />
                        </div>
                        <ScrollableOverlay outerClassName="max-h-[240px]" className="p-1">
                          {(() => {
                            const customLabel = t('settings.providers.page.custom.optionLabel');
                            const customMatches = matchesRankQuery([customLabel, 'other', 'custom'], providerSearchQuery);
                            const filtered = rankByQuery(unconnectedProviders, providerSearchQuery, (p) => [p.name || p.id, p.id]);
                            if (filtered.length === 0 && !customMatches) {
                              return <p className="py-4 text-center typography-meta text-muted-foreground">{t('settings.providers.page.connect.noProvidersFound')}</p>;
                            }
                            return (
                              <>
                                {filtered.map((provider) => (
                                  <DropdownMenuItem
                                    key={provider.id}
                                    onSelect={() => {
                                      setCandidateProviderId(provider.id);
                                      setProviderDropdownOpen(false);
                                      setProviderSearchQuery('');
                                    }}
                                    className="flex items-center justify-between"
                                  >
                                    <span className="flex items-center gap-2 min-w-0">
                                      <ProviderLogo providerId={provider.id} className="h-4 w-4 flex-shrink-0" />
                                      <span className="truncate">{provider.name || provider.id}</span>
                                    </span>
                                    {candidateProviderId === provider.id && (
                                      <Icon name="check" className="h-4 w-4 text-[var(--primary-base)]" />
                                    )}
                                  </DropdownMenuItem>
                                ))}
                                {customMatches ? (
                                  <DropdownMenuItem
                                    key={CUSTOM_PROVIDER_ID}
                                    onSelect={() => {
                                      setCandidateProviderId(CUSTOM_PROVIDER_ID);
                                      setProviderDropdownOpen(false);
                                      setProviderSearchQuery('');
                                    }}
                                    className="flex items-center justify-between"
                                  >
                                    <span className="flex items-center gap-2 min-w-0">
                                      <Icon name="add" className="h-4 w-4 flex-shrink-0" />
                                      <span className="truncate">{customLabel}</span>
                                    </span>
                                    {candidateProviderId === CUSTOM_PROVIDER_ID && (
                                      <Icon name="check" className="h-4 w-4 text-[var(--primary-base)]" />
                                    )}
                                  </DropdownMenuItem>
                                ) : null}
                              </>
                            );
                          })()}
                        </ScrollableOverlay>
                      </DropdownMenuContent>
                    </DropdownMenu>
                   )}
              </div>
        </SettingsSection>

          {isCustomCreateMode ? (
            <CustomProviderForm
              mode="create"
              existingProviderIDs={connectedProviderIds}
              busy={authBusyKey?.startsWith('custom:') ?? false}
              authFailureHint={customAuthFailureHint}
              onCancel={() => {
                setCandidateProviderId('');
                setCustomAuthFailureHint(null);
                setLastCustomPersistId(null);
              }}
              onDisconnect={
                customAuthFailureHint && lastCustomPersistId
                  ? () => void handleDisconnectCustomProvider(lastCustomPersistId)
                  : undefined
              }
              onSubmit={handleSaveCustomProvider}
            />
          ) : candidateProviderId ? (
            <SettingsSection
              title={t('settings.providers.page.auth.title')}
              settingsItem="providers.auth"
              contentClassName="space-y-4"
            >
              {authLoading ? (
                <p className="typography-meta text-muted-foreground">{t('settings.providers.page.auth.loadingMethods')}</p>
              ) : (
                <>
                  {(() => {
                    const candidateIntegration = findIntegrationForProvider(integrations ?? [], candidateProviderId);
                    const candidateOAuthMethods = getOAuthMethods(
                      findIntegrationForProvider(integrations ?? [], getSignInIntegrationId(candidateProviderId)),
                    );
                    const showApiKey = shouldShowApiKeyAuth(candidateIntegration);

                    return (
                      <>
                        {showApiKey ? (
                          <div className="py-1.5">
                            <label className="typography-ui-label text-foreground flex items-center gap-1.5">
                              {t('settings.providers.page.auth.apiKeyLabel')}
                              <SettingsInfoHint>{t('settings.providers.page.auth.apiKeyTooltip')}</SettingsInfoHint>
                            </label>
                            <div className="flex flex-col @xl:flex-row @xl:items-center gap-2 mt-1.5">
                              <Input
                                type="password"
                                value={apiKeyInputs[candidateProviderId] ?? ''}
                                onChange={(event) =>
                                  setApiKeyInputs((prev) => ({
                                    ...prev,
                                    [candidateProviderId]: event.target.value,
                                  }))
                                }
                                placeholder={t('settings.providers.page.auth.apiKeyPlaceholder')}
                                className="flex-1 font-mono text-xs"
                              />
                              <Button
                                size="xs"
                                className="!font-normal shrink-0"
                                onClick={() => handleSaveApiKey(candidateProviderId)}
                                disabled={authBusyKey === `api:${candidateProviderId}`}
                              >
                                {authBusyKey === `api:${candidateProviderId}` ? t('settings.providers.page.actions.saving') : t('settings.providers.page.actions.saveKey')}
                              </Button>
                            </div>
                          </div>
                        ) : null}

                        {candidateOAuthMethods.length > 0 ? (
                          <ProviderOAuthMethods
                            key={candidateProviderId}
                            integrationId={getSignInIntegrationId(candidateProviderId)}
                            methods={candidateOAuthMethods}
                            onConnected={() => handleOAuthConnected(candidateProviderId)}
                            className={cn(showApiKey && 'border-t border-[var(--surface-subtle)] pt-2')}
                          />
                        ) : null}
                      </>
                    );
                  })()}
                </>
              )}
            </SettingsSection>
          ) : null}
      </SettingsPageLayout>
    );
  }

  if (!selectedProvider) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-center text-muted-foreground">
          <Icon name="stack" className="mx-auto mb-3 h-12 w-12 opacity-50" />
          <p className="typography-body">{t('settings.providers.page.empty.selectProviderFromSidebar')}</p>
          <p className="typography-meta mt-1 opacity-75">{t('settings.providers.page.empty.reviewDetailsAndConfigureAuth')}</p>
        </div>
      </div>
    );
  }

  const providerModels = Array.isArray(selectedProvider.models) ? selectedProvider.models : [];
  const selectedIntegration = findIntegrationForProvider(integrations ?? [], selectedProvider.id);
  const oauthAuthMethods = getOAuthMethods(
    findIntegrationForProvider(integrations ?? [], getSignInIntegrationId(selectedProvider.id)),
  );
  const showApiKeyAuth = shouldShowApiKeyAuth(selectedIntegration);
  const integrationsLoaded = integrations !== null;
  const sourcesLoaded = Boolean(selectedSources);
  const isEditableCustomProvider = sourcesLoaded
    && isConfigDefinedCustomProvider(selectedProvider, selectedSources);
  const hasCredentials = providerHasCredentials({
    connections: getProviderConnections(integrations ?? [], selectedProvider.id),
    optionsApiKey: readProviderApiKeySetting(selectedProvider),
  });
  const authStatusIncomplete = requiresProviderAuth(integrationsLoaded, hasCredentials, isEditableCustomProvider);
  const showModelsSection = shouldShowModelsSection({
    modelCount: providerModels.length,
    integrationsLoaded,
    hasCredentials,
    isEditableCustomProvider,
  });
  const incompleteAuthHint = !showApiKeyAuth && oauthAuthMethods.length > 0
    ? t('settings.providers.page.auth.useReconnectHint')
    : t('settings.providers.page.auth.incompleteHint');

  const filteredModels = rankByQuery(providerModels, modelQuery, (model) => [
    typeof model?.name === 'string' ? model.name : '',
    typeof model?.id === 'string' ? model.id : '',
  ]);

  if (isCustomEditMode && isEditableCustomProvider && editingCustomFormInitial) {
    return (
      <SettingsPageLayout
        title={selectedProvider.name || selectedProvider.id}
        titleLeading={<ProviderLogo providerId={selectedProvider.id} className="h-5 w-5 shrink-0" />}
        description={<span className="font-mono typography-settings-description text-muted-foreground">{selectedProvider.id}</span>}
        showSaveStatus={false}
      >
        <CustomProviderForm
          mode="edit"
          existingProviderIDs={connectedProviderIds}
          initialValues={editingCustomFormInitial}
          allowExistingAuth={hasCredentials || !sourcesLoaded}
          busy={authBusyKey?.startsWith('custom:') ?? false}
          authFailureHint={customAuthFailureHint}
          onCancel={() => {
            setEditingCustomProviderId(null);
            setEditingCustomFormInitial(null);
            setEditingCustomScope(null);
            setCustomAuthFailureHint(null);
            setLastCustomPersistId(null);
          }}
          onDisconnect={() => void handleDisconnectCustomProvider(selectedProvider.id)}
          onSubmit={handleSaveCustomProvider}
        />
      </SettingsPageLayout>
    );
  }

  return (
    <SettingsPageLayout
      title={selectedProvider.name || selectedProvider.id}
      titleLeading={<ProviderLogo providerId={selectedProvider.id} className="h-5 w-5 shrink-0" />}
      description={<span className="font-mono typography-settings-description text-muted-foreground">{selectedProvider.id}</span>}
      showSaveStatus={false}
    >
      <SettingsSection
        title={t('settings.providers.page.auth.title')}
        divider={false}
        headerAction={(
          <div className="flex items-center gap-1">
            {isEditableCustomProvider ? (
              <Button
                variant="outline"
                size="xs"
                className="!font-normal"
                onClick={() => {
                  setCustomAuthFailureHint(null);
                  setEditingCustomFormInitial(providerToEditFormState(
                    selectedProvider,
                    storedProviderConfigs[selectedProvider.id] ?? null,
                  ));
                  setEditingCustomScope(resolveProviderConfigScope(selectedSources));
                  setEditingCustomProviderId(selectedProvider.id);
                }}
              >
                {t('settings.providers.page.actions.edit')}
              </Button>
            ) : null}
            <Button
              variant="outline"
              size="xs"
              className="!font-normal"
              onClick={() => {
                const nextOpen = !showAuthPanel;
                setShowAuthPanel(nextOpen);
                setAuthPanelDismissedForId(nextOpen ? null : selectedProvider.id);
              }}
            >
              {showAuthPanel ? t('settings.providers.page.actions.hide') : t('settings.providers.page.actions.reconnect')}
            </Button>
          </div>
        )}
        settingsItem="providers.auth"
      >
            {!showAuthPanel ? (
              authStatusIncomplete ? (
                <div className="flex items-center gap-1.5 py-1.5">
                  <Icon name="alert" className="w-4 h-4 text-[var(--status-warning)] shrink-0" />
                  <span className="typography-ui-label text-foreground">{t('settings.providers.page.auth.incomplete')}</span>
                  <SettingsInfoHint>{incompleteAuthHint}</SettingsInfoHint>
                </div>
              ) : (
                <div className="flex items-center gap-1.5 py-1.5">
                  <Icon name="check" className="w-4 h-4 text-[var(--status-success)] shrink-0" />
                  <span className="typography-ui-label text-foreground">{t('settings.providers.page.auth.connected')}</span>
                  <SettingsInfoHint>{t('settings.providers.page.auth.useReconnectHint')}</SettingsInfoHint>
                </div>
              )
            ) : authLoading ? (
              <div className="py-1.5 typography-meta text-muted-foreground">{t('settings.providers.page.auth.loadingMethods')}</div>
            ) : (
              <div className="space-y-4">
                {showApiKeyAuth ? (
                  <div className="py-1.5">
                    <label className="typography-ui-label text-foreground flex items-center gap-1.5">
                      {t('settings.providers.page.auth.apiKeyLabel')}
                      <SettingsInfoHint>{t('settings.providers.page.auth.apiKeyTooltip')}</SettingsInfoHint>
                    </label>
                    <div className="flex flex-col @xl:flex-row @xl:items-center gap-2 mt-1.5">
                      <Input
                        type="password"
                        value={apiKeyInputs[selectedProvider.id] ?? ''}
                        onChange={(event) =>
                          setApiKeyInputs((prev) => ({
                            ...prev,
                            [selectedProvider.id]: event.target.value,
                          }))
                        }
                        placeholder={t('settings.providers.page.auth.apiKeyPlaceholder')}
                        className="flex-1 font-mono text-xs"
                      />
                      <Button
                        size="xs"
                        className="!font-normal shrink-0"
                        onClick={() => handleSaveApiKey(selectedProvider.id)}
                        disabled={authBusyKey === `api:${selectedProvider.id}`}
                      >
                        {authBusyKey === `api:${selectedProvider.id}` ? t('settings.providers.page.actions.saving') : t('settings.providers.page.actions.saveKey')}
                      </Button>
                    </div>
                  </div>
                ) : null}

                {oauthAuthMethods.length > 0 && (
                  <ProviderOAuthMethods
                    key={selectedProvider.id}
                    integrationId={getSignInIntegrationId(selectedProvider.id)}
                    methods={oauthAuthMethods}
                    onConnected={() => handleOAuthConnected(selectedProvider.id)}
                    className={cn(showApiKeyAuth && 'border-t border-[var(--surface-subtle)] pt-2')}
                  />
                )}
              </div>
            )}
      </SettingsSection>


      <SettingsSection
        title={t('settings.providers.page.connectionDetails.title')}
        settingsItem="providers.connection-details"
      >
            <div className="flex flex-col gap-2 py-1.5 @xl:flex-row @xl:items-center @xl:justify-between @xl:gap-8">
              <div className="flex min-w-0 flex-col">
                {(hasCredentials || selectedSources?.user.exists || selectedSources?.project.exists || selectedSources?.custom?.exists) ? (
                  <span className="typography-meta text-muted-foreground">
                    {t('settings.providers.page.connectionDetails.configuredIn')}{' '}
                    {[
                      hasCredentials ? t('settings.providers.page.connectionDetails.source.authCredentials') : null,
                      selectedSources?.user.exists ? t('settings.providers.page.connectionDetails.source.userConfig') : null,
                      selectedSources?.project.exists ? t('settings.providers.page.connectionDetails.source.projectConfig') : null,
                      selectedSources?.custom?.exists ? t('settings.providers.page.connectionDetails.source.customConfig') : null,
                    ].filter(Boolean).join(', ')}
                  </span>
                ) : (
                  <span className="typography-meta text-muted-foreground">{t('settings.providers.page.connectionDetails.noActiveSource')}</span>
                )}
              </div>

              <Button
                variant="ghost"
                size="xs"
                className="!font-normal text-[var(--status-error)] hover:text-[var(--status-error)]"
                onClick={() => handleDisconnectProvider(selectedProvider.id)}
                disabled={authBusyKey === `disconnect:${selectedProvider.id}`}
              >
                {authBusyKey === `disconnect:${selectedProvider.id}` ? t('settings.providers.page.actions.disconnecting') : t('settings.providers.page.actions.disconnect')}
              </Button>
            </div>
      </SettingsSection>

      {showModelsSection ? (
      <SettingsSection
        title={t('settings.providers.page.models.title')}
        titleAccessory={
          <span className="typography-micro text-muted-foreground font-normal">
            ({providerModels.length})
          </span>
        }
        headerAction={(
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="xs"
              className="!font-normal"
              onClick={() => {
                const allIds = providerModels
                  .map((model) => (typeof model?.id === 'string' ? model.id : ''))
                  .filter((id) => id.length > 0);
                hideAllModels(selectedProvider.id, allIds);
              }}
            >
              {t('settings.providers.page.actions.hideAll')}
            </Button>
            <Button
              variant="outline"
              size="xs"
              className="!font-normal"
              onClick={() => showAllModels(selectedProvider.id)}
            >
              {t('settings.providers.page.actions.showAll')}
            </Button>
          </div>
        )}
        settingsItem="providers.models"
      >
            <div className="relative mb-2">
              <Icon name="search" className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                value={modelQuery}
                onChange={(event) => setModelQuery(event.target.value)}
                placeholder={t('settings.providers.page.models.filterPlaceholder')}
                className="h-7 pl-8 w-full"
              />
            </div>

            {filteredModels.length === 0 ? (
              <p className="typography-meta text-muted-foreground py-4 text-center">{t('settings.providers.page.models.noModelsMatchFilter')}</p>
            ) : (
              <div className="divide-y divide-[var(--surface-subtle)]">
                {filteredModels.map((model) => {
                  const modelId = typeof model?.id === 'string' ? model.id : '';
                  const modelName = typeof model?.name === 'string' ? model.name : modelId;
                  const metadata = modelId ? getModelMetadata(selectedProvider.id, modelId) as ModelMetadata | undefined : undefined;
                  const isHidden = hiddenModels.some(
                    (item) => item.providerID === selectedProvider.id && item.modelID === modelId
                  );

                  const contextTokens = formatTokens(metadata?.limit?.context);
                  const outputTokens = formatTokens(metadata?.limit?.output);

                  const capabilityIcons: Array<{ key: string; icon: IconName; label: string }> = [];
                  if (metadata?.tool_call) capabilityIcons.push({ key: 'tools', icon: "tools", label: t('settings.providers.page.models.capability.toolCalling') });
                  if (metadata?.reasoning) capabilityIcons.push({ key: 'reasoning', icon: "brain-ai-3", label: t('settings.providers.page.models.capability.reasoning') });
                  if (metadata?.attachment) capabilityIcons.push({ key: 'image', icon: "file-image", label: t('settings.providers.page.models.capability.imageInput') });

                  return (
                    <div key={modelId} className="py-1.5">
                      <div
                        className={cn(
                          "flex items-center gap-3",
                          isHidden && 'opacity-50',
                        )}
                      >
                      <span className="typography-meta font-medium text-foreground truncate flex-1 min-w-0">
                        {modelName}
                      </span>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        {(contextTokens || outputTokens) && (
                          <span className="typography-micro text-muted-foreground flex-shrink-0 bg-[var(--surface-muted)] px-1.5 py-0.5 rounded">
                            {contextTokens ? `${contextTokens} ${t('settings.providers.page.models.tokenBadge.context')}` : ''}
                            {contextTokens && outputTokens ? ' · ' : ''}
                            {outputTokens ? `${outputTokens} ${t('settings.providers.page.models.tokenBadge.output')}` : ''}
                          </span>
                        )}
                        {capabilityIcons.length > 0 && (
                          <div className="flex items-center gap-1 flex-shrink-0">
                            {capabilityIcons.map(({ key, icon: iconName, label }) => (
                              <span
                                key={key}
                                className="flex h-5 w-5 rounded items-center justify-center text-muted-foreground bg-[var(--surface-muted)]"
                                title={label}
                                aria-label={label}
                              >
                                <Icon name={iconName} className="h-3 w-3" />
                              </span>
                            ))}
                          </div>
                        )}
                        <button
                          type="button"
                          onClick={() => toggleHiddenModel(selectedProvider.id, modelId)}
                          className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-[var(--interactive-hover)]/50"
                          title={isHidden ? t('settings.providers.page.models.actions.showModelInSelectors') : t('settings.providers.page.models.actions.hideModelFromSelectors')}
                          aria-label={isHidden ? t('settings.providers.page.models.actions.showModel') : t('settings.providers.page.models.actions.hideModel')}
                        >
                          {isHidden ? <Icon name="eye-off" className="h-3.5 w-3.5" /> : <Icon name="eye" className="h-3.5 w-3.5" />}
                        </button>
                      </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
      </SettingsSection>
      ) : null}
    </SettingsPageLayout>
  );
};
