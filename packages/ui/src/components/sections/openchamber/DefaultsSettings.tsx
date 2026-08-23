import React from 'react';
import { ModelSelector } from '@/components/sections/agents/ModelSelector';
import { AgentSelector } from '@/components/sections/commands/AgentSelector';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  SettingsSection,
  SettingsFieldRow,
  SettingsCheckboxRow,
  SettingsInset,
  SettingsGroupTitle,
  SETTINGS_CUSTOM_TRIGGER_CLASS,
  SETTINGS_SELECT_ROW_TRIGGER_CLASS,
  SETTINGS_SELECT_SIZE,
  SETTINGS_OPTION_STACK_CLASS,
} from '@/components/sections/shared/SettingsSection';
import { SettingsInfoHint } from '@/components/sections/shared/SettingsInfoHint';
import { updateDesktopSettings } from '@/lib/persistence';
import { useConfigStore } from '@/stores/useConfigStore';
import { useUIStore } from '@/stores/useUIStore';
import { useSelectionStore } from '@/sync/selection-store';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { useI18n } from '@/lib/i18n';
import { parseModelIdentifier } from '@/lib/modelIdentifier';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { isPrimaryMode } from '@/components/chat/mobileControlsUtils';

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
  const chatHasOwnModel = Boolean(
    selectionIsManual && currentSessionId && getSessionModelSelection(currentSessionId),
  );
  const chatHasOwnAgent = Boolean(
    selectionIsManual && currentSessionId && getSessionAgentSelection(currentSessionId),
  );
  const showDeletionDialog = useUIStore((state) => state.showDeletionDialog);
  const setShowDeletionDialog = useUIStore((state) => state.setShowDeletionDialog);
  const providers = useConfigStore((state) => state.providers);
  const modelsMetadata = useConfigStore((state) => state.modelsMetadata);

  const [defaultModel, setDefaultModel] = React.useState<string | undefined>();
  const [defaultVariant, setDefaultVariant] = React.useState<string | undefined>();
  const [defaultAgent, setDefaultAgent] = React.useState<string | undefined>();
  const [smallModelUseDefault, setSmallModelUseDefault] = React.useState(true);
  const [smallModelOverride, setSmallModelOverride] = React.useState<string | undefined>();
  const [smallModelProviders, setSmallModelProviders] = React.useState<string[]>([]);
  const [walkthroughModelOverride, setWalkthroughModelOverride] = React.useState<string | undefined>();
  const [isLoading, setIsLoading] = React.useState(true);

  const parsedModel = React.useMemo(() => getDisplayModel(defaultModel), [defaultModel]);

  React.useEffect(() => {
    const loadSettings = async () => {
      try {
        let data: {
          defaultModel?: string;
          defaultVariant?: string;
          defaultAgent?: string;
          smallModelUseDefault?: boolean;
          smallModelOverride?: string;
          walkthroughModelOverride?: string;
        } | null = null;

        if (!data) {
          const runtimeSettings = getRegisteredRuntimeAPIs()?.settings;
          if (runtimeSettings) {
            try {
              const result = await runtimeSettings.load();
              const settings = result?.settings;
              if (settings) {
                const raw = settings as Record<string, unknown>;
                data = {
                  defaultModel: typeof settings.defaultModel === 'string' ? settings.defaultModel : undefined,
                  defaultVariant:
                    typeof raw.defaultVariant === 'string'
                      ? (raw.defaultVariant as string)
                      : undefined,
                  defaultAgent: typeof settings.defaultAgent === 'string' ? settings.defaultAgent : undefined,
                  smallModelUseDefault: typeof raw.smallModelUseDefault === 'boolean' ? raw.smallModelUseDefault : undefined,
                  smallModelOverride: typeof raw.smallModelOverride === 'string' ? raw.smallModelOverride : undefined,
                  walkthroughModelOverride:
                    typeof raw.walkthroughModelOverride === 'string' ? raw.walkthroughModelOverride : undefined,
                };
              }
            } catch {
              // fall through
            }
          }
        }

        if (!data) {
          const response = await runtimeFetch('/api/config/settings', {
            method: 'GET',
            headers: { Accept: 'application/json' },
          });
          if (response.ok) {
            data = await response.json();
          }
        }

        if (data) {
          const model =
            typeof data.defaultModel === 'string' && data.defaultModel.trim().length > 0
              ? data.defaultModel.trim()
              : undefined;
          const variant =
            typeof data.defaultVariant === 'string' && data.defaultVariant.trim().length > 0
              ? data.defaultVariant.trim()
              : undefined;
          const agent =
            typeof data.defaultAgent === 'string' && data.defaultAgent.trim().length > 0
              ? data.defaultAgent.trim()
              : undefined;

          if (model !== undefined) setDefaultModel(model);
          if (variant !== undefined) setDefaultVariant(variant);
          if (agent !== undefined) setDefaultAgent(agent);
          if (typeof data.smallModelUseDefault === 'boolean') setSmallModelUseDefault(data.smallModelUseDefault);
          if (typeof data.smallModelOverride === 'string' && data.smallModelOverride.trim()) {
            setSmallModelOverride(data.smallModelOverride.trim());
          }
          if (typeof data.walkthroughModelOverride === 'string' && data.walkthroughModelOverride.trim()) {
            setWalkthroughModelOverride(data.walkthroughModelOverride.trim());
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
          if (provider) {
            setProvider(providerId);
            setModel(modelId);
          }
        }
      }

      try {
        await updateDesktopSettings({ defaultModel: newValue ?? '', defaultVariant: '' });
        const response = await runtimeFetch('/api/config/settings', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ defaultModel: newValue }),
        });
        if (!response.ok) {
          console.warn('Failed to save default model to server:', response.status, response.statusText);
        }
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
        setCurrentVariant(newValue);
      }

      try {
        await updateDesktopSettings({ defaultVariant: newValue ?? '' });
      } catch (error) {
        console.warn('Failed to save default variant:', error);
      }
    },
    [chatHasOwnModel, setCurrentVariant, setSettingsDefaultVariant]
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
  React.useEffect(() => {
    // Both pickers offer the same providers — the walkthrough runs through the
    // small model — and the walkthrough picker is always visible, so this is
    // always worth fetching. The server answers with the providers it has a
    // credential and an endpoint for, including plugin-registered ones that
    // exist only inside the running OpenCode.
    let cancelled = false;
    (async () => {
      try {
        const response = await runtimeFetch('/api/small-model', { method: 'GET', headers: { Accept: 'application/json' } });
        if (!response.ok) return;
        const payload = await response.json().catch(() => null) as { authenticatedProviders?: unknown } | null;
        if (!cancelled && Array.isArray(payload?.authenticatedProviders)) {
          setSmallModelProviders(payload.authenticatedProviders.filter((id): id is string => typeof id === 'string'));
        }
      } catch {
        // Fail closed: never offer providers whose credentials were not verified.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const availableVariants = React.useMemo(() => {
    if (!parsedModel.providerId || !parsedModel.modelId) return [];
    const provider = providers.find((p) => p.id === parsedModel.providerId);
    const model = provider?.models.find((m: Record<string, unknown>) => (m as { id?: string }).id === parsedModel.modelId) as
      | { variants?: Record<string, unknown> }
      | undefined;
    const variants = model?.variants;
    if (!variants) return [];
    return Object.keys(variants);
  }, [parsedModel.modelId, parsedModel.providerId, providers]);

  const supportsVariants = availableVariants.length > 0;

  React.useEffect(() => {
    if (!supportsVariants && defaultVariant) {
      setDefaultVariant(undefined);
      setSettingsDefaultVariant(undefined);
      if (!chatHasOwnModel) {
        setCurrentVariant(undefined);
      }
      updateDesktopSettings({ defaultVariant: '' }).catch(() => {
        // best effort
      });
    }
  }, [chatHasOwnModel, defaultVariant, setCurrentVariant, setSettingsDefaultVariant, supportsVariants]);

  if (isLoading) {
    return null;
  }

  return (
    <>
      <SettingsSection title={t('settings.openchamber.defaults.title')} divider={false}>
        <div className="space-y-0">
          <div className="mt-0 mb-1 typography-meta text-muted-foreground">
            {t('settings.openchamber.defaults.summaryPrefix')}
            {' '}
            {parsedModel.providerId ? (
              <span className="text-foreground">
                {parsedModel.providerId}/{parsedModel.modelId}
                {supportsVariants ? ` (${defaultVariant ?? t('settings.openchamber.defaults.option.defaultLowercase')})` : ''}
              </span>
            ) : (
              <span className="text-foreground">{t('settings.openchamber.defaults.summaryOpenCodeDefault')}</span>
            )}
            {defaultAgent && (
              <>
                {' / '}
                <span className="text-foreground">{defaultAgent}</span>
              </>
            )}
          </div>

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
              />
            </SettingsFieldRow>

            <SettingsFieldRow
              settingsItem="sessions.default-thinking"
              label={t('settings.openchamber.defaults.field.defaultThinking')}
            >
              <Select value={defaultVariant ?? DEFAULT_VARIANT_VALUE} onValueChange={handleVariantChange} disabled={!supportsVariants}>
                <SelectTrigger size={SETTINGS_SELECT_SIZE} className={SETTINGS_SELECT_ROW_TRIGGER_CLASS}>
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
          </div>

          <SettingsInset className={SETTINGS_OPTION_STACK_CLASS}>
            <SettingsCheckboxRow
              settingsItem="sessions.deletion-dialog"
              checked={showDeletionDialog}
              onChange={setShowDeletionDialog}
              label={t('settings.openchamber.defaults.field.showDeletionDialog')}
              ariaLabel={t('settings.openchamber.defaults.field.showDeletionDialogAria')}
            />
          </SettingsInset>

          <div className="space-y-3 pt-6">
            <div className="flex items-center gap-1.5">
              <SettingsGroupTitle>
                {t('settings.openchamber.defaults.smallModel.title')}
              </SettingsGroupTitle>
              <SettingsInfoHint>
                {t('settings.openchamber.defaults.smallModel.description')}
              </SettingsInfoHint>
            </div>

            <SettingsCheckboxRow
              settingsItem="sessions.small-model"
              checked={smallModelUseDefault}
              onChange={(checked) => {
                void handleSmallModelUseDefaultChange(checked);
              }}
              label={t('settings.openchamber.defaults.smallModel.useDefault')}
              ariaLabel={t('settings.openchamber.defaults.smallModel.useDefaultAria')}
            />

            {!smallModelUseDefault ? (
              <SettingsFieldRow label={t('settings.openchamber.defaults.smallModel.overrideModel')}>
                <ModelSelector
                  providerId={parsedSmallModel.providerId}
                  modelId={parsedSmallModel.modelId}
                  onChange={handleSmallModelOverrideChange}
                  allowedProviderIds={smallModelProviders}
                  className={SETTINGS_CUSTOM_TRIGGER_CLASS}
                />
              </SettingsFieldRow>
            ) : null}

            <SettingsInset className={SETTINGS_OPTION_STACK_CLASS}>
              <div className="flex items-center gap-1.5">
                <SettingsGroupTitle>
                  {t('settings.openchamber.defaults.walkthroughModel.title')}
                </SettingsGroupTitle>
                <SettingsInfoHint>
                  {t('settings.openchamber.defaults.walkthroughModel.description')}
                </SettingsInfoHint>
              </div>

              <SettingsFieldRow
                settingsItem="sessions.walkthrough-model"
                label={t('settings.openchamber.defaults.walkthroughModel.overrideModel')}
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
            </SettingsInset>
          </div>
        </div>
      </SettingsSection>
    </>
  );
};
