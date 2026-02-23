import React from 'react';
import { RiInformationLine } from '@remixicon/react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ModelSelector } from '@/components/sections/agents/ModelSelector';
import { AgentSelector } from '@/components/sections/commands/AgentSelector';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { updateDesktopSettings } from '@/lib/persistence';
import { isVSCodeRuntime } from '@/lib/desktop';
import { useConfigStore } from '@/stores/useConfigStore';
import { useUIStore } from '@/stores/useUIStore';
import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { getModifierLabel, cn } from '@/lib/utils';

interface ZenModel {
  id: string;
  owned_by?: string;
}

const FALLBACK_PROVIDER_ID = 'opencode';
const FALLBACK_MODEL_ID = 'big-pickle';

const getDisplayModel = (
  storedModel: string | undefined,
  providers: Array<{ id: string; models: Array<{ id: string }> }>
): { providerId: string; modelId: string } => {
  if (storedModel) {
    const parts = storedModel.split('/');
    if (parts.length === 2 && parts[0] && parts[1]) {
      return { providerId: parts[0], modelId: parts[1] };
    }
  }
  
  const fallbackProvider = providers.find(p => p.id === FALLBACK_PROVIDER_ID);
  if (fallbackProvider?.models.some(m => m.id === FALLBACK_MODEL_ID)) {
    return { providerId: FALLBACK_PROVIDER_ID, modelId: FALLBACK_MODEL_ID };
  }
  
  const firstProvider = providers[0];
  if (firstProvider?.models[0]) {
    return { providerId: firstProvider.id, modelId: firstProvider.models[0].id };
  }
  
  return { providerId: '', modelId: '' };
};

export const DefaultsSettings: React.FC = () => {
  const setProvider = useConfigStore((state) => state.setProvider);
  const setModel = useConfigStore((state) => state.setModel);
  const setAgent = useConfigStore((state) => state.setAgent);
  const setCurrentVariant = useConfigStore((state) => state.setCurrentVariant);
  const setSettingsDefaultModel = useConfigStore((state) => state.setSettingsDefaultModel);
  const setSettingsDefaultVariant = useConfigStore((state) => state.setSettingsDefaultVariant);
  const setSettingsDefaultAgent = useConfigStore((state) => state.setSettingsDefaultAgent);
  const settingsAutoCreateWorktree = useConfigStore((state) => state.settingsAutoCreateWorktree);
  const setSettingsAutoCreateWorktree = useConfigStore((state) => state.setSettingsAutoCreateWorktree);
  const settingsZenModel = useConfigStore((state) => state.settingsZenModel);
  const setSettingsZenModel = useConfigStore((state) => state.setSettingsZenModel);
  const showDeletionDialog = useUIStore((state) => state.showDeletionDialog);
  const setShowDeletionDialog = useUIStore((state) => state.setShowDeletionDialog);
  const providers = useConfigStore((state) => state.providers);

  const [defaultModel, setDefaultModel] = React.useState<string | undefined>();
  const [defaultVariant, setDefaultVariant] = React.useState<string | undefined>();
  const [defaultAgent, setDefaultAgent] = React.useState<string | undefined>();
  const [isLoading, setIsLoading] = React.useState(true);
  const [zenModels, setZenModels] = React.useState<ZenModel[]>([]);
  const [zenModelsLoading, setZenModelsLoading] = React.useState(true);

  const parsedModel = React.useMemo(() => {
    return getDisplayModel(defaultModel, providers);
  }, [defaultModel, providers]);

  const isVSCode = React.useMemo(() => isVSCodeRuntime(), []);

  // Load zen models list
  React.useEffect(() => {
    const loadZenModels = async () => {
      try {
        const response = await fetch('/api/zen/models', {
          method: 'GET',
          headers: { Accept: 'application/json' },
        });
        if (response.ok) {
          const data = await response.json() as { models?: ZenModel[] };
          if (Array.isArray(data?.models)) {
            setZenModels(data.models);
          }
        }
      } catch (error) {
        console.warn('Failed to load zen models:', error);
      } finally {
        setZenModelsLoading(false);
      }
    };
    loadZenModels();
  }, []);

  // Resolve which zen model to display as selected
  const selectedZenModel = React.useMemo(() => {
    if (settingsZenModel && zenModels.some((m) => m.id === settingsZenModel)) {
      return settingsZenModel;
    }
    // Default to first free model in the list
    return zenModels[0]?.id ?? '';
  }, [settingsZenModel, zenModels]);

  // Load current settings
  React.useEffect(() => {
    const loadSettings = async () => {
      try {
        let data: { defaultModel?: string; defaultVariant?: string; defaultAgent?: string; zenModel?: string } | null = null;

        // 1. Runtime settings API (VSCode)
        if (!data) {
          const runtimeSettings = getRegisteredRuntimeAPIs()?.settings;
          if (runtimeSettings) {
            try {
              const result = await runtimeSettings.load();
              const settings = result?.settings;
              if (settings) {
                data = {
                  defaultModel: typeof settings.defaultModel === 'string' ? settings.defaultModel : undefined,
                  defaultVariant: typeof (settings as Record<string, unknown>).defaultVariant === 'string' ? ((settings as Record<string, unknown>).defaultVariant as string) : undefined,
                  defaultAgent: typeof settings.defaultAgent === 'string' ? settings.defaultAgent : undefined,
                  zenModel: typeof (settings as Record<string, unknown>).zenModel === 'string' ? ((settings as Record<string, unknown>).zenModel as string) : undefined,
                };
              }
            } catch {
              // fall through
            }
          }
        }

        // 2. Fetch API (Web/server)
        if (!data) {
          const response = await fetch('/api/config/settings', {
            method: 'GET',
            headers: { Accept: 'application/json' },
          });
          if (response.ok) {
            data = await response.json();
          }
        }

         if (data) {
           const model = typeof data.defaultModel === 'string' && data.defaultModel.trim().length > 0 ? data.defaultModel.trim() : undefined;
           const variant = typeof data.defaultVariant === 'string' && data.defaultVariant.trim().length > 0 ? data.defaultVariant.trim() : undefined;
           const agent = typeof data.defaultAgent === 'string' && data.defaultAgent.trim().length > 0 ? data.defaultAgent.trim() : undefined;
           const zen = typeof data.zenModel === 'string' && data.zenModel.trim().length > 0 ? data.zenModel.trim() : undefined;

           if (model !== undefined) {
             setDefaultModel(model);
           }
           if (variant !== undefined) {
             setDefaultVariant(variant);
           }
           if (agent !== undefined) {
             setDefaultAgent(agent);
           }
           if (zen !== undefined) {
             setSettingsZenModel(zen);
           }
         }
      } catch (error) {
        console.warn('Failed to load defaults settings:', error);
      } finally {
        setIsLoading(false);
      }
    };
    loadSettings();
  }, [setSettingsZenModel]);


  const handleModelChange = React.useCallback(async (providerId: string, modelId: string) => {
    const newValue = providerId && modelId ? `${providerId}/${modelId}` : undefined;
    setDefaultModel(newValue);

    // Reset variant when model changes (model-specific)
    setDefaultVariant(undefined);
    setSettingsDefaultVariant(undefined);
    setCurrentVariant(undefined);

    // Update config store settings default (used by setAgent logic)
    setSettingsDefaultModel(newValue);

    // Also update current model immediately so new sessions use this model
    if (providerId && modelId) {
      const provider = providers.find((p) => p.id === providerId);
      if (provider) {
        setProvider(providerId);
        setModel(modelId);
      }
    }

     try {
       await updateDesktopSettings({
         defaultModel: newValue ?? '',
         defaultVariant: '',
       });

        {
          const response = await fetch('/api/config/settings', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ defaultModel: newValue }),
          });
         if (!response.ok) {
           console.warn('Failed to save default model to server:', response.status, response.statusText);
         }
       }
     } catch (error) {
       console.warn('Failed to save default model:', error);
     }
  }, [providers, setCurrentVariant, setProvider, setModel, setSettingsDefaultModel, setSettingsDefaultVariant]);

  const DEFAULT_VARIANT_VALUE = '__default__';

  const handleVariantChange = React.useCallback(async (variant: string) => {
    const newValue = variant === DEFAULT_VARIANT_VALUE ? undefined : (variant || undefined);
    setDefaultVariant(newValue);
    setSettingsDefaultVariant(newValue);
    setCurrentVariant(newValue);

    try {
      await updateDesktopSettings({
        defaultVariant: newValue ?? '',
      });
    } catch (error) {
      console.warn('Failed to save default variant:', error);
    }
  }, [setCurrentVariant, setSettingsDefaultVariant]);

  const handleAgentChange = React.useCallback(async (agentName: string) => {
    const newValue = agentName || undefined;
    setDefaultAgent(newValue);

    // Update config store settings default
    setSettingsDefaultAgent(newValue);

    // Update current agent (setAgent will respect settingsDefaultModel)
    if (agentName) {
      setAgent(agentName);
    }

    try {
      await updateDesktopSettings({
        defaultAgent: newValue ?? '',
      });
    } catch (error) {
      console.warn('Failed to save default agent:', error);
    }
  }, [setAgent, setSettingsDefaultAgent]);

  const availableVariants = React.useMemo(() => {
    if (!parsedModel.providerId || !parsedModel.modelId) return [];
    const provider = providers.find((p) => p.id === parsedModel.providerId);
    const model = provider?.models.find((m: Record<string, unknown>) => (m as { id?: string }).id === parsedModel.modelId) as
      | { variants?: Record<string, unknown> }
      | undefined;
    const variants = model?.variants;
    if (!variants) {
      return [];
    }
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

  const handleAutoWorktreeChange = React.useCallback(async (enabled: boolean) => {
    setSettingsAutoCreateWorktree(enabled);
    try {
      await updateDesktopSettings({
        autoCreateWorktree: enabled,
      });
    } catch (error) {
      console.warn('Failed to save auto create worktree setting:', error);
    }
  }, [setSettingsAutoCreateWorktree]);

  const handleZenModelChange = React.useCallback(async (modelId: string) => {
    setSettingsZenModel(modelId);
    try {
      await updateDesktopSettings({
        zenModel: modelId,
      });
    } catch (error) {
      console.warn('Failed to save zen model setting:', error);
    }
  }, [setSettingsZenModel]);

  if (isLoading) {
    return null;
  }

  return (
    <div className="mb-8">
      <div className="mb-3 px-1">
        <div className="flex items-center gap-2">
          <h3 className="typography-ui-header font-semibold text-foreground">Session Defaults</h3>
          <Tooltip delayDuration={1000}>
            <TooltipTrigger asChild>
              <RiInformationLine className="h-3.5 w-3.5 text-muted-foreground/60 cursor-help" />
            </TooltipTrigger>
            <TooltipContent sideOffset={8} className="max-w-xs">
              Configure default behaviors for new sessions.
            </TooltipContent>
          </Tooltip>
        </div>
        <p className="typography-meta text-muted-foreground mt-0.5">
          These settings will apply each time you start a new chat.
        </p>
      </div>

      <div className="rounded-lg bg-[var(--surface-elevated)]/70 overflow-hidden flex flex-col">
        <div className={cn("flex flex-col sm:flex-row sm:items-center justify-between gap-4 px-4 py-3 border-b border-[var(--surface-subtle)]")}>
          <div className="flex min-w-0 flex-col sm:w-1/3 shrink-0">
            <span className="typography-ui-label text-foreground">Default Model</span>
          </div>
          <div className="flex items-center gap-3 flex-1 max-w-sm justify-end">
            <ModelSelector
              providerId={parsedModel.providerId}
              modelId={parsedModel.modelId}
              onChange={handleModelChange}
            />
          </div>
        </div>

        {supportsVariants && (
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 px-4 py-3 border-b border-[var(--surface-subtle)]">
            <div className="flex min-w-0 flex-col sm:w-1/3 shrink-0">
              <span className="typography-ui-label text-foreground">Default Thinking</span>
            </div>
            <div className="flex items-center gap-3 flex-1 justify-end">
              <Select value={defaultVariant ?? DEFAULT_VARIANT_VALUE} onValueChange={handleVariantChange}>
                <SelectTrigger size="lg" className="w-fit min-w-[120px] bg-interactive-selection/20 border-border/20 hover:bg-interactive-hover/30 shadow-none focus:ring-0">
                  <SelectValue placeholder="Thinking" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={DEFAULT_VARIANT_VALUE}>Default</SelectItem>
                  {availableVariants.map((variant) => (
                    <SelectItem key={variant} value={variant}>
                      {variant}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        )}

        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 px-4 py-3 border-b border-[var(--surface-subtle)]">
          <div className="flex min-w-0 flex-col sm:w-1/3 shrink-0">
            <span className="typography-ui-label text-foreground">Default Agent</span>
          </div>
          <div className="flex items-center gap-3 flex-1 max-w-sm justify-end">
            <AgentSelector
              agentName={defaultAgent || ''}
              onChange={handleAgentChange}
            />
          </div>
        </div>

        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 px-4 py-3 border-b border-[var(--surface-subtle)]">
          <div className="flex min-w-0 flex-col sm:w-1/3 shrink-0">
            <div className="flex items-center gap-2">
              <span className="typography-ui-label text-foreground">Zen Model</span>
              <Tooltip delayDuration={1000}>
                <TooltipTrigger asChild>
                  <RiInformationLine className="h-3.5 w-3.5 text-muted-foreground/60 cursor-help" />
                </TooltipTrigger>
                <TooltipContent sideOffset={8} className="max-w-xs">
                  The free model used for lightweight internal tasks like commit message generation, PR descriptions, notification summarization, and TTS text summarization.
                </TooltipContent>
              </Tooltip>
            </div>
          </div>
          <div className="flex items-center gap-3 flex-1 justify-end">
            {zenModelsLoading ? (
              <span className="typography-meta text-muted-foreground">Loading models...</span>
            ) : zenModels.length > 0 ? (
              <Select value={selectedZenModel} onValueChange={handleZenModelChange}>
                <SelectTrigger size="lg" className="w-fit min-w-[120px] bg-interactive-selection/20 border-border/20 hover:bg-interactive-hover/30 shadow-none focus:ring-0">
                  <SelectValue placeholder="Select model" />
                </SelectTrigger>
                <SelectContent>
                  {zenModels.map((model) => (
                    <SelectItem key={model.id} value={model.id}>
                      {model.id}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <span className="typography-meta text-muted-foreground">No free models available</span>
            )}
          </div>
        </div>

        <label className={cn("group flex cursor-pointer items-center justify-between gap-4 px-4 py-3 transition-colors hover:bg-[var(--interactive-hover)]/30", !isVSCode && "border-b border-[var(--surface-subtle)]")}>
          <div className="flex min-w-0 flex-col sm:w-1/3 shrink-0">
            <span className="typography-ui-label text-foreground">Show Deletion Dialog</span>
          </div>
          <Switch
            checked={showDeletionDialog}
            onCheckedChange={setShowDeletionDialog}
            className="data-[state=checked]:bg-[var(--primary-base)]"
          />
        </label>

        {!isVSCode && (
          <label className="group flex cursor-pointer items-center justify-between gap-4 px-4 py-4 transition-colors hover:bg-[var(--interactive-hover)]/30">
            <div className="flex min-w-0 flex-col">
              <div className="flex items-center gap-1.5">
                <span className="typography-ui-label text-foreground">Always Create Worktree</span>
                <Tooltip delayDuration={1000}>
                  <TooltipTrigger asChild>
                    <RiInformationLine className="h-3.5 w-3.5 text-muted-foreground/60 cursor-help" />
                  </TooltipTrigger>
                  <TooltipContent sideOffset={8} className="max-w-xs">
                    {settingsAutoCreateWorktree
                      ? `New session (Worktree): ${getModifierLabel()}+N\nStandard: Shift+${getModifierLabel()}+N`
                      : `New session (Standard): ${getModifierLabel()}+N\nWorktree: Shift+${getModifierLabel()}+N`}
                  </TooltipContent>
                </Tooltip>
              </div>
            </div>
            <Switch
              checked={settingsAutoCreateWorktree}
              onCheckedChange={handleAutoWorktreeChange}
              className="data-[state=checked]:bg-[var(--primary-base)]"
            />
          </label>
        )}
      </div>
      
      {(parsedModel.providerId || defaultAgent) && (
        <div className="mt-3 px-3 typography-meta text-muted-foreground">
          New sessions will start with:{' '}
          {parsedModel.providerId && (
            <span className="text-foreground">
              {parsedModel.providerId}/{parsedModel.modelId}
              {supportsVariants ? ` (${defaultVariant ?? 'default'})` : ''}
            </span>
          )}
          {parsedModel.providerId && defaultAgent && ' / '}
          {defaultAgent && <span className="text-foreground">{defaultAgent}</span>}
        </div>
      )}
    </div>
  );
};
