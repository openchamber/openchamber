import React from 'react';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import { useConfigStore } from '@/stores/useConfigStore';
import { useUIStore } from '@/stores/useUIStore';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Icon } from "@/components/icon/Icon";
import type { IconName } from "@/components/icon/icons";
import { reloadOpenCodeConfiguration } from '@/stores/useAgentsStore';
import { cn } from '@/lib/utils';
import { copyTextToClipboard } from '@/lib/clipboard';
import { openExternalUrl } from '@/lib/url';
import type { ModelMetadata } from '@/types';
import { getCurrentIntlLocale, useI18n } from '@/lib/i18n';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { opencodeClient } from '@/lib/opencode/client';
import { shouldLoadAvailableProviders } from './providerAvailability';
import {
  filterUnconnectedProviders,
  getProviderOptionLabel,
  groupProviderOptions,
  startProviderOAuth,
  type AuthMethod,
  type ProviderOAuthDetails,
  type ProviderOption,
} from './providerConnect';
import { QuotaCredentials } from './QuotaCredentials';

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

interface ProviderSourceInfo {
  exists: boolean;
  path?: string | null;
}

interface ProviderSources {
  auth: ProviderSourceInfo;
  user: ProviderSourceInfo;
  project: ProviderSourceInfo;
  custom?: ProviderSourceInfo;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const normalizeAuthType = (method: AuthMethod) => {
  const raw = typeof method.type === 'string' ? method.type : '';
  const label = `${method.name ?? ''} ${method.label ?? ''}`.toLowerCase();
  const merged = `${raw} ${label}`.toLowerCase();
  if (merged.includes('oauth')) return 'oauth';
  if (merged.includes('api')) return 'api';
  return raw.toLowerCase();
};

const parseAuthPayload = (payload: unknown): Record<string, AuthMethod[]> => {
  if (!isRecord(payload)) {
    return {};
  }
  const result: Record<string, AuthMethod[]> = {};
  for (const [providerId, value] of Object.entries(payload)) {
    if (Array.isArray(value)) {
      result[providerId] = value.filter((entry) => isRecord(entry)) as AuthMethod[];
    }
  }
  return result;
};

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

export const ProvidersPage: React.FC = () => {
  const { t } = useI18n();
  const providers = useConfigStore((state) => state.providers);
  const selectedProviderId = useConfigStore((state) => state.selectedProviderId);
  const setSelectedProvider = useConfigStore((state) => state.setSelectedProvider);
  const getModelMetadata = useConfigStore((state) => state.getModelMetadata);
  const hiddenModels = useUIStore((state) => state.hiddenModels);
  const toggleHiddenModel = useUIStore((state) => state.toggleHiddenModel);
  const hideAllModels = useUIStore((state) => state.hideAllModels);
  const showAllModels = useUIStore((state) => state.showAllModels);

  const [authMethodsByProvider, setAuthMethodsByProvider] = React.useState<Record<string, AuthMethod[]>>({});
  const [authLoading, setAuthLoading] = React.useState(false);
  const [apiKeyInputs, setApiKeyInputs] = React.useState<Record<string, string>>({});
  const [authBusyKey, setAuthBusyKey] = React.useState<string | null>(null);
  const [modelQuery, setModelQuery] = React.useState('');
  const [pendingOAuth, setPendingOAuth] = React.useState<{ providerId: string; methodIndex: number } | null>(null);
  const [oauthCodes, setOauthCodes] = React.useState<Record<string, string>>({});
  const [oauthDetails, setOauthDetails] = React.useState<Record<string, ProviderOAuthDetails>>({});
  const [availableProviders, setAvailableProviders] = React.useState<ProviderOption[]>([]);
  const [availableLoading, setAvailableLoading] = React.useState(false);
  const [availableError, setAvailableError] = React.useState<string | null>(null);
  const [candidateProviderId, setCandidateProviderId] = React.useState('');
  const [providerSearchQuery, setProviderSearchQuery] = React.useState('');
  const [providerSources, setProviderSources] = React.useState<Record<string, ProviderSources>>({});
  const [showAuthPanel, setShowAuthPanel] = React.useState(false);
  const isAddMode = selectedProviderId === ADD_PROVIDER_ID;
  const hasCandidateProvider = candidateProviderId.length > 0;
  const authBusyKeyRef = React.useRef<string | null>(null);

  React.useEffect(() => {
    if (!selectedProviderId && providers.length > 0) {
      setSelectedProvider(providers[0].id);
    }
  }, [providers, selectedProviderId, setSelectedProvider]);

  React.useEffect(() => {
    if (!isAddMode) {
      return;
    }

    let isMounted = true;

    const loadAuthMethods = async () => {
      setAuthLoading(true);
      try {
        const result = await opencodeClient.getSdkClient().provider.auth();
        if (result.error) {
          throw new Error(`provider.auth failed: ${String(result.error)}`);
        }
        if (!isMounted) return;
        setAuthMethodsByProvider(parseAuthPayload(result.data));
      } catch (error) {
        if (!isMounted) return;
        console.error('Failed to load provider auth methods:', error);
        toast.error(t('settings.providers.page.toast.authMethodsLoadFailed'));
      } finally {
        if (isMounted) {
          setAuthLoading(false);
        }
      }
    };

    loadAuthMethods();

    return () => {
      isMounted = false;
    };
  }, [isAddMode, t]);

  React.useEffect(() => {
    if (!shouldLoadAvailableProviders(isAddMode)) {
      return;
    }

    let isMounted = true;

    const loadAvailableProviders = async () => {
      setAvailableLoading(true);
      setAvailableError(null);
      try {
        const result = await opencodeClient.getSdkClient().provider.list();
        if (result.error) {
          throw new Error(`provider.list failed: ${String(result.error)}`);
        }
        if (!isMounted) return;
        setAvailableProviders(parseProvidersPayload(result.data));
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

  const filteredUnconnectedProviders = React.useMemo(
    () => filterUnconnectedProviders(unconnectedProviders, providerSearchQuery),
    [providerSearchQuery, unconnectedProviders]
  );

  const groupedUnconnectedProviders = React.useMemo(
    () => groupProviderOptions(filteredUnconnectedProviders),
    [filteredUnconnectedProviders]
  );

  React.useEffect(() => {
    if (selectedProviderId !== ADD_PROVIDER_ID) {
      return;
    }

    if (candidateProviderId && !unconnectedProviders.some((provider) => provider.id === candidateProviderId)) {
      setCandidateProviderId('');
    }
  }, [selectedProviderId, candidateProviderId, unconnectedProviders]);

  React.useEffect(() => {
    if (selectedProviderId === ADD_PROVIDER_ID) {
      setShowAuthPanel(true);
      return;
    }

    setShowAuthPanel(false);
  }, [selectedProviderId, t]);

  React.useEffect(() => {
    if (!selectedProviderId || selectedProviderId === ADD_PROVIDER_ID) {
      return;
    }

    let cancelled = false;

    const loadSources = async () => {
      try {
        // OpenChamber-only metadata endpoint: the SDK exposes provider data but
        // not local auth/source-file provenance used by this settings UI.
        const response = await runtimeFetch(`/api/provider/${encodeURIComponent(selectedProviderId)}/source`, {
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
  }, [selectedProviderId, t]);

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
      const result = await opencodeClient.getSdkClient().auth.set({
        providerID: providerId,
        auth: { type: 'api', key: apiKey },
      });
      if (result.error) {
        throw new Error(t('settings.providers.page.toast.apiKeySaveFailed'));
      }

      toast.success(t('settings.providers.page.toast.apiKeySaved'));
      setApiKeyInputs((prev) => ({ ...prev, [providerId]: '' }));
      await reloadOpenCodeConfiguration({ scopes: ["providers"], mode: "active" });
      setSelectedProvider(providerId);
    } catch (error) {
      console.error('Failed to save API key:', error);
      toast.error(t('settings.providers.page.toast.apiKeySaveFailed'));
    } finally {
      setAuthBusyKey(null);
    }
  };

  const handleOAuthStart = async (providerId: string, methodIndex: number) => {
    await startProviderOAuth({
      providerId,
      methodIndex,
      authorize: (input) => opencodeClient.getSdkClient().provider.oauth.authorize(input),
      authBusyKeyRef,
      setAuthBusyKey,
      setOauthDetails,
      setPendingOAuth,
      toastMessage: (message) => toast.message(message),
      toastError: (message) => toast.error(message),
      t,
      onError: (error) => {
        console.error('Failed to start OAuth flow:', error);
      },
    });
  };

  const handleOAuthComplete = async (providerId: string, methodIndex: number) => {
    const codeKey = `${providerId}:${methodIndex}`;
    const code = oauthCodes[codeKey]?.trim();

    const busyKey = `oauth-complete:${providerId}:${methodIndex}`;
    setAuthBusyKey(busyKey);

    try {
      const requestBody: { method: number; code?: string } = { method: methodIndex };
      if (code) {
        requestBody.code = code;
      }

      const result = await opencodeClient.getSdkClient().provider.oauth.callback({
        providerID: providerId,
        method: requestBody.method,
        code: requestBody.code,
      });
      if (result.error) {
        throw new Error(t('settings.providers.page.toast.oauthCompleteFailed'));
      }

      toast.success(t('settings.providers.page.toast.oauthCompleted'));
      setOauthCodes((prev) => ({ ...prev, [codeKey]: '' }));
      setPendingOAuth(null);
      await reloadOpenCodeConfiguration({ scopes: ["providers"], mode: "active" });
      setSelectedProvider(providerId);
    } catch (error) {
      console.error('Failed to complete OAuth flow:', error);
      toast.error(t('settings.providers.page.toast.oauthCompleteFailed'));
    } finally {
      setAuthBusyKey(null);
    }
  };

  const handleCopyOAuthLink = async (url: string) => {
    const result = await copyTextToClipboard(url);
    if (result.ok) {
      toast.success(t('settings.providers.page.toast.oauthLinkCopied'));
      return;
    }
    console.error('Failed to copy OAuth link:', result.error);
    toast.error(t('settings.providers.page.toast.oauthLinkCopyFailed'));
  };

  const handleCopyOAuthCode = async (code: string) => {
    const result = await copyTextToClipboard(code);
    if (result.ok) {
      toast.success(t('settings.providers.page.toast.deviceCodeCopied'));
      return;
    }
    console.error('Failed to copy device code:', result.error);
    toast.error(t('settings.providers.page.toast.deviceCodeCopyFailed'));
  };

  const handleDisconnectProvider = async (providerId: string) => {
    const busyKey = `disconnect:${providerId}`;
    setAuthBusyKey(busyKey);

    try {
      const response = await runtimeFetch(`/api/provider/${encodeURIComponent(providerId)}/auth?scope=all`, {
        method: 'DELETE',
        headers: { Accept: 'application/json' },
      });

      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(payload?.error || t('settings.providers.page.toast.providerDisconnectFailed'));
      }

      toast.success(t('settings.providers.page.toast.providerDisconnected'));
      await reloadOpenCodeConfiguration({ scopes: ["providers"], mode: "active" });
    } catch (error) {
      console.error('Failed to disconnect provider:', error);
      toast.error(t('settings.providers.page.toast.providerDisconnectFailed'));
    } finally {
      setAuthBusyKey(null);
    }
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
      <div className="h-full overflow-hidden">
        <div className="mx-auto flex h-full w-full max-w-6xl flex-col p-3 sm:p-6 sm:pt-8">
          <div data-settings-item="providers.connect" className="mb-4">
            <h1 className="typography-ui-header font-semibold text-foreground">{t('settings.providers.page.connect.title')}</h1>
          </div>

          <div className="grid min-h-0 flex-1 grid-cols-1 gap-6 xl:grid-cols-[minmax(18rem,22rem)_minmax(0,1fr)]">
            <section
              className={cn(
                'min-h-0 flex-col rounded-xl border border-[var(--surface-subtle)] bg-[var(--surface-elevated)]',
                hasCandidateProvider ? 'hidden xl:flex' : 'flex'
              )}
            >
              <div className="border-b border-[var(--surface-subtle)] px-4 py-4">
                <div className="relative">
                  <Icon name="search" className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={providerSearchQuery}
                    onChange={(event) => setProviderSearchQuery(event.target.value)}
                    placeholder={t('settings.providers.page.connect.searchProvidersPlaceholder')}
                    className="h-10 pl-9"
                    autoFocus
                  />
                </div>
              </div>

              <div className="min-h-0 flex-1 px-2 py-2">
                {availableLoading ? (
                  <div className="px-2 py-3 typography-meta text-muted-foreground">{t('settings.providers.page.state.loading')}</div>
                ) : availableError ? (
                  <div className="px-2 py-3 typography-meta text-muted-foreground">{availableError}</div>
                ) : unconnectedProviders.length === 0 ? (
                  <div className="px-2 py-3 typography-meta text-muted-foreground">{t('settings.providers.page.connect.allProvidersConnected')}</div>
                ) : filteredUnconnectedProviders.length === 0 ? (
                  <div className="px-2 py-6 text-center typography-meta text-muted-foreground">{t('settings.providers.page.connect.noProvidersFound')}</div>
                ) : (
                  <ScrollableOverlay outerClassName="h-full" className="space-y-3 pr-1">
                    {groupedUnconnectedProviders.map(([groupKey, groupProviders]) => (
                      <div key={groupKey} className="space-y-1">
                        <div className="px-2 pb-1 pt-1 typography-micro font-semibold uppercase tracking-wide text-muted-foreground">
                          {groupKey}
                        </div>
                        {groupProviders.map((provider) => {
                          const isSelected = candidateProviderId === provider.id;
                          return (
                            <button
                              key={provider.id}
                              type="button"
                              onClick={() => setCandidateProviderId(provider.id)}
                              className={cn(
                                'flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors',
                                isSelected ? 'bg-interactive-selection text-interactive-selection-foreground' : 'hover:bg-interactive-hover'
                              )}
                            >
                              <ProviderLogo providerId={provider.id} className="h-4 w-4 shrink-0" />
                              <div className="min-w-0 flex-1">
                                <div className="truncate typography-ui-label font-normal">
                                  {getProviderOptionLabel(provider)}
                                </div>
                                <div className={cn(
                                  'truncate typography-meta',
                                  isSelected ? 'text-interactive-selection-foreground/70' : 'text-muted-foreground'
                                )}>
                                  {provider.id}
                                </div>
                              </div>
                              {isSelected ? <Icon name="check" className="h-4 w-4 shrink-0" /> : null}
                            </button>
                          );
                        })}
                      </div>
                    ))}
                  </ScrollableOverlay>
                )}
              </div>
            </section>

            <section
              data-settings-item="providers.auth"
              className={cn(
                'min-h-0 rounded-xl border border-[var(--surface-subtle)] bg-background',
                hasCandidateProvider ? 'block' : 'hidden xl:block'
              )}
            >
              {!candidateProviderId ? (
                <div className="flex h-full min-h-[18rem] items-center justify-center px-6 py-10 text-center text-muted-foreground">
                  <div>
                    <Icon name="stack" className="mx-auto mb-3 h-10 w-10 opacity-50" />
                    <p className="typography-ui-label text-foreground">{t('settings.providers.page.connect.selectProviderPlaceholder')}</p>
                    <p className="mt-1 typography-meta">{t('settings.providers.page.connect.selectProviderHint')}</p>
                  </div>
                </div>
              ) : (
                <ScrollableOverlay outerClassName="h-full" className="w-full">
                  <div className="p-4 sm:p-6">
                    <div className="mb-4 xl:hidden">
                      <Button
                        variant="ghost"
                        size="xs"
                        className="-ml-2 !font-normal"
                        onClick={() => setCandidateProviderId('')}
                      >
                        <Icon name="arrow-left-s" className="h-4 w-4" />
                        {t('settings.providers.page.connect.backToProviders')}
                      </Button>
                    </div>

                    <div className="mb-4 flex items-center gap-3">
                      <ProviderLogo providerId={candidateProviderId} className="h-5 w-5 shrink-0" />
                      <div className="min-w-0">
                        <h2 className="truncate typography-ui-header font-semibold text-foreground">
                          {getProviderOptionLabel(unconnectedProviders.find((provider) => provider.id === candidateProviderId) ?? { id: candidateProviderId })}
                        </h2>
                        <p className="truncate typography-meta text-muted-foreground">
                          <span className="font-mono">{candidateProviderId}</span>
                        </p>
                      </div>
                    </div>

                    {authLoading ? (
                      <p className="typography-meta text-muted-foreground">{t('settings.providers.page.auth.loadingMethods')}</p>
                    ) : (
                      <section className="space-y-4">
                        <div className="py-1.5">
                          <label className="flex items-center gap-1.5 typography-ui-label text-foreground">
                            {t('settings.providers.page.auth.apiKeyLabel')}
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Icon name="information" className="h-3.5 w-3.5 cursor-help text-muted-foreground/60" />
                              </TooltipTrigger>
                              <TooltipContent sideOffset={8} className="max-w-xs">
                                {t('settings.providers.page.auth.apiKeyTooltip')}
                              </TooltipContent>
                            </Tooltip>
                          </label>
                          <div className="mt-1.5 flex flex-col gap-2 sm:flex-row sm:items-center">
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
                              className="shrink-0 !font-normal"
                              onClick={() => handleSaveApiKey(candidateProviderId)}
                              disabled={authBusyKey === `api:${candidateProviderId}`}
                            >
                              {authBusyKey === `api:${candidateProviderId}` ? t('settings.providers.page.actions.saving') : t('settings.providers.page.actions.saveKey')}
                            </Button>
                          </div>
                        </div>

                        {(() => {
                          const candidateAuthMethods = authMethodsByProvider[candidateProviderId] ?? [];
                          const candidateOAuthMethods = candidateAuthMethods.filter(
                            (method) => normalizeAuthType(method) === 'oauth'
                          );

                          if (candidateOAuthMethods.length === 0) {
                            return null;
                          }

                          return (
                            <div className="space-y-4 border-t border-[var(--surface-subtle)] pt-2">
                              {candidateOAuthMethods.map((method, index) => {
                                const methodLabel = method.label || method.name || t('settings.providers.page.auth.oauthMethodFallback', { index: String(index + 1) });
                                const codeKey = `${candidateProviderId}:${index}`;
                                const isPending =
                                  pendingOAuth?.providerId === candidateProviderId && pendingOAuth?.methodIndex === index;

                                return (
                                  <div key={`${candidateProviderId}-${methodLabel}`} className="space-y-3">
                                    <div className="flex items-center justify-between gap-2">
                                      <div>
                                        <div className="typography-ui-label text-foreground">{methodLabel}</div>
                                        {(method.description || method.help) && (
                                          <div className="typography-meta text-muted-foreground">
                                            {String(method.description || method.help)}
                                          </div>
                                        )}
                                      </div>
                                      <Button
                                        variant="outline"
                                        size="xs"
                                        className="!font-normal"
                                        onClick={() => handleOAuthStart(candidateProviderId, index)}
                                        disabled={authBusyKey === `oauth:${candidateProviderId}:${index}`}
                                      >
                                        {t('settings.providers.page.actions.connect')}
                                      </Button>
                                    </div>

                                    {oauthDetails[codeKey]?.instructions && (
                                      <p className="rounded bg-[var(--primary-base)]/10 px-2 py-1.5 typography-meta text-[var(--primary-base)]">
                                        {oauthDetails[codeKey]?.instructions}
                                      </p>
                                    )}

                                    {oauthDetails[codeKey]?.userCode && (
                                      <div className="mt-2 flex items-center gap-2">
                                        <Input value={oauthDetails[codeKey]?.userCode} readOnly className="font-mono text-center tracking-widest" />
                                        <Button variant="outline" size="xs" className="!font-normal" onClick={() => handleCopyOAuthCode(oauthDetails[codeKey]?.userCode ?? '')}>{t('settings.providers.page.actions.copyCode')}</Button>
                                      </div>
                                    )}

                                    {oauthDetails[codeKey]?.url && (
                                      <div className="mt-2 flex items-center gap-2">
                                        <Input value={oauthDetails[codeKey]?.url} readOnly className="text-xs text-muted-foreground" />
                                        <div className="flex shrink-0 gap-1">
                                          <Button variant="outline" size="xs" className="!font-normal" onClick={() => openExternalUrl(oauthDetails[codeKey]?.url ?? '')}>{t('settings.providers.page.actions.open')}</Button>
                                          <Button variant="outline" size="xs" className="!font-normal" onClick={() => handleCopyOAuthLink(oauthDetails[codeKey]?.url ?? '')}>{t('settings.providers.page.actions.copy')}</Button>
                                        </div>
                                      </div>
                                    )}

                                    {isPending && (
                                      <div className="mt-2 flex items-center gap-2">
                                        <Input
                                          value={oauthCodes[codeKey] ?? ''}
                                          onChange={(event) =>
                                            setOauthCodes((prev) => ({
                                              ...prev,
                                              [codeKey]: event.target.value,
                                            }))
                                          }
                                          placeholder={t('settings.providers.page.auth.pasteAuthorizationCodePlaceholder')}
                                          className="font-mono text-xs"
                                        />
                                        <Button
                                          size="xs"
                                          className="!font-normal"
                                          onClick={() => handleOAuthComplete(candidateProviderId, index)}
                                          disabled={authBusyKey === `oauth-complete:${candidateProviderId}:${index}`}
                                        >
                                          {authBusyKey === `oauth-complete:${candidateProviderId}:${index}` ? t('settings.providers.page.actions.saving') : t('settings.providers.page.actions.complete')}
                                        </Button>
                                      </div>
                                    )}
                                  </div>
                                );
                              })}
                            </div>
                          );
                        })()}
                      </section>
                    )}
                  </div>
                </ScrollableOverlay>
              )}
            </section>
          </div>
        </div>
      </div>
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
  const providerAuthMethods = authMethodsByProvider[selectedProvider.id] ?? [];
  const oauthAuthMethods = providerAuthMethods.filter((method) => normalizeAuthType(method) === 'oauth');

  const filteredModels = providerModels.filter((model) => {
    const name = typeof model?.name === 'string' ? model.name : '';
    const id = typeof model?.id === 'string' ? model.id : '';
    const query = modelQuery.trim().toLowerCase();
    if (!query) return true;
    return name.toLowerCase().includes(query) || id.toLowerCase().includes(query);
  });

  return (
    <ScrollableOverlay outerClassName="h-full" className="w-full">
      <div className="mx-auto w-full max-w-3xl p-3 sm:p-6 sm:pt-8">

        {/* Header */}
        <div className="mb-4 flex items-center gap-3">
          <ProviderLogo providerId={selectedProvider.id} className="h-5 w-5 shrink-0" />
          <div className="min-w-0">
            <h2 className="typography-ui-header font-semibold text-foreground truncate">
              {selectedProvider.name || selectedProvider.id}
            </h2>
            <p className="typography-meta text-muted-foreground truncate">
              <span className="font-mono">{selectedProvider.id}</span>
            </p>
          </div>
        </div>

        {/* Authentication */}
        <div data-settings-item="providers.auth" className="mb-8">
          <div className="mb-1 px-1 flex items-center justify-between gap-2">
            <h3 className="typography-ui-header font-medium text-foreground">{t('settings.providers.page.auth.title')}</h3>
            <Button
              variant="outline"
              size="xs"
              className="!font-normal"
              onClick={() => setShowAuthPanel((prev) => !prev)}
            >
              {showAuthPanel ? t('settings.providers.page.actions.hide') : t('settings.providers.page.actions.reconnect')}
            </Button>
          </div>

          <section className="px-2 pb-2 pt-0">
            {!showAuthPanel ? (
              <div className="flex items-center gap-1.5 py-1.5">
                <Icon name="check" className="w-4 h-4 text-[var(--status-success)] shrink-0" />
                <span className="typography-ui-label text-foreground">{t('settings.providers.page.auth.connected')}</span>
                <span className="typography-meta text-muted-foreground ml-1">{t('settings.providers.page.auth.useReconnectHint')}</span>
              </div>
            ) : authLoading ? (
              <div className="py-1.5 typography-meta text-muted-foreground">{t('settings.providers.page.auth.loadingMethods')}</div>
            ) : (
              <div className="space-y-4">
                <div className="py-1.5">
                  <label className="typography-ui-label text-foreground flex items-center gap-1.5">
                    {t('settings.providers.page.auth.apiKeyLabel')}
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Icon name="information" className="h-3.5 w-3.5 text-muted-foreground/60 cursor-help" />
                      </TooltipTrigger>
                      <TooltipContent sideOffset={8} className="max-w-xs">
                        {t('settings.providers.page.auth.apiKeyTooltip')}
                      </TooltipContent>
                    </Tooltip>
                  </label>
                  <div className="flex flex-col sm:flex-row sm:items-center gap-2 mt-1.5">
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

                {oauthAuthMethods.length > 0 && (
                  <div className="space-y-4 border-t border-[var(--surface-subtle)] pt-2">
                    {oauthAuthMethods.map((method, index) => {
                      const methodLabel = method.label || method.name || t('settings.providers.page.auth.oauthMethodFallback', { index: String(index + 1) });
                      const codeKey = `${selectedProvider.id}:${index}`;
                      const isPending =
                        pendingOAuth?.providerId === selectedProvider.id && pendingOAuth?.methodIndex === index;

                      return (
                        <div key={`${selectedProvider.id}-${methodLabel}`} className="space-y-3">
                          <div className="flex items-center justify-between gap-2">
                            <div>
                              <div className="typography-ui-label text-foreground">{methodLabel}</div>
                              {(method.description || method.help) && (
                                <div className="typography-meta text-muted-foreground">
                                  {String(method.description || method.help)}
                                </div>
                              )}
                            </div>
                            <Button
                              variant="outline"
                              size="xs"
                              className="!font-normal"
                              onClick={() => handleOAuthStart(selectedProvider.id, index)}
                              disabled={authBusyKey === `oauth:${selectedProvider.id}:${index}`}
                            >
                              {t('settings.providers.page.actions.connect')}
                            </Button>
                          </div>

                          {oauthDetails[codeKey]?.instructions && (
                            <p className="typography-meta text-[var(--primary-base)] bg-[var(--primary-base)]/10 px-2 py-1.5 rounded">
                              {oauthDetails[codeKey]?.instructions}
                            </p>
                          )}

                          {oauthDetails[codeKey]?.userCode && (
                            <div className="flex items-center gap-2 mt-2">
                              <Input value={oauthDetails[codeKey]?.userCode} readOnly className="font-mono text-center tracking-widest" />
                              <Button variant="outline" size="xs" className="!font-normal" onClick={() => handleCopyOAuthCode(oauthDetails[codeKey]?.userCode ?? '')}>{t('settings.providers.page.actions.copyCode')}</Button>
                            </div>
                          )}

                          {oauthDetails[codeKey]?.url && (
                            <div className="flex items-center gap-2 mt-2">
                              <Input value={oauthDetails[codeKey]?.url} readOnly className="text-xs text-muted-foreground" />
                              <div className="flex gap-1 shrink-0">
                                <Button variant="outline" size="xs" className="!font-normal" onClick={() => openExternalUrl(oauthDetails[codeKey]?.url ?? '')}>{t('settings.providers.page.actions.open')}</Button>
                                <Button variant="outline" size="xs" className="!font-normal" onClick={() => handleCopyOAuthLink(oauthDetails[codeKey]?.url ?? '')}>{t('settings.providers.page.actions.copy')}</Button>
                              </div>
                            </div>
                          )}

                          {isPending && (
                            <div className="flex items-center gap-2 mt-2">
                              <Input
                                value={oauthCodes[codeKey] ?? ''}
                                onChange={(event) =>
                                  setOauthCodes((prev) => ({
                                    ...prev,
                                    [codeKey]: event.target.value,
                                  }))
                                }
                                placeholder={t('settings.providers.page.auth.pasteAuthorizationCodePlaceholder')}
                                className="font-mono text-xs"
                              />
                              <Button
                                size="xs"
                                className="!font-normal"
                                onClick={() => handleOAuthComplete(selectedProvider.id, index)}
                                disabled={authBusyKey === `oauth-complete:${selectedProvider.id}:${index}`}
                              >
                                {authBusyKey === `oauth-complete:${selectedProvider.id}:${index}` ? t('settings.providers.page.actions.saving') : t('settings.providers.page.actions.complete')}
                              </Button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </section>
        </div>

        {(selectedProvider.id === 'opencode' || selectedProvider.id === 'opencode-go') && <QuotaCredentials providerId="opencode-go" providerName="OpenCode Go" />}
        {(selectedProvider.id === 'ollama' || selectedProvider.id === 'ollama-cloud') && <QuotaCredentials providerId="ollama-cloud" providerName="Ollama Cloud" />}
        {selectedProvider.id === 'cursor' && <QuotaCredentials providerId="cursor" providerName="Cursor" />}

        {/* Connection Details */}
        <div data-settings-item="providers.connection-details" className="mb-8">
          <div className="mb-1 px-1">
            <h3 className="typography-ui-header font-medium text-foreground">{t('settings.providers.page.connectionDetails.title')}</h3>
          </div>

          <section className="px-2 pb-2 pt-0">
            <div className="flex flex-col gap-2 py-1.5 sm:flex-row sm:items-center sm:justify-between sm:gap-8">
              <div className="flex min-w-0 flex-col">
                {selectedSources && (selectedSources.auth.exists || selectedSources.user.exists || selectedSources.project.exists || selectedSources.custom?.exists) ? (
                  <span className="typography-meta text-muted-foreground">
                    {t('settings.providers.page.connectionDetails.configuredIn')}{' '}
                    {[
                      selectedSources.auth.exists ? t('settings.providers.page.connectionDetails.source.authCredentials') : null,
                      selectedSources.user.exists ? t('settings.providers.page.connectionDetails.source.userConfig') : null,
                      selectedSources.project.exists ? t('settings.providers.page.connectionDetails.source.projectConfig') : null,
                      selectedSources.custom?.exists ? t('settings.providers.page.connectionDetails.source.customConfig') : null,
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
          </section>
        </div>

        {/* Models */}
        <div data-settings-item="providers.models" className="mb-8">
          <div className="mb-1 px-1 flex items-center justify-between gap-2">
            <h3 className="typography-ui-header font-medium text-foreground">
              {t('settings.providers.page.models.title')}
              {providerModels.length > 0 && (
                <span className="ml-1.5 typography-micro text-muted-foreground font-normal">
                  ({providerModels.length})
                </span>
              )}
            </h3>
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
          </div>

          <section className="px-2 pb-2 pt-0">
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
          </section>
        </div>
      </div>
    </ScrollableOverlay>
  );
};
