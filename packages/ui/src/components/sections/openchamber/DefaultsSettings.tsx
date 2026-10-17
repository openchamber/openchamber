import React from 'react';
import { ModelSelector } from '@/components/sections/agents/ModelSelector';
import { AgentSelector } from '@/components/sections/commands/AgentSelector';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  SettingsSection,
  SettingsFieldRow,
  SettingsCheckboxRow,
  SETTINGS_CUSTOM_TRIGGER_CLASS,
  SETTINGS_SELECT_ROW_TRIGGER_CLASS,
  SETTINGS_OPTION_STACK_CLASS,
} from '@/components/sections/shared/SettingsSection';
import { SessionWarmingCheckbox } from './SessionWarmingCheckbox';
import { PermissionDefaultModeField } from './PermissionDefaultModeField';
import { isVSCodeRuntime } from '@/lib/desktop';
import { loadDesktopSettings, updateDesktopSettings } from '@/lib/persistence';
import { useConfigStore } from '@/stores/useConfigStore';
import { useUIStore } from '@/stores/useUIStore';
import { useSelectionStore } from '@/sync/selection-store';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useI18n } from '@/lib/i18n';
import { parseModelIdentifier } from '@/lib/modelIdentifier';
import { isAutoModel } from '@/lib/routing/autoModel';
import { useCallableModelProviders } from '@/hooks/useCallableModelProviders';
import { isPrimaryMode } from '@/components/chat/mobileControlsUtils';
import { listModelVariantIds, type ModelVariantSource } from '@/lib/modelVariants';

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
  // A default describes new sessions. Applying it to the open chat is a
  // convenience, not the point, so it stops where the chat carries a choice the
  // user made for it — the same pair of signals ModelControls restores from
  // (`shouldPreserveManualModelOverride`).
  const selectionIsManual = useConfigStore((state) => state.selectionSource === 'manual');
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const getSessionModelSelection = useSelectionStore((state) => state.getSessionModelSelection);
  const getSessionAgentSelection = useSelectionStore((state) => state.getSessionAgentSelection);
  const agentIsPicked = useConfigStore((state) => state.agentSelectionSource === 'manual');
  // An agent picked for this chat brings the model its config pins, and a pin
  // outranks the global default the same way it does in `setAgent`.
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
  const showDeletionDialog = useUIStore((state) => state.showDeletionDialog);
  const setShowDeletionDialog = useUIStore((state) => state.setShowDeletionDialog);
  const providers = useConfigStore((state) => state.providers);
  const modelsMetadata = useConfigStore((state) => state.modelsMetadata);

  const [defaultModel, setDefaultModel] = React.useState<string | undefined>();
  const [defaultVariant, setDefaultVariant] = React.useState<string | undefined>();
  const [defaultAgent, setDefaultAgent] = React.useState<string | undefined>();
  const [smallModelUseDefault, setSmallModelUseDefault] = React.useState(true);
  const [smallModelOverride, setSmallModelOverride] = React.useState<string | undefined>();
  // Fail closed: never offer providers whose credentials were not verified.
  const smallModelProviders = useCallableModelProviders() ?? [];
  const [walkthroughModelOverride, setWalkthroughModelOverride] = React.useState<string | undefined>();
  const [isLoading, setIsLoading] = React.useState(true);

  const parsedModel = React.useMemo(() => getDisplayModel(defaultModel), [defaultModel]);

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
          if (data.smallModelUseDefault !== undefined) setSmallModelUseDefault(data.smallModelUseDefault);
          const smallOverride = data.smallModelOverride?.trim();
          if (smallOverride) {
            setSmallModelOverride(smallOverride);
          }
          const walkthroughOverride = data.walkthroughModelOverride?.trim();
          if (walkthroughOverride) {
            setWalkthroughModelOverride(walkthroughOverride);
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

      if (!chatHasOwnModel) {
        setCurrentVariant(undefined);

        if (providerId && modelId) {
          const provider = providers.find((p) => p.id === providerId);
          // Auto is not a provider OpenCode lists; the picker only offers it while the server can honour it.
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
    [chatHasOwnModel, providers, setCurrentVariant, setModel, setProvider, setSettingsDefaultModel, setSettingsDefaultVariant]
  );

  const DEFAULT_VARIANT_VALUE = '__default__';

  const formatVariantLabel = React.useCallback((variant: string) => {
    if (variant === DEFAULT_VARIANT_VALUE) {
      return t('settings.openchamber.defaults.option.default');
    }
    return variant.charAt(0).toUpperCase() + variant.slice(1);
  }, [t]);

  const handleVariantChange = React.useCallback(
    async (variant: string) => {
      const newValue = variant === DEFAULT_VARIANT_VALUE ? undefined : variant || undefined;
      setDefaultVariant(newValue);
      setSettingsDefaultVariant(newValue);
      if (!chatHasOwnModel) {
        setCurrentVariantOverride(newValue ?? null, newValue);
      }

      try {
        await updateDesktopSettings({ defaultVariant: newValue ?? '' });
      } catch (error) {
        console.warn('Failed to save default variant:', error);
      }
    },
    [chatHasOwnModel, setCurrentVariantOverride, setSettingsDefaultVariant]
  );

  const handleAgentChange = React.useCallback(
    async (agentName: string) => {
      const newValue = agentName || undefined;
      setDefaultAgent(newValue);
      setSettingsDefaultAgent(newValue);

      if (agentName && !chatHasOwnAgent) {
        setAgent(agentName);
      }

      try {
        await updateDesktopSettings({ defaultAgent: newValue ?? '' });
      } catch (error) {
        console.warn('Failed to save default agent:', error);
      }
    },
    [chatHasOwnAgent, setAgent, setSettingsDefaultAgent]
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
      try {
        await updateDesktopSettings({ smallModelOverride: newValue ?? '' });
      } catch (error) {
        console.warn('Failed to save small model override:', error);
      }
    },
    []
  );

  const handleWalkthroughModelOverrideChange = React.useCallback(
    async (providerId: string, modelId: string) => {
      const newValue = providerId && modelId ? `${providerId}/${modelId}` : undefined;
      setWalkthroughModelOverride(newValue);
      try {
        // Clearing the picker is how the user goes back to the small model, so
        // an empty value is a real choice rather than a no-op.
        await updateDesktopSettings({ walkthroughModelOverride: newValue ?? '' });
      } catch (error) {
        console.warn('Failed to save walkthrough model override:', error);
      }
    },
    []
  );

  // The walkthrough cannot work at all without schema-shaped output, so models
  // the catalog says cannot do it are hidden rather than offered and then
  // refused. A missing capability is not a "no": roughly half the catalog omits
  // the field, and those models usually work.
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
  const availableVariants = React.useMemo(() => {
    if (!parsedModel.providerId || !parsedModel.modelId) return [];
    const provider = providers.find((p) => p.id === parsedModel.providerId);
    const model = provider?.models.find((m: Record<string, unknown>) => (m as { id?: string }).id === parsedModel.modelId) as
      | { variants?: ModelVariantSource }
      | undefined;
    return listModelVariantIds(model?.variants);
  }, [parsedModel.modelId, parsedModel.providerId, providers]);

  const supportsVariants = availableVariants.length > 0;

  if (isLoading) {
    return null;
  }

  return (
    <>
      <SettingsSection
        title={t('settings.openchamber.defaults.title')}
        description={(
          <>
            {t('settings.openchamber.defaults.summaryPrefix')}
            {' '}
            <span className="text-foreground">
              {parsedModel.providerId
                ? `${parsedModel.providerId}/${parsedModel.modelId}${supportsVariants ? ` (${defaultVariant ?? t('settings.openchamber.defaults.option.defaultLowercase')})` : ''}`
                : t('settings.openchamber.defaults.summaryOpenCodeDefault')}
            </span>
            {defaultAgent ? (
              <>
                {' / '}
                <span className="text-foreground">{defaultAgent}</span>
              </>
            ) : null}
          </>
        )}
        divider={false}
        contentClassName="space-y-4"
      >
        <div>
          <SettingsFieldRow
            settingsItem="sessions.default-model"
            label={t('settings.openchamber.defaults.field.defaultModel')}
          >
            <ModelSelector
              providerId={parsedModel.providerId}
              modelId={parsedModel.modelId}
              onChange={handleModelChange}
              className={SETTINGS_CUSTOM_TRIGGER_CLASS}
              offerAuto
            />
          </SettingsFieldRow>

          <SettingsFieldRow
            settingsItem="sessions.default-thinking"
            label={t('settings.openchamber.defaults.field.defaultThinking')}
          >
            <Select value={defaultVariant ?? DEFAULT_VARIANT_VALUE} onValueChange={handleVariantChange} disabled={!supportsVariants}>
              <SelectTrigger className={SETTINGS_SELECT_ROW_TRIGGER_CLASS}>
                <SelectValue placeholder={t('settings.openchamber.defaults.field.thinkingPlaceholder')}>
                  {formatVariantLabel(defaultVariant ?? DEFAULT_VARIANT_VALUE)}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={DEFAULT_VARIANT_VALUE}>{t('settings.openchamber.defaults.option.default')}</SelectItem>
                {availableVariants.map((variant) => (
                  <SelectItem key={variant} value={variant}>
                    {formatVariantLabel(variant)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingsFieldRow>

          <SettingsFieldRow
            settingsItem="sessions.default-agent"
            label={t('settings.openchamber.defaults.field.defaultAgent')}
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

        <div className={SETTINGS_OPTION_STACK_CLASS}>
          <SettingsCheckboxRow
            settingsItem="sessions.deletion-dialog"
            checked={showDeletionDialog}
            onChange={setShowDeletionDialog}
            label={t('settings.openchamber.defaults.field.showDeletionDialog')}
            ariaLabel={t('settings.openchamber.defaults.field.showDeletionDialogAria')}
          />
          <SessionWarmingCheckbox />
        </div>
      </SettingsSection>

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
            <SettingsFieldRow label={t('settings.openchamber.defaults.smallModel.title')}>
              <ModelSelector
                providerId={parsedSmallModel.providerId}
                modelId={parsedSmallModel.modelId}
                onChange={handleSmallModelOverrideChange}
                allowedProviderIds={smallModelProviders}
                className={SETTINGS_CUSTOM_TRIGGER_CLASS}
              />
            </SettingsFieldRow>
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
          </SettingsFieldRow>
        </div>
      </SettingsSection>
    </>
  );
};
