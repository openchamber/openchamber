import React from 'react';
import { ModelSelector } from '@/components/sections/agents/ModelSelector';
import { AgentSelector } from '@/components/sections/commands/AgentSelector';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { SettingsSection, SETTINGS_SELECT_TRIGGER_CLASS } from '@/components/sections/shared/SettingsSection';
import { updateDesktopSettings } from '@/lib/persistence';
import { useConfigStore } from '@/stores/useConfigStore';
import { useUIStore } from '@/stores/useUIStore';
import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { parseModelIdentifier } from '@/lib/modelIdentifier';
import { runtimeFetch } from '@/lib/runtime-fetch';

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
  const showDeletionDialog = useUIStore((state) => state.showDeletionDialog);
  const setShowDeletionDialog = useUIStore((state) => state.setShowDeletionDialog);
  const providers = useConfigStore((state) => state.providers);

  const [defaultModel, setDefaultModel] = React.useState<string | undefined>();
  const [defaultVariant, setDefaultVariant] = React.useState<string | undefined>();
  const [defaultAgent, setDefaultAgent] = React.useState<string | undefined>();
  const [smallModelUseDefault, setSmallModelUseDefault] = React.useState(true);
  const [smallModelOverride, setSmallModelOverride] = React.useState<string | undefined>();
  const [smallModelProviders, setSmallModelProviders] = React.useState<string[] | undefined>();
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
      setCurrentVariant(undefined);
      setSettingsDefaultModel(newValue);

      if (providerId && modelId) {
        const provider = providers.find((p) => p.id === providerId);
        if (provider) {
          setProvider(providerId);
          setModel(modelId);
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
    [providers, setCurrentVariant, setModel, setProvider, setSettingsDefaultModel, setSettingsDefaultVariant]
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
      setCurrentVariant(newValue);

      try {
        await updateDesktopSettings({ defaultVariant: newValue ?? '' });
      } catch (error) {
        console.warn('Failed to save default variant:', error);
      }
    },
    [setCurrentVariant, setSettingsDefaultVariant]
  );

  const handleAgentChange = React.useCallback(
    async (agentName: string) => {
      const newValue = agentName || undefined;
      setDefaultAgent(newValue);
      setSettingsDefaultAgent(newValue);

      if (agentName) {
        setAgent(agentName);
      }

      try {
        await updateDesktopSettings({ defaultAgent: newValue ?? '' });
      } catch (error) {
        console.warn('Failed to save default agent:', error);
      }
    },
    [setAgent, setSettingsDefaultAgent]
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

  const parsedSmallModel = React.useMemo(() => getDisplayModel(smallModelOverride), [smallModelOverride]);

  React.useEffect(() => {
    if (smallModelUseDefault || smallModelProviders !== undefined) return;
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
        // leave undefined — picker falls back to showing all providers
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [smallModelUseDefault, smallModelProviders]);

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
      setCurrentVariant(undefined);
      updateDesktopSettings({ defaultVariant: '' }).catch(() => {
        // best effort
      });
    }
  }, [defaultVariant, setCurrentVariant, setSettingsDefaultVariant, supportsVariants]);

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

          <div data-settings-item="sessions.default-model" className={cn('flex flex-col gap-2 py-1 sm:flex-row sm:items-center sm:gap-8')}>
            <div className="flex min-w-0 flex-col sm:w-56 shrink-0">
              <span className="typography-ui-label text-foreground">{t('settings.openchamber.defaults.field.defaultModel')}</span>
            </div>
            <div className="flex min-w-0 flex-1 items-center gap-2 sm:w-fit sm:flex-initial">
              <ModelSelector providerId={parsedModel.providerId} modelId={parsedModel.modelId} onChange={handleModelChange} />
            </div>
          </div>

          <div data-settings-item="sessions.default-thinking" className="flex flex-col gap-2 py-1 sm:flex-row sm:items-center sm:gap-8">
            <div className="flex min-w-0 flex-col sm:w-56 shrink-0">
              <span className="typography-ui-label text-foreground">{t('settings.openchamber.defaults.field.defaultThinking')}</span>
            </div>
            <div className="flex items-center gap-2 sm:w-fit">
              <Select value={defaultVariant ?? DEFAULT_VARIANT_VALUE} onValueChange={handleVariantChange} disabled={!supportsVariants}>
                <SelectTrigger className={SETTINGS_SELECT_TRIGGER_CLASS}>
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
            </div>
          </div>

          <div data-settings-item="sessions.default-agent" className="flex flex-col gap-2 py-1 sm:flex-row sm:items-center sm:gap-8">
            <div className="flex min-w-0 flex-col sm:w-56 shrink-0">
              <span className="typography-ui-label text-foreground">{t('settings.openchamber.defaults.field.defaultAgent')}</span>
            </div>
            <div className="flex min-w-0 flex-1 items-center gap-2 sm:w-fit sm:flex-initial">
              <AgentSelector agentName={defaultAgent || ''} onChange={handleAgentChange} />
            </div>
          </div>

          <div
            data-settings-item="sessions.deletion-dialog"
            className="group flex cursor-pointer items-center gap-2 py-1"
            role="button"
            tabIndex={0}
            aria-pressed={showDeletionDialog}
            onClick={() => setShowDeletionDialog(!showDeletionDialog)}
            onKeyDown={(event) => {
              if (event.key === ' ' || event.key === 'Enter') {
                event.preventDefault();
                setShowDeletionDialog(!showDeletionDialog);
              }
            }}
          >
            <Checkbox checked={showDeletionDialog} onChange={setShowDeletionDialog} ariaLabel={t('settings.openchamber.defaults.field.showDeletionDialogAria')} />
            <span className="typography-ui-label text-foreground">{t('settings.openchamber.defaults.field.showDeletionDialog')}</span>
          </div>
        </div>
      </SettingsSection>

      <SettingsSection
        title={t('settings.openchamber.defaults.smallModel.title')}
        description={t('settings.openchamber.defaults.smallModel.description')}
      >
        <div className="space-y-0">
          <div
            data-settings-item="sessions.small-model"
            className="group flex cursor-pointer items-center gap-2 py-1"
            role="button"
            tabIndex={0}
            aria-pressed={smallModelUseDefault}
            onClick={() => void handleSmallModelUseDefaultChange(!smallModelUseDefault)}
            onKeyDown={(event) => {
              if (event.key === ' ' || event.key === 'Enter') {
                event.preventDefault();
                void handleSmallModelUseDefaultChange(!smallModelUseDefault);
              }
            }}
          >
            <Checkbox
              checked={smallModelUseDefault}
              onChange={(checked) => void handleSmallModelUseDefaultChange(checked)}
              ariaLabel={t('settings.openchamber.defaults.smallModel.useDefaultAria')}
            />
            <span className="typography-ui-label text-foreground">{t('settings.openchamber.defaults.smallModel.useDefault')}</span>
          </div>

          {!smallModelUseDefault ? (
            <div className="flex flex-col gap-2 py-1 sm:flex-row sm:items-center sm:gap-8">
              <div className="flex min-w-0 flex-col sm:w-56 shrink-0">
                <span className="typography-ui-label text-foreground">{t('settings.openchamber.defaults.smallModel.overrideModel')}</span>
              </div>
              <div className="flex min-w-0 flex-1 items-center gap-2 sm:w-fit sm:flex-initial">
                <ModelSelector
                  providerId={parsedSmallModel.providerId}
                  modelId={parsedSmallModel.modelId}
                  onChange={handleSmallModelOverrideChange}
                  allowedProviderIds={smallModelProviders}
                />
              </div>
            </div>
          ) : null}
        </div>
      </SettingsSection>
    </>
  );
};
