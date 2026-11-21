import React from 'react';
import { ModelSelector } from '@/components/sections/agents/ModelSelector';
import { AgentSelector } from '@/components/sections/commands/AgentSelector';
import {
  SettingsSection,
  SettingsFieldRow,
  SettingsCheckboxRow,
  SETTINGS_CUSTOM_TRIGGER_CLASS,
  SETTINGS_HELPER_CLASS,
} from '@/components/sections/shared/SettingsSection';
import { CompactionSettings } from './CompactionSettings';
import { SessionWarmingCheckbox } from './SessionWarmingCheckbox';
import { SettingsInlineLink } from '@/components/sections/classification/JevAccessNote';
import { SessionWarmingModeField } from './SessionWarmingModeField';
import { PermissionDefaultModeField } from './PermissionDefaultModeField';
import { isVSCodeRuntime } from '@/lib/desktop';
import { loadDesktopSettings, updateDesktopSettings } from '@/lib/persistence';
import { selectConfigAgentsForDirectory, selectIsModelMissingFromCatalog, selectProvidersForDirectory, useConfigStore } from '@/stores/useConfigStore';
import { useChatsRoot } from '@/hooks/useChatsRoot';
import { useUIStore } from '@/stores/useUIStore';
import { useSelectionStore } from '@/sync/selection-store';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useI18n } from '@/lib/i18n';
import { parseModelIdentifier } from '@/lib/modelIdentifier';
import { isAutoModel } from '@/lib/routing/autoModel';
import { useCallableModelProviders } from '@/hooks/useCallableModelProviders';
import { isPrimaryMode } from '@/components/chat/mobileControlsUtils';
import { listModelVariantIds, modelVariantNames, type ModelVariantSource } from '@/lib/modelVariants';
import { ModelVariantSelect } from './ModelVariantSelect';

const getDisplayModel = (
  storedModel: string | undefined
): { providerId: string; modelId: string } => {
  const parsed = parseModelIdentifier(storedModel);
  if (parsed) {
    return parsed;
  }

  return { providerId: '', modelId: '' };
};

export const DefaultsSettings: React.FC = () => {
  const { t } = useI18n();
  const setProvider = useConfigStore((state) => state.setProvider);
  const setModel = useConfigStore((state) => state.setModel);
  const setAgent = useConfigStore((state) => state.setAgent);
  const setCurrentVariant = useConfigStore((state) => state.setCurrentVariant);
  const setCurrentVariantOverride = useConfigStore((state) => state.setCurrentVariantOverride);
  const setSettingsDefaultModel = useConfigStore((state) => state.setSettingsDefaultModel);
  const setSettingsDefaultVariant = useConfigStore((state) => state.setSettingsDefaultVariant);
  const setSettingsDefaultAgent = useConfigStore((state) => state.setSettingsDefaultAgent);
  const setChatsDefaultModel = useConfigStore((state) => state.setChatsDefaultModel);
  const setChatsDefaultVariant = useConfigStore((state) => state.setChatsDefaultVariant);
  const setChatsDefaultAgent = useConfigStore((state) => state.setChatsDefaultAgent);
  const chatDraftOpen = useSessionUIStore((state) => (
    !state.currentSessionId && Boolean(state.newSessionDraft?.open) && state.newSessionDraft?.target === 'chat'
  ));
  const chatsRoot = useChatsRoot();
  const chatDraftKeepsModel = useConfigStore((state) => {
    const chatsModel = chatDraftOpen ? parseModelIdentifier(state.chatsDefaultModel) : null;
    return chatsModel !== null
      && !selectIsModelMissingFromCatalog(state, chatsRoot, chatsModel.providerId, chatsModel.modelId);
  });
  const chatDraftKeepsAgent = useConfigStore((state) => {
    if (!chatDraftOpen || !state.chatsDefaultAgent) return false;
    const agents = selectConfigAgentsForDirectory(state, chatsRoot);
    return agents.length === 0 || agents.some((agent) => agent.name === state.chatsDefaultAgent);
  });
  const selectionIsManual = useConfigStore((state) => state.selectionSource === 'manual');
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const getSessionModelSelection = useSelectionStore((state) => state.getSessionModelSelection);
  const getSessionAgentSelection = useSelectionStore((state) => state.getSessionAgentSelection);
  const agentIsPicked = useConfigStore((state) => state.agentSelectionSource === 'manual');
  const pickedAgentPinsModel = useConfigStore((state) => {
    if (state.agentSelectionSource !== 'manual') return false;
    const agent = state.agents.find((candidate) => candidate.name === state.currentAgentName);
    return Boolean(agent?.model?.providerID && agent.model.id);
  });
  const chatHasOwnModel = Boolean(
    pickedAgentPinsModel
    || (selectionIsManual && currentSessionId && getSessionModelSelection(currentSessionId)),
  );
  const chatHasOwnAgent = Boolean(
    agentIsPicked && currentSessionId && getSessionAgentSelection(currentSessionId),
  );
  const isVSCode = React.useMemo(() => isVSCodeRuntime(), []);
  const requestSettingsJump = useUIStore((state) => state.requestSettingsJump);
  const providers = useConfigStore((state) => state.providers);
  const modelsMetadata = useConfigStore((state) => state.modelsMetadata);

  const [defaultModel, setDefaultModel] = React.useState<string | undefined>();
  const [defaultVariant, setDefaultVariant] = React.useState<string | undefined>();
  const [defaultAgent, setDefaultAgent] = React.useState<string | undefined>();
  const [smallModelUseDefault, setSmallModelUseDefault] = React.useState(true);
  const [smallModelOverride, setSmallModelOverride] = React.useState<string | undefined>();
  const [smallModelVariant, setSmallModelVariant] = React.useState<string | undefined>();
  const smallModelProviders = useCallableModelProviders() ?? [];
  const [walkthroughModelOverride, setWalkthroughModelOverride] = React.useState<string | undefined>();
  const [walkthroughModelVariant, setWalkthroughModelVariant] = React.useState<string | undefined>();
  const [fallbackModel, setFallbackModel] = React.useState<string | undefined>();
  const [fallbackVariant, setFallbackVariant] = React.useState<string | undefined>();
  const [chatsModel, setChatsModel] = React.useState<string | undefined>();
  const [chatsVariant, setChatsVariant] = React.useState<string | undefined>();
  const [chatsAgent, setChatsAgent] = React.useState<string | undefined>();
  const chatsProviders = useConfigStore((state) => selectProvidersForDirectory(state, chatsRoot));
  const [isLoading, setIsLoading] = React.useState(true);

  const parsedModel = React.useMemo(() => getDisplayModel(defaultModel), [defaultModel]);
  const defaultModelMissing = useConfigStore((state) => (
    selectIsModelMissingFromCatalog(state, undefined, parsedModel.providerId, parsedModel.modelId)
  ));
  const parsedChatsModel = React.useMemo(() => getDisplayModel(chatsModel), [chatsModel]);
  const chatsModelNote = useConfigStore((state) => {
    if (!chatsRoot || !selectIsModelMissingFromCatalog(state, chatsRoot, parsedChatsModel.providerId, parsedChatsModel.modelId)) return null;
    const global = parseModelIdentifier(state.settingsDefaultModel);
    return global && !selectIsModelMissingFromCatalog(state, chatsRoot, global.providerId, global.modelId)
      ? 'settings.openchamber.defaults.field.chatsModelUnavailableUsesGlobal' as const
      : 'settings.openchamber.defaults.field.chatsModelUnavailable' as const;
  });
  const chatsVariants = React.useMemo(() => {
    const { providerId, modelId } = parsedChatsModel;
    if (!providerId || !modelId) return [];
    const model = chatsProviders
      .find((provider) => provider.id === providerId)
      ?.models.find((entry) => entry.id === modelId);
    return modelVariantNames(model);
  }, [chatsProviders, parsedChatsModel]);

  React.useEffect(() => {
    const loadSettings = async () => {
      try {
        const data = await loadDesktopSettings();
        if (data) {
          const model = data.defaultModel?.trim() || undefined;
          const variant = data.defaultVariant?.trim() || undefined;
          const agent = data.defaultAgent?.trim() || undefined;

          if (model !== undefined) setDefaultModel(model);
          if (variant !== undefined) setDefaultVariant(variant);
          if (agent !== undefined) setDefaultAgent(agent);
          setChatsModel(data.chatsDefaultModel?.trim() || undefined);
          setChatsVariant(data.chatsDefaultVariant?.trim() || undefined);
          setChatsAgent(data.chatsDefaultAgent?.trim() || undefined);
          if (data.smallModelUseDefault !== undefined) setSmallModelUseDefault(data.smallModelUseDefault);
          const smallOverride = data.smallModelOverride?.trim();
          if (smallOverride) {
            setSmallModelOverride(smallOverride);
          }
          const smallVariant = data.smallModelVariant?.trim();
          if (smallVariant) {
            setSmallModelVariant(smallVariant);
          }
          const walkthroughOverride = data.walkthroughModelOverride?.trim();
          if (walkthroughOverride) {
            setWalkthroughModelOverride(walkthroughOverride);
          }
          const walkthroughVariant = data.walkthroughModelVariant?.trim();
          if (walkthroughVariant) {
            setWalkthroughModelVariant(walkthroughVariant);
          }
          const fallback = data.fallbackModel?.trim();
          if (fallback) {
            setFallbackModel(fallback);
          }
          const fallbackThinking = data.fallbackVariant?.trim();
          if (fallbackThinking) {
            setFallbackVariant(fallbackThinking);
          }
        }
      } catch (error) {
        console.warn('Failed to load defaults settings:', error);
      } finally {
        setIsLoading(false);
      }
    };
    loadSettings();
  }, []);

  const handleModelChange = React.useCallback(
    async (providerId: string, modelId: string) => {
      const newValue = providerId && modelId ? `${providerId}/${modelId}` : undefined;
      setDefaultModel(newValue);
      setDefaultVariant(undefined);
      setSettingsDefaultVariant(undefined);
      setSettingsDefaultModel(newValue);

      if (!chatHasOwnModel && !chatDraftKeepsModel) {
        setCurrentVariant(undefined);

        if (providerId && modelId) {
          const provider = providers.find((p) => p.id === providerId);
          if (provider || isAutoModel(providerId, modelId)) {
            setProvider(providerId);
            setModel(modelId);
          }
        }
      }

      try {
        await updateDesktopSettings({ defaultModel: newValue ?? '', defaultVariant: '' });
      } catch (error) {
        console.warn('Failed to save default model:', error);
      }
    },
    [chatDraftKeepsModel, chatHasOwnModel, providers, setCurrentVariant, setModel, setProvider, setSettingsDefaultModel, setSettingsDefaultVariant]
  );

  const handleVariantChange = React.useCallback(
    async (newValue: string | undefined) => {
      setDefaultVariant(newValue);
      setSettingsDefaultVariant(newValue);
      if (!chatHasOwnModel && !chatDraftKeepsModel) {
        setCurrentVariantOverride(newValue ?? null, newValue);
      }

      try {
        await updateDesktopSettings({ defaultVariant: newValue ?? '' });
      } catch (error) {
        console.warn('Failed to save default variant:', error);
      }
    },
    [chatDraftKeepsModel, chatHasOwnModel, setCurrentVariantOverride, setSettingsDefaultVariant]
  );

  const handleAgentChange = React.useCallback(
    async (agentName: string) => {
      const newValue = agentName || undefined;
      setDefaultAgent(newValue);
      setSettingsDefaultAgent(newValue);

      if (agentName && !chatHasOwnAgent && !chatDraftKeepsAgent) {
        setAgent(agentName, chatDraftKeepsModel ? { keepModel: true } : undefined);
      }

      try {
        await updateDesktopSettings({ defaultAgent: newValue ?? '' });
      } catch (error) {
        console.warn('Failed to save default agent:', error);
      }
    },
    [chatDraftKeepsAgent, chatDraftKeepsModel, chatHasOwnAgent, setAgent, setSettingsDefaultAgent]
  );

  const handleChatsModelChange = React.useCallback(
    async (providerId: string, modelId: string) => {
      const newValue = providerId && modelId ? `${providerId}/${modelId}` : undefined;
      setChatsModel(newValue);
      setChatsVariant(undefined);
      setChatsDefaultVariant(undefined);
      setChatsDefaultModel(newValue);
      try {
        await updateDesktopSettings({ chatsDefaultModel: newValue ?? '', chatsDefaultVariant: '' });
      } catch (error) {
        console.warn('Failed to save chats default model:', error);
      }
    },
    [setChatsDefaultModel, setChatsDefaultVariant]
  );

  const handleChatsVariantChange = React.useCallback(
    async (newValue: string | undefined) => {
      setChatsVariant(newValue);
      setChatsDefaultVariant(newValue);
      try {
        await updateDesktopSettings({ chatsDefaultVariant: newValue ?? '' });
      } catch (error) {
        console.warn('Failed to save chats default variant:', error);
      }
    },
    [setChatsDefaultVariant]
  );

  const handleChatsAgentChange = React.useCallback(
    async (agentName: string) => {
      const newValue = agentName || undefined;
      setChatsAgent(newValue);
      setChatsDefaultAgent(newValue);
      try {
        await updateDesktopSettings({ chatsDefaultAgent: newValue ?? '' });
      } catch (error) {
        console.warn('Failed to save chats default agent:', error);
      }
    },
    [setChatsDefaultAgent]
  );

  const handleSmallModelUseDefaultChange = React.useCallback(
    async (useDefault: boolean) => {
      setSmallModelUseDefault(useDefault);
      try {
        await updateDesktopSettings({ smallModelUseDefault: useDefault });
      } catch (error) {
        console.warn('Failed to save small model preference:', error);
      }
    },
    []
  );

  const handleSmallModelOverrideChange = React.useCallback(
    async (providerId: string, modelId: string) => {
      const newValue = providerId && modelId ? `${providerId}/${modelId}` : undefined;
      setSmallModelOverride(newValue);
      setSmallModelVariant(undefined);
      try {
        await updateDesktopSettings({
          smallModelOverride: newValue ?? '',
          smallModelVariant: '',
        });
      } catch (error) {
        console.warn('Failed to save small model override:', error);
      }
    },
    []
  );

  const handleSmallModelVariantChange = React.useCallback(
    async (variant: string | undefined) => {
      setSmallModelVariant(variant);
      try {
        await updateDesktopSettings({ smallModelVariant: variant ?? '' });
      } catch (error) {
        console.warn('Failed to save small model variant:', error);
      }
    },
    []
  );

  const handleWalkthroughModelOverrideChange = React.useCallback(
    async (providerId: string, modelId: string) => {
      const newValue = providerId && modelId ? `${providerId}/${modelId}` : undefined;
      setWalkthroughModelOverride(newValue);
      setWalkthroughModelVariant(undefined);
      try {
        await updateDesktopSettings({ walkthroughModelOverride: newValue ?? '', walkthroughModelVariant: '' });
      } catch (error) {
        console.warn('Failed to save walkthrough model override:', error);
      }
    },
    []
  );

  const handleWalkthroughModelVariantChange = React.useCallback(
    async (variant: string | undefined) => {
      setWalkthroughModelVariant(variant);
      try {
        await updateDesktopSettings({ walkthroughModelVariant: variant ?? '' });
      } catch (error) {
        console.warn('Failed to save walkthrough model variant:', error);
      }
    },
    []
  );

  const handleFallbackModelChange = React.useCallback(
    async (providerId: string, modelId: string) => {
      const newValue = providerId && modelId ? `${providerId}/${modelId}` : undefined;
      setFallbackModel(newValue);
      setFallbackVariant(undefined);
      try {
        await updateDesktopSettings({ fallbackModel: newValue ?? '', fallbackVariant: '' });
      } catch (error) {
        console.warn('Failed to save fallback model:', error);
      }
    },
    []
  );

  const handleFallbackVariantChange = React.useCallback(
    async (variant: string | undefined) => {
      setFallbackVariant(variant);
      try {
        await updateDesktopSettings({ fallbackVariant: variant ?? '' });
      } catch (error) {
        console.warn('Failed to save fallback thinking:', error);
      }
    },
    []
  );

  const isStructuredOutputCapable = React.useCallback(
    (providerId: string, modelId: string) =>
      modelsMetadata.get(`${providerId}/${modelId}`)?.structured_output !== false,
    [modelsMetadata]
  );

  const parsedSmallModel = React.useMemo(() => getDisplayModel(smallModelOverride), [smallModelOverride]);
  const parsedWalkthroughModel = React.useMemo(
    () => getDisplayModel(walkthroughModelOverride),
    [walkthroughModelOverride]
  );
  const parsedFallbackModel = React.useMemo(() => getDisplayModel(fallbackModel), [fallbackModel]);
  const variantsOf = React.useCallback((providerId: string, modelId: string) => {
    if (!providerId || !modelId) return [];
    const provider = providers.find((p) => p.id === providerId);
    const model = provider?.models.find((m: Record<string, unknown>) => (m as { id?: string }).id === modelId) as
      | { variants?: ModelVariantSource }
      | undefined;
    return listModelVariantIds(model?.variants);
  }, [providers]);
  const availableVariants = React.useMemo(
    () => variantsOf(parsedModel.providerId, parsedModel.modelId),
    [parsedModel.modelId, parsedModel.providerId, variantsOf]
  );
  const fallbackVariants = React.useMemo(
    () => variantsOf(parsedFallbackModel.providerId, parsedFallbackModel.modelId),
    [parsedFallbackModel.modelId, parsedFallbackModel.providerId, variantsOf]
  );
  const smallModelVariants = React.useMemo(
    () => variantsOf(parsedSmallModel.providerId, parsedSmallModel.modelId),
    [parsedSmallModel.modelId, parsedSmallModel.providerId, variantsOf]
  );
  const walkthroughModelVariants = React.useMemo(
    () => variantsOf(parsedWalkthroughModel.providerId, parsedWalkthroughModel.modelId),
    [parsedWalkthroughModel.modelId, parsedWalkthroughModel.providerId, variantsOf]
  );

  if (isLoading) {
    return null;
  }

  return (
    <>
      <SettingsSection
        title={t('settings.openchamber.defaults.newSessionsTitle')}
      >
        <div>
          <SettingsFieldRow
            settingsItem="sessions.default-model"
            label={t('settings.openchamber.defaults.field.model')}
            description={defaultModelMissing
              ? <span className="text-[var(--status-warning)]">{t('settings.openchamber.defaults.field.modelUnavailable')}</span>
              : undefined}
          >
            <ModelSelector
              providerId={parsedModel.providerId}
              modelId={parsedModel.modelId}
              onChange={handleModelChange}
              className={SETTINGS_CUSTOM_TRIGGER_CLASS}
              offerAuto
            />
            <ModelVariantSelect
              variants={availableVariants}
              value={defaultVariant}
              onChange={handleVariantChange}
              ariaLabel={t('settings.openchamber.defaults.field.defaultThinking')}
            />
          </SettingsFieldRow>

          <SettingsFieldRow
            settingsItem="sessions.default-agent"
            label={t('settings.openchamber.defaults.field.agent')}
          >
            <AgentSelector
              agentName={defaultAgent || ''}
              onChange={handleAgentChange}
              filter={(agent) => isPrimaryMode(agent.mode)}
              className={SETTINGS_CUSTOM_TRIGGER_CLASS}
            />
          </SettingsFieldRow>

          {isVSCode ? null : <PermissionDefaultModeField agentName={defaultAgent} />}
        </div>
      </SettingsSection>

      {isVSCode || !chatsRoot ? null : (
        <SettingsSection
          title={t('settings.openchamber.defaults.chatsTitle')}
          info={t('settings.openchamber.defaults.chatsInfo')}
        >
          <div>
            <SettingsFieldRow
              settingsItem="sessions.chats-default-model"
              label={t('settings.openchamber.defaults.field.model')}
              description={chatsModelNote
                ? <span className="text-[var(--status-warning)]">{t(chatsModelNote)}</span>
                : undefined}
            >
              <ModelSelector
                directory={chatsRoot}
                providerId={parsedChatsModel.providerId}
                modelId={parsedChatsModel.modelId}
                onChange={handleChatsModelChange}
                className={SETTINGS_CUSTOM_TRIGGER_CLASS}
                offerAuto
              />
              <ModelVariantSelect
                variants={chatsVariants}
                value={chatsVariant}
                onChange={handleChatsVariantChange}
                ariaLabel={t('settings.openchamber.defaults.field.defaultThinking')}
              />
            </SettingsFieldRow>

            <SettingsFieldRow
              settingsItem="sessions.chats-default-agent"
              label={t('settings.openchamber.defaults.field.agent')}
            >
              <AgentSelector
                directory={chatsRoot}
                agentName={chatsAgent || ''}
                onChange={handleChatsAgentChange}
                filter={(agent) => isPrimaryMode(agent.mode)}
                className={SETTINGS_CUSTOM_TRIGGER_CLASS}
              />
            </SettingsFieldRow>
          </div>
        </SettingsSection>
      )}

      <SettingsSection title={t('settings.layout.sessions.helperModels.title')} contentClassName="space-y-2">
        <SettingsCheckboxRow
          settingsItem="sessions.small-model"
          checked={smallModelUseDefault}
          onChange={(checked) => {
            void handleSmallModelUseDefaultChange(checked);
          }}
          label={t('settings.openchamber.defaults.smallModel.useDefault')}
          ariaLabel={t('settings.openchamber.defaults.smallModel.useDefaultAria')}
          info={t('settings.openchamber.defaults.smallModel.description')}
        />
        <div>
          {!smallModelUseDefault ? (
            <>
              <SettingsFieldRow label={t('settings.openchamber.defaults.smallModel.title')}>
                <ModelSelector
                  providerId={parsedSmallModel.providerId}
                  modelId={parsedSmallModel.modelId}
                  onChange={handleSmallModelOverrideChange}
                  allowedProviderIds={smallModelProviders}
                  className={SETTINGS_CUSTOM_TRIGGER_CLASS}
                />
                <ModelVariantSelect
                  variants={smallModelVariants}
                  value={smallModelVariant}
                  onChange={handleSmallModelVariantChange}
                  ariaLabel={t('settings.openchamber.defaults.smallModel.thinking')}
                />
              </SettingsFieldRow>
            </>
          ) : null}
          <SettingsFieldRow
            settingsItem="sessions.walkthrough-model"
            label={t('settings.openchamber.defaults.walkthroughModel.title')}
            info={t('settings.openchamber.defaults.walkthroughModel.description')}
          >
            <ModelSelector
              providerId={parsedWalkthroughModel.providerId}
              modelId={parsedWalkthroughModel.modelId}
              onChange={handleWalkthroughModelOverrideChange}
              allowedProviderIds={smallModelProviders}
              isModelAllowed={isStructuredOutputCapable}
              placeholder={t('settings.openchamber.defaults.walkthroughModel.usesSmallModel')}
              className={SETTINGS_CUSTOM_TRIGGER_CLASS}
            />
            <ModelVariantSelect
              variants={walkthroughModelVariants}
              value={walkthroughModelVariant}
              onChange={handleWalkthroughModelVariantChange}
              ariaLabel={t('settings.openchamber.defaults.smallModel.thinking')}
            />
          </SettingsFieldRow>
        </div>
      </SettingsSection>

      {isVSCode ? null : (
        <SettingsSection title={t('settings.openchamber.defaults.usageLimitsTitle')} contentClassName="space-y-1">
          <SettingsFieldRow
            settingsItem="sessions.fallback-model"
            label={t('settings.openchamber.defaults.field.fallbackModel')}
            info={t('settings.openchamber.defaults.field.fallbackModelInfo')}
          >
            <ModelSelector
              providerId={parsedFallbackModel.providerId}
              modelId={parsedFallbackModel.modelId}
              onChange={handleFallbackModelChange}
              allowedProviderIds={smallModelProviders}
              placeholder={t('settings.openchamber.defaults.field.fallbackModelNone')}
              className={SETTINGS_CUSTOM_TRIGGER_CLASS}
            />
            <ModelVariantSelect
              variants={fallbackVariants}
              value={fallbackVariant}
              onChange={handleFallbackVariantChange}
              ariaLabel={t('settings.openchamber.defaults.field.fallbackThinking')}
            />
          </SettingsFieldRow>
          <p className={SETTINGS_HELPER_CLASS}>
            {t('settings.openchamber.defaults.usageLimits.accountSwitching')}
            {' '}
            <SettingsInlineLink onClick={() => requestSettingsJump('providers')}>
              {t('settings.openchamber.defaults.usageLimits.openProviders')}
            </SettingsInlineLink>
          </p>
        </SettingsSection>
      )}
    </>
  );
};

export const SessionContextSettings: React.FC = () => {
  const { t } = useI18n();
  const isVSCode = isVSCodeRuntime();
  return (
    <>
      <CompactionSettings />
      <SettingsSection title={t('settings.openchamber.defaults.promptCacheTitle')}>
        {isVSCode ? <SessionWarmingCheckbox /> : <SessionWarmingModeField />}
      </SettingsSection>
    </>
  );
};
