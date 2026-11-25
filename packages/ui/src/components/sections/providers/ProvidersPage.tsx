import { rankByQuery } from '@/lib/search/fuzzySearch';
import React from 'react';
import { SettingsPageLayout } from '@/components/sections/shared/SettingsPageLayout';
import { SettingsSection } from '@/components/sections/shared/SettingsSection';
import { SettingsInfoHint } from '@/components/sections/shared/SettingsInfoHint';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import { selectSettingsOnlyProvidersForDirectory, selectProvidersForDirectory, useConfigStore } from '@/stores/useConfigStore';
import { useSettingsDirectory } from '@/hooks/useSettingsDirectory';
import { useUIStore } from '@/stores/useUIStore';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { toast } from '@/components/ui';
import { Icon } from "@/components/icon/Icon";
import type { IconName } from "@/components/icon/icons";
import { cn } from '@/lib/utils';
import { useDeviceInfo } from '@/lib/device';
import type { ModelMetadata } from '@/types';
import { useI18n } from '@/lib/i18n';
import { formatCompactNumber } from '@/lib/numberFormat';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { updateDesktopSettings } from '@/lib/persistence';
import { opencodeClient } from '@/lib/opencode/client';
import { loadIntegrationCatalog, peekIntegrationCatalog, subscribeCredentialChanges, type IntegrationCatalog } from '@/lib/opencode/integration-catalog';
import { fetchDisabledProviders, setProviderDisabled as setProviderDisabledRequest } from '@/lib/disabledProviders';
import { listCanonicalProviders, listConnectableProviders } from './connectableProviders';
import { fetchProviderSource, type ProviderSources } from './providerSource';
import { ProviderConnectPicker } from './ProviderConnectPicker';
import {
  providerHasCredentials,
  providerHoldsStoredLogin,
  shouldShowApiKeyAuth,
  providerPageSections,
  shouldShowModelsSection,
  usesMachineCredentials,
  findIntegrationForProvider,
  getCredentialConnections,
  getKeyMethod,
  getSignInMethods,
  getProviderConnections,
  getSignInIntegrationId,
  getAccountSwitching,
  readProviderApiKeySetting,
  type CredentialConnection,
} from './providerAuth';
import { ProviderGrid } from './ProviderGrid';
import { useEnterpriseMode } from '@/stores/useEnterprisePolicyStore';
import { ClassificationProvidersPage } from '@/components/sections/classification/ClassificationProvidersPage';
import { SettingsBackButton } from '@/components/sections/shared/SettingsCards';
import { ProviderAccounts } from './ProviderAccounts';
import { ProviderAccountSwitchToggle } from './ProviderAccountSwitchToggle';
import { isVSCodeRuntime } from '@/lib/desktop';
import { CustomProviderForm, type CatalogProviders } from './CustomProviderForm';
import { ProviderLogoImageControl } from './ProviderLogoImageControl';
import { providerLogoUploadSupported, removeProviderLogo, uploadProviderLogo } from '@/lib/customProviderLogos';

import { ProviderAuthMethodCards } from './ProviderAuthMethodCards';
import { ProviderAuthMethodsLoading } from './ProviderAuthMethodsLoading';
import type { IntegrationKeyRequest } from './ProviderApiKeyForm';
import {
  buildIntegrationKeyRequest,
  buildProviderUpsertRequest,
  CUSTOM_PROVIDER_ID,
  isConfigDefinedCustomProvider,
  isCustomOpenAICompatibleProvider,
  providerToEditFormState,
  resolveProviderConfigScope,
  type CustomProviderFormState,
  type CustomProviderLogoPlan,
  type CustomProviderPersistPlan,
  type ProviderConfigScope,
  type StoredProviderSource,
} from './custom-provider-form';
import { connectProviderKey, storeCustomProviderKey } from './provider-key-writes';

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
const CLASSIFICATION_PAGE_ID = '__classification__';

export const ProvidersPage: React.FC = () => {
  const { t } = useI18n();
  const { isMobile } = useDeviceInfo();
  const settingsDirectory = useSettingsDirectory();
  const chatProviders = useConfigStore((state) => selectProvidersForDirectory(state, settingsDirectory));
  const settingsOnlyProviders = useConfigStore((state) => selectSettingsOnlyProvidersForDirectory(state, settingsDirectory));
  const connectRequested = useUIStore((state) => state.settingsProvidersConnectRequested);
  const setConnectRequested = useUIStore((state) => state.setSettingsProvidersConnectRequested);
  const classificationRequested = useUIStore((state) => state.settingsProvidersClassificationRequested);
  const setClassificationRequested = useUIStore((state) => state.setSettingsProvidersClassificationRequested);
  const openRequested = useUIStore((state) => state.settingsProvidersOpenRequested);
  const setOpenRequested = useUIStore((state) => state.setSettingsProvidersOpenRequested);
  const [selectedProviderId, setSelectedProvider] = React.useState(() => (
    connectRequested ? ADD_PROVIDER_ID : classificationRequested ? CLASSIFICATION_PAGE_ID : openRequested ?? ''
  ));
  React.useEffect(() => {
    if (!connectRequested) return;
    setSelectedProvider(ADD_PROVIDER_ID);
    setConnectRequested(false);
  }, [connectRequested, setConnectRequested]);
  React.useEffect(() => {
    if (!classificationRequested) return;
    setSelectedProvider(CLASSIFICATION_PAGE_ID);
    setClassificationRequested(false);
  }, [classificationRequested, setClassificationRequested]);
  React.useEffect(() => {
    if (!openRequested) return;
    setSelectedProvider(openRequested);
    setOpenRequested(null);
  }, [openRequested, setOpenRequested]);
  const getModelMetadata = useConfigStore((state) => state.getModelMetadata);
  const hiddenModels = useUIStore((state) => state.hiddenModels);
  const customProviderIcons = useUIStore((state) => state.customProviderIcons);
  const setCustomProviderIcon = useUIStore((state) => state.setCustomProviderIcon);
  const customProviderLogos = useUIStore((state) => state.customProviderLogos);
  const setCustomProviderLogo = useUIStore((state) => state.setCustomProviderLogo);
  const toggleHiddenModel = useUIStore((state) => state.toggleHiddenModel);
  const hideAllModels = useUIStore((state) => state.hideAllModels);
  const showAllModels = useUIStore((state) => state.showAllModels);

  const loadProviders = useConfigStore((state) => state.loadProviders);
  const catalogReloadRevision = useConfigStore((state) => state.catalogReloadRevision);
  React.useEffect(() => {
    void loadProviders({ directory: settingsDirectory, source: 'settings:providers' });
  }, [catalogReloadRevision, loadProviders, settingsDirectory]);

  const [catalog, setCatalog] = React.useState<IntegrationCatalog | null>(() => peekIntegrationCatalog(settingsDirectory));
  const connectIntegrationKey = (request: IntegrationKeyRequest) => connectProviderKey(settingsDirectory, request);
  const [integrationsLoadFailed, setIntegrationsLoadFailed] = React.useState(false);
  const integrations = catalog?.integrations ?? null;
  const storedLoginIds = settingsOnlyProviders
    .filter((provider) => providerHoldsStoredLogin(integrations, provider))
    .map((provider) => provider.id)
    .join('\n');
  const providers = React.useMemo(() => {
    const loginIds = new Set(storedLoginIds.split('\n'));
    const manageable = settingsOnlyProviders.filter(
      (provider) => provider.models.length > 0 || loginIds.has(provider.id),
    );
    return manageable.length > 0 ? [...chatProviders, ...manageable] : chatProviders;
  }, [chatProviders, settingsOnlyProviders, storedLoginIds]);
  const [disabledProviders, setDisabledProviders] = React.useState<string[] | null>(null);
  React.useEffect(() => {
    let active = true;
    fetchDisabledProviders()
      .then((list) => { if (active) setDisabledProviders(list); })
      .catch((error) => { console.warn('[providers] could not read disabled providers:', error); });
    return () => { active = false; };
  }, []);
  const handleProviderDisabled = React.useCallback(async (providerId: string, disabled: boolean) => {
    try {
      setDisabledProviders(await setProviderDisabledRequest(providerId, disabled));
      if (disabled) setSelectedProvider('');
      toast.success(disabled
        ? t('settings.providers.disabled.toast.disabled', { provider: providerId })
        : t('settings.providers.disabled.toast.enabled', { provider: providerId }));
      void loadProviders({ directory: settingsDirectory, source: 'settings:providers', fresh: true });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }, [loadProviders, setSelectedProvider, settingsDirectory, t]);
  const authLoading = catalog === null && !integrationsLoadFailed;
  const [authBusyKey, setAuthBusyKey] = React.useState<string | null>(null);
  const [accountBusyId, setAccountBusyId] = React.useState<string | null>(null);
  const [modelQuery, setModelQuery] = React.useState('');
  const [candidateProviderId, setCandidateProviderId] = React.useState('');
  const [providerSources, setProviderSources] = React.useState<Record<string, ProviderSources>>({});
  const [storedProviderConfigs, setStoredProviderConfigs] = React.useState<Record<string, StoredProviderSource | null>>({});
  const [sourcesFailedFor, setSourcesFailedFor] = React.useState<string | null>(null);
  const [providerSourcesRevision, setProviderSourcesRevision] = React.useState(0);
  const [integrationsRevision, setIntegrationsRevision] = React.useState(0);
  const backgroundIntegrationsReadRef = React.useRef(false);
  const enterpriseLocked = useEnterpriseMode();
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
    let isMounted = true;
    const background = backgroundIntegrationsReadRef.current;
    backgroundIntegrationsReadRef.current = false;

    const loadIntegrations = async () => {
      try {
        const next = await loadIntegrationCatalog(settingsDirectory);
        if (!isMounted) return;
        setCatalog(next);
        setIntegrationsLoadFailed(false);
      } catch (error) {
        if (!isMounted) return;
        console.error('Failed to load provider integrations:', error);
        if (background) return;
        setIntegrationsLoadFailed(true);
        toast.error(t('settings.providers.page.toast.authMethodsLoadFailed'));
      }
    };

    loadIntegrations();

    return () => {
      isMounted = false;
    };
  }, [integrationsRevision, settingsDirectory, t]);

  React.useEffect(
    () => subscribeCredentialChanges(() => {
      backgroundIntegrationsReadRef.current = true;
      setIntegrationsRevision((revision) => revision + 1);
    }, settingsDirectory),
    [settingsDirectory],
  );

  const connectedProviderIds = React.useMemo(
    () => new Set(providers.map((provider) => provider.id)),
    [providers]
  );

  const catalogProviders = React.useMemo<CatalogProviders>(
    () => (catalog ? listCanonicalProviders(catalog) : integrationsLoadFailed ? 'failed' : 'loading'),
    [catalog, integrationsLoadFailed],
  );

  const unconnectedProviders = React.useMemo(
    () => (catalog ? listConnectableProviders(catalog, connectedProviderIds) : null),
    [catalog, connectedProviderIds]
  );

  React.useEffect(() => {
    if (selectedProviderId !== ADD_PROVIDER_ID || !unconnectedProviders || unconnectedProviders.length === 0) {
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
      setEditingCustomProviderId(null);
      setEditingCustomFormInitial(null);
      setEditingCustomScope(null);
      setCustomAuthFailureHint(null);
      return;
    }

    if (editingCustomProviderId && editingCustomProviderId !== selectedProviderId) {
      setEditingCustomProviderId(null);
      setEditingCustomFormInitial(null);
      setEditingCustomScope(null);
      setCustomAuthFailureHint(null);
    }
  }, [selectedProviderId, editingCustomProviderId]);

  React.useEffect(() => {
    if (!selectedProviderId || selectedProviderId === ADD_PROVIDER_ID || selectedProviderId === CLASSIFICATION_PAGE_ID) {
      return;
    }

    let cancelled = false;
    const loadSources = async () => {
      try {
        const source = await fetchProviderSource(selectedProviderId, settingsDirectory, t('settings.providers.page.toast.providerSourcesLoadFailed'));
        if (!cancelled && source) {
          setProviderSources((prev) => ({ ...prev, [selectedProviderId]: source.sources }));
          setStoredProviderConfigs((prev) => ({ ...prev, [selectedProviderId]: source.stored }));
        }
        if (!cancelled) setSourcesFailedFor(source ? null : selectedProviderId);
      } catch (error) {
        if (!cancelled) {
          console.error('Failed to load provider sources:', error);
          setSourcesFailedFor(selectedProviderId);
        }
      }
    };

    loadSources();
    return () => {
      cancelled = true;
      setSourcesFailedFor(null);
    };
  }, [selectedProviderId, providerSourcesRevision, settingsDirectory, t]);

  const refreshProviderSources = React.useCallback(() => {
    setProviderSourcesRevision((revision) => revision + 1);
  }, []);

  const refreshIntegrations = React.useCallback(() => {
    setIntegrationsRevision((revision) => revision + 1);
  }, []);

  const markAuthWriteSucceeded = React.useCallback((providerId: string) => {
    setCatalog((prev) => prev && {
      ...prev,
      integrations: prev.integrations.map((integration) => (
        integration.id === providerId && integration.connections.length === 0
          ? { ...integration, connections: [{ type: 'credential', id: `pending:${providerId}`, label: providerId, method: 'key' }] }
          : integration
      )),
    });
    setCandidateProviderId('');
    setSelectedProvider(providerId);
    refreshProviderSources();
    refreshIntegrations();
  }, [refreshIntegrations, refreshProviderSources, setSelectedProvider]);

  const selectedProvider = providers.find((provider) => provider.id === selectedProviderId);
  const selectedSources = selectedProviderId ? providerSources[selectedProviderId] : undefined;

  const [logoBusyId, setLogoBusyId] = React.useState<string | null>(null);
  const applyLogoPlan = async (providerId: string, logoPlan: CustomProviderLogoPlan) => {
    if (logoPlan.kind === 'keep' || !providerLogoUploadSupported()) return;
    if (logoPlan.kind === 'remove' && !useUIStore.getState().customProviderLogos[providerId]) return;
    setLogoBusyId(providerId);
    try {
      if (logoPlan.kind === 'upload') {
        setCustomProviderLogo(providerId, await uploadProviderLogo(providerId, logoPlan.file));
      } else {
        await removeProviderLogo(providerId);
        setCustomProviderLogo(providerId, null);
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      toast.error(logoPlan.kind === 'upload'
        ? t('settings.providers.page.logo.toast.uploadFailed', { reason })
        : t('settings.providers.page.logo.toast.removeFailed', { reason }));
    } finally {
      setLogoBusyId(null);
    }
  };

  const handleSaveCustomProvider = async (plan: CustomProviderPersistPlan) => {
    const busyKey = `custom:${plan.providerID}`;
    setAuthBusyKey(busyKey);
    setLastCustomPersistId(plan.providerID);
    setCustomAuthFailureHint(null);

    try {
      const keyRequest = buildIntegrationKeyRequest(plan);
      const upsertBody = buildProviderUpsertRequest(plan, {
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
        throw new Error(payload?.error || t('settings.providers.page.toast.customProviderSaveFailed'));
      }
      if (keyRequest) {
        try {
          await storeCustomProviderKey(settingsDirectory, keyRequest);
        } catch (error) {
          setCustomAuthFailureHint(t('settings.providers.page.custom.authFailure.keyAfterConfig'));
          throw error;
        }
      }

      const nextCustomProviderIcons = { ...useUIStore.getState().customProviderIcons };
      if (plan.icon) nextCustomProviderIcons[plan.providerID] = plan.icon;
      else delete nextCustomProviderIcons[plan.providerID];
      await updateDesktopSettings({ customProviderIcons: nextCustomProviderIcons });
      setCustomProviderIcon(plan.providerID, plan.icon);
      await applyLogoPlan(plan.providerID, plan.logo);

      toast.success(t('settings.providers.page.toast.customProviderSaved', { provider: plan.name }));
      setCandidateProviderId('');
      setEditingCustomProviderId(null);
      setEditingCustomFormInitial(null);
      setEditingCustomScope(null);
      setCustomAuthFailureHint(null);
      setLastCustomPersistId(null);
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
    markAuthWriteSucceeded(providerId);
  };

  const handleDisconnectProvider = async (providerId: string) => {
    const busyKey = `disconnect:${providerId}`;
    setAuthBusyKey(busyKey);

    try {
      const credentials = getCredentialConnections(
        findIntegrationForProvider(integrations ?? [], providerId),
      );
      const sdk = opencodeClient.getSdkClient();
      for (const credential of credentials) {
        await sdk.credential.remove({ credentialID: credential.id });
      }

      toast.success(t('settings.providers.page.toast.providerDisconnected'));
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

  const runAccountAction = async (
    account: CredentialConnection,
    action: () => Promise<void>,
    messages: { success?: string; failure: string },
  ) => {
    setAccountBusyId(account.id);
    try {
      await action();
      if (messages.success) toast.success(messages.success);
    } catch (error) {
      console.error('Provider account action failed:', error);
      toast.error(messages.failure);
    } finally {
      setAccountBusyId(null);
      refreshIntegrations();
    }
  };

  const handleActivateAccount = (account: CredentialConnection) => runAccountAction(
    account,
    async () => {
      await opencodeClient.getSdkClient().credential.activate({ credentialID: account.id });
    },
    {
      success: t('settings.providers.accounts.toast.switched', { account: account.label }),
      failure: t('settings.providers.accounts.toast.switchFailed'),
    },
  );

  const handleRenameAccount = (account: CredentialConnection, label: string) => runAccountAction(
    account,
    async () => {
      await opencodeClient.getSdkClient().credential.update({ credentialID: account.id, label });
    },
    { failure: t('settings.providers.accounts.toast.renameFailed') },
  );

  const handleRemoveAccount = (account: CredentialConnection) => runAccountAction(
    account,
    async () => {
      await opencodeClient.getSdkClient().credential.remove({ credentialID: account.id });
      refreshProviderSources();
    },
    {
      success: t('settings.providers.accounts.toast.removed'),
      failure: t('settings.providers.accounts.toast.removeFailed'),
    },
  );

  const backToGrid = () => {
    setCandidateProviderId('');
    setSelectedProvider('');
  };
  const backButton = <SettingsBackButton label={t('settings.providers.page.back')} onClick={backToGrid} />;


  const openProviderForKey = (providerId: string) => {
    if (providers.some((provider) => provider.id === providerId)) {
      setSelectedProvider(providerId);
      return;
    }
    setCandidateProviderId(providerId);
    setSelectedProvider(ADD_PROVIDER_ID);
  };

  if (selectedProviderId === CLASSIFICATION_PAGE_ID) {
    return <ClassificationProvidersPage titleLeading={backButton} onOpenProvider={openProviderForKey} />;
  }

  if (isAddMode && !enterpriseLocked && !candidateProviderId) {
    return (
      <SettingsPageLayout
        title={t('settings.providers.page.connect.title')}
        titleLeading={backButton}
        showSaveStatus={false}
      >
        <ProviderConnectPicker
          providers={unconnectedProviders}
          loadFailed={integrationsLoadFailed}
          onSelect={setCandidateProviderId}
          onSelectCustom={() => setCandidateProviderId(CUSTOM_PROVIDER_ID)}
        />
      </SettingsPageLayout>
    );
  }

  if (isAddMode && !enterpriseLocked) {
    const candidateBackButton = (
      <SettingsBackButton label={t('settings.providers.page.back')} onClick={() => setCandidateProviderId('')} />
    );
    const candidateName = unconnectedProviders?.find((provider) => provider.id === candidateProviderId)?.name ?? candidateProviderId;
    return (
      <SettingsPageLayout
        title={isCustomCreateMode ? t('settings.providers.page.connect.title') : candidateName}
        titleLeading={isCustomCreateMode ? candidateBackButton : (
          <span className="flex items-center gap-2">
            {candidateBackButton}
            <ProviderLogo providerId={candidateProviderId} className="h-5 w-5 shrink-0" />
          </span>
        )}
        showSaveStatus={false}
      >
          {isCustomCreateMode ? (
            <CustomProviderForm
              mode="create"
              existingProviderIDs={connectedProviderIds}
              catalogProviders={catalogProviders}
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
          ) : (
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
                    return (
                      <ProviderAuthMethodCards
                        key={candidateProviderId}
                        integrationId={candidateProviderId}
                        showApiKey={shouldShowApiKeyAuth(candidateIntegration)}
                        keyMethod={getKeyMethod(candidateIntegration)}
                        signInIntegrationId={getSignInIntegrationId(candidateProviderId)}
                        signInMethods={getSignInMethods(
                          findIntegrationForProvider(integrations ?? [], getSignInIntegrationId(candidateProviderId)),
                        )}
                        credentials={[]}
                        canAdd
                        directory={settingsDirectory}
                        connectKey={connectIntegrationKey}
                        onKeySaved={() => markAuthWriteSucceeded(candidateProviderId)}
                        onSignedIn={() => handleOAuthConnected(candidateProviderId)}
                      />
                    );
                  })()}
                </>
              )}
            </SettingsSection>
          )}
      </SettingsPageLayout>
    );
  }

  if (!selectedProvider) {
    return (
      <ProviderGrid
        providers={providers}
        integrations={integrations}
        directory={settingsDirectory}
        onSelect={setSelectedProvider}
        onConnect={() => setSelectedProvider(ADD_PROVIDER_ID)}
        onOpenClassification={() => setSelectedProvider(CLASSIFICATION_PAGE_ID)}
        disabledProviders={disabledProviders}
        onEnableProvider={(providerId) => void handleProviderDisabled(providerId, false)}
      />
    );
  }

  const providerModels = Array.isArray(selectedProvider.models) ? selectedProvider.models : [];
  const canHideModels = !settingsOnlyProviders.includes(selectedProvider);
  const selectedIntegration = findIntegrationForProvider(integrations ?? [], selectedProvider.id);
  const signInMethods = getSignInMethods(
    findIntegrationForProvider(integrations ?? [], getSignInIntegrationId(selectedProvider.id)),
  );
  const showApiKeyAuth = shouldShowApiKeyAuth(selectedIntegration);
  const integrationsLoaded = integrations !== null;
  const sourcesLoaded = Boolean(selectedSources);
  const isEditableCustomProvider = isConfigDefinedCustomProvider(selectedProvider, selectedSources);
  const hasCredentials = providerHasCredentials({
    connections: getProviderConnections(integrations ?? [], selectedProvider.id),
    optionsApiKey: readProviderApiKeySetting(selectedProvider),
    machineCredentials: usesMachineCredentials(selectedProvider),
  });
  const sections = providerPageSections({
    canBeConfigDefined: isCustomOpenAICompatibleProvider(selectedProvider), isEditableCustomProvider,
    sources: sourcesLoaded ? 'loaded' : sourcesFailedFor === selectedProvider.id ? 'failed' : 'loading',
    canUploadLogo: providerLogoUploadSupported(), locked: enterpriseLocked,
  });
  const showModelsSection = sections.models && shouldShowModelsSection({
    modelCount: providerModels.length, integrationsLoaded,
    hasCredentials,
    isEditableCustomProvider,
  });
  const providerConnections = getProviderConnections(integrations ?? [], selectedProvider.id) ?? [];
  const usedIntegrationId = selectedProvider.integrationID ?? selectedProvider.id;
  const usedCredentials = getCredentialConnections(findIntegrationForProvider(integrations ?? [], usedIntegrationId));
  const activeAccountId = usedCredentials[0]?.id ?? null;
  const unusedAccountIds = new Set(
    providerConnections.flatMap((connection) => (
      connection.type === 'credential' && !usedCredentials.some((used) => used.id === connection.id)
        ? [connection.id]
        : []
    )),
  );
  const storedCredentials = providerConnections.filter(
    (connection): connection is CredentialConnection => connection.type === 'credential',
  );
  const environmentConnections = providerConnections.filter((connection) => connection.type === 'env');
  const inUseWithoutCredential = activeAccountId !== null
    ? null
    : usesMachineCredentials(selectedProvider)
      ? 'external'
      : environmentConnections.length > 0 || readProviderApiKeySetting(selectedProvider) !== null
        ? 'key'
        : null;
  const configSources = [
    selectedSources?.user.exists ? t('settings.providers.page.connectionDetails.source.userConfig') : null,
    selectedSources?.project.exists ? t('settings.providers.page.connectionDetails.source.projectConfig') : null,
    selectedSources?.custom?.exists ? t('settings.providers.page.connectionDetails.source.customConfig') : null,
  ].filter((source): source is string => source !== null);
  const providerTitleLeading = (
    <span className="flex items-center gap-2">
      {backButton}
      <ProviderLogo providerId={selectedProvider.id} className="h-5 w-5 shrink-0" />
    </span>
  );
  const providerDescription = (
    <span className="typography-settings-description text-muted-foreground">
      <span className="font-mono">{selectedProvider.id}</span>
      {configSources.length > 0
        ? <> · {t('settings.providers.page.configuredIn', { sources: configSources.join(', ') })}</>
        : null}
    </span>
  );

  const modelCountAccessory = (
    <span className="typography-micro text-muted-foreground font-normal">({providerModels.length})</span>
  );

  const filteredModels = rankByQuery(providerModels, modelQuery, (model) => [
    typeof model?.name === 'string' ? model.name : '',
    typeof model?.id === 'string' ? model.id : '',
  ]);

  if (isCustomEditMode && isEditableCustomProvider && editingCustomFormInitial) {
    return (
      <SettingsPageLayout
        title={selectedProvider.name || selectedProvider.id}
        titleLeading={providerTitleLeading}
        description={providerDescription}
        showSaveStatus={false}
      >
        <CustomProviderForm
          mode="edit"
          existingProviderIDs={connectedProviderIds}
          catalogProviders={catalogProviders}
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
      titleLeading={providerTitleLeading}
      description={providerDescription}
      showSaveStatus={false}
    >
      <SettingsSection
        title={t('settings.providers.accounts.title')}
        info={t('settings.providers.accounts.info')}
        headerAction={(
          <div className="flex items-center gap-1">
            {isEditableCustomProvider && !enterpriseLocked ? (
              <Button
                variant="outline"
                size="xs"
                className="!font-normal"
                onClick={() => {
                  setCustomAuthFailureHint(null);
                  setEditingCustomFormInitial(providerToEditFormState(
                    selectedProvider,
                    storedProviderConfigs[selectedProvider.id] ?? null,
                    customProviderIcons[selectedProvider.id],
                  ));
                  setEditingCustomScope(resolveProviderConfigScope(selectedSources));
                  setEditingCustomProviderId(selectedProvider.id);
                }}
              >
                {t('settings.providers.page.actions.edit')}
              </Button>
            ) : null}
            {disabledProviders !== null ? (
              <Button
                variant="outline"
                size="xs"
                className="!font-normal"
                title={t('settings.providers.disabled.disableHint')}
                onClick={() => void handleProviderDisabled(selectedProvider.id, true)}
              >
                {t('settings.providers.disabled.disable')}
              </Button>
            ) : null}
          </div>
        )}
        settingsItem="providers.auth"
        contentClassName="space-y-4"
      >
        {environmentConnections.length > 0 ? (
          <ProviderAccounts
            connections={environmentConnections}
            activeId={activeAccountId}
            unusedIds={unusedAccountIds}
            busyId={accountBusyId}
            canSwitch={false}
            showActive={false}
            onActivate={(account) => void handleActivateAccount(account)}
            onRename={(account, label) => void handleRenameAccount(account, label)}
            onRemove={(account) => void handleRemoveAccount(account)}
          />
        ) : null}

        {authLoading ? (
          <ProviderAuthMethodsLoading integrationId={selectedProvider.id} canAdd={!enterpriseLocked} />
        ) : (
          <ProviderAuthMethodCards
            key={selectedProvider.id}
            integrationId={selectedProvider.id}
            showApiKey={showApiKeyAuth}
            keyMethod={getKeyMethod(selectedIntegration)}
            signInIntegrationId={getSignInIntegrationId(selectedProvider.id)}
            signInMethods={signInMethods}
            credentials={storedCredentials}
            accounts={{
              activeId: activeAccountId,
              unusedIds: unusedAccountIds,
              busyId: accountBusyId,
              ...getAccountSwitching(providerConnections, unusedAccountIds),
              onActivate: (account) => void handleActivateAccount(account),
              onRename: (account, label) => void handleRenameAccount(account, label),
              onRemove: (account) => void handleRemoveAccount(account),
            }}
            inUseWithoutCredential={inUseWithoutCredential}
            canAdd={!enterpriseLocked}
            directory={settingsDirectory}
            connectKey={connectIntegrationKey}
            onKeySaved={() => markAuthWriteSucceeded(selectedProvider.id)}
            onSignedIn={() => handleOAuthConnected(selectedProvider.id)}
          />
        )}

        {usedCredentials.length > 0 && !isVSCodeRuntime() ? (
          <ProviderAccountSwitchToggle providerId={selectedProvider.id} accountCount={usedCredentials.length} />
        ) : null}

        {enterpriseLocked ? (
          <p className="typography-meta text-muted-foreground">{t('settings.providers.enterpriseMode')}</p>
        ) : null}
      </SettingsSection>

      {sections.logo ? (
        <SettingsSection
          title={t('settings.providers.page.logo.title')}
          info={t('settings.providers.page.logo.info')}
          settingsItem="providers.logo"
        >
          <ProviderLogoImageControl
            preview={customProviderLogos[selectedProvider.id]
              ? <ProviderLogo providerId={selectedProvider.id} alt="" className="size-5" />
              : null}
            busy={logoBusyId === selectedProvider.id}
            onPick={(file) => void applyLogoPlan(selectedProvider.id, { kind: 'upload', file })}
            onRemove={() => void applyLogoPlan(selectedProvider.id, { kind: 'remove' })}
          />
        </SettingsSection>
      ) : null}

      {sections.models && providerModels.length === 0 ? (
        <SettingsSection
          title={t('settings.providers.page.models.title')}
          titleAccessory={modelCountAccessory}
          settingsItem="providers.models"
        >
          <p className="typography-meta text-muted-foreground">{t('settings.providers.page.models.none')}</p>
        </SettingsSection>
      ) : null}

      {showModelsSection ? (
      <SettingsSection
        title={t('settings.providers.page.models.title')}
        titleAccessory={modelCountAccessory}
        headerAction={canHideModels ? (
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
        ) : undefined}
        settingsItem="providers.models"
      >
            <div className="relative mb-2">
              <Icon name="search" className="absolute inset-s-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                value={modelQuery}
                onChange={(event) => setModelQuery(event.target.value)}
                placeholder={t('settings.providers.page.models.filterPlaceholder')}
                className="h-7 ps-8 w-full"
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
                  const isHidden = canHideModels && hiddenModels.some(
                    (item) => item.providerID === selectedProvider.id && item.modelID === modelId
                  );

                  const contextTokens = formatTokens(metadata?.limit?.context);
                  const outputTokens = formatTokens(metadata?.limit?.output);
                  const tokenSummary = [
                    contextTokens ? `${contextTokens} ${t('settings.providers.page.models.tokenBadge.context')}` : null,
                    outputTokens ? `${outputTokens} ${t('settings.providers.page.models.tokenBadge.output')}` : null,
                  ].filter(Boolean).join(' · ');

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
                        {isMobile ? (
                          (tokenSummary || capabilityIcons.length > 0) ? (
                            <SettingsInfoHint className="h-6 w-6">
                              <div className="space-y-1.5">
                                {tokenSummary ? <div className="font-medium">{tokenSummary}</div> : null}
                                {capabilityIcons.map(({ key, icon: iconName, label }) => (
                                  <div key={key} className="flex items-center gap-1.5">
                                    <Icon name={iconName} className="h-3.5 w-3.5" />
                                    {label}
                                  </div>
                                ))}
                              </div>
                            </SettingsInfoHint>
                          ) : null
                        ) : (
                          <>
                        {tokenSummary ? (
                          <span className="typography-micro text-muted-foreground flex-shrink-0 oc-tile-inset px-1.5 py-0.5 rounded">
                            {tokenSummary}
                          </span>
                        ) : null}
                        {capabilityIcons.length > 0 && (
                          <div className="flex items-center gap-1 flex-shrink-0">
                            {capabilityIcons.map(({ key, icon: iconName, label }) => (
                              <span
                                key={key}
                                className="flex h-5 w-5 rounded items-center justify-center text-muted-foreground oc-tile-inset"
                                title={label}
                                aria-label={label}
                              >
                                <Icon name={iconName} className="h-3 w-3" />
                              </span>
                            ))}
                          </div>
                        )}
                          </>
                        )}
                        {canHideModels ? (
                        <button
                          type="button"
                          onClick={() => toggleHiddenModel(selectedProvider.id, modelId)}
                          className="flex h-6 w-6 items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-[var(--interactive-hover)]/50"
                          title={isHidden ? t('settings.providers.page.models.actions.showModelInSelectors') : t('settings.providers.page.models.actions.hideModelFromSelectors')}
                          aria-label={isHidden ? t('settings.providers.page.models.actions.showModel') : t('settings.providers.page.models.actions.hideModel')}
                        >
                          {isHidden ? <Icon name="eye-off" className="h-3.5 w-3.5" /> : <Icon name="eye" className="h-3.5 w-3.5" />}
                        </button>
                        ) : null}
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
