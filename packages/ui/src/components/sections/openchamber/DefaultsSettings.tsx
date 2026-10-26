import React from 'react';
import { ModelSelector } from '@/components/sections/agents/ModelSelector';
import { AgentSelector } from '@/components/sections/commands/AgentSelector';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  SettingsSection,
  SettingsFieldRow,
  SettingsCheckboxRow,
  SETTINGS_CUSTOM_TRIGGER_CLASS,
  SETTINGS_HELPER_CLASS,
  SETTINGS_SELECT_ROW_TRIGGER_CLASS,
} from '@/components/sections/shared/SettingsSection';
import { SessionWarmingCheckbox } from './SessionWarmingCheckbox';
import { SettingsInlineLink } from '@/components/sections/classification/JevAccessNote';
import { SessionWarmingModeField } from './SessionWarmingModeField';
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

const DEFAULT_VARIANT_VALUE = '__default__';

/**
 * The thinking level beside a model picker, shown only when that model has
 * levels. A saved level also keeps it on screen while the catalog loads, so
 * the choice never looks lost.
 */
const ModelVariantSelect: React.FC<{
  variants: string[];
  value: string | undefined;
  onChange: (variant: string | undefined) => void;
  ariaLabel: string;
}> = ({ variants, value, onChange, ariaLabel }) => {
  const { t } = useI18n();
  if (variants.length === 0 && !value) return null;
  const label = (variant: string) => (variant === DEFAULT_VARIANT_VALUE
    ? t('settings.openchamber.defaults.option.default')
    : variant.charAt(0).toUpperCase() + variant.slice(1));
  return (
    <Select
      value={value ?? DEFAULT_VARIANT_VALUE}
      onValueChange={(next) => onChange(next === DEFAULT_VARIANT_VALUE ? undefined : next || undefined)}
      disabled={variants.length === 0}
    >
      <SelectTrigger className={SETTINGS_SELECT_ROW_TRIGGER_CLASS} aria-label={ariaLabel}>
        <SelectValue placeholder={t('settings.openchamber.defaults.field.thinkingPlaceholder')}>
          {label(value ?? DEFAULT_VARIANT_VALUE)}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={DEFAULT_VARIANT_VALUE}>{label(DEFAULT_VARIANT_VALUE)}</SelectItem>
        {variants.map((variant) => (
          <SelectItem key={variant} value={variant}>{label(variant)}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
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
  const requestSettingsJump = useUIStore((state) => state.requestSettingsJump);
  const providers = useConfigStore((state) => state.providers);
  const modelsMetadata = useConfigStore((state) => state.modelsMetadata);

  const [defaultModel, setDefaultModel] = React.useState<string | undefined>();
  const [defaultVariant, setDefaultVariant] = React.useState<string | undefined>();
  const [defaultAgent, setDefaultAgent] = React.useState<string | undefined>();
  const [smallModelUseDefault, setSmallModelUseDefault] = React.useState(true);
  const [smallModelOverride, setSmallModelOverride] = React.useState<string | undefined>();
  const [smallModelVariant, setSmallModelVariant] = React.useState<string | undefined>();
  // Fail closed: never offer providers whose credentials were not verified.
  const smallModelProviders = useCallableModelProviders() ?? [];
  const [walkthroughModelOverride, setWalkthroughModelOverride] = React.useState<string | undefined>();
  const [walkthroughModelVariant, setWalkthroughModelVariant] = React.useState<string | undefined>();
  const [fallbackModel, setFallbackModel] = React.useState<string | undefined>();
  const [fallbackVariant, setFallbackVariant] = React.useState<string | undefined>();
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

  const handleVariantChange = React.useCallback(
    async (newValue: string | undefined) => {
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
      // The effort belongs to the model it was picked for.
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
      // The thinking level belongs to the model it was picked for.
      setWalkthroughModelVariant(undefined);
      try {
        // Clearing the picker is how the user goes back to the small model, so
        // an empty value is a real choice rather than a no-op.
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

  // Read by the server when a provider's usage limit stops a session; nothing
  // in the client changes until then.
  const handleFallbackModelChange = React.useCallback(
    async (providerId: string, modelId: string) => {
      const newValue = providerId && modelId ? `${providerId}/${modelId}` : undefined;
      setFallbackModel(newValue);
      // Thinking levels belong to a model; another model starts from its default.
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
        divider={false}
      >
        <div>
          <SettingsFieldRow
            settingsItem="sessions.default-model"
            label={t('settings.openchamber.defaults.field.model')}
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

      {/* Models the app runs on its own: summaries, titles, the changes walkthrough. */}
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

      {/* The managed OpenCode plugin does both switches; VS Code runs its own OpenCode without it. */}
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
          {/* Account switching comes first and lives on each provider's page; without this line nobody finds it from here. */}
          <p className={SETTINGS_HELPER_CLASS}>
            {t('settings.openchamber.defaults.usageLimits.accountSwitching')}
            {' '}
            <SettingsInlineLink onClick={() => requestSettingsJump('providers')}>
              {t('settings.openchamber.defaults.usageLimits.openProviders')}
            </SettingsInlineLink>
          </p>
        </SettingsSection>
      )}

      <SettingsSection title={t('settings.openchamber.defaults.promptCacheTitle')}>
        {/* VS Code has no OpenChamber server to warm chosen sessions: OpenCode's switch for all of them only. */}
        {isVSCode ? <SessionWarmingCheckbox /> : <SessionWarmingModeField />}
      </SettingsSection>
    </>
  );
};
