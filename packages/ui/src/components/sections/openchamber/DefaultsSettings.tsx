import React from 'react';
import { RiInformationLine } from '@remixicon/react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ModelSelector } from '@/components/sections/agents/ModelSelector';
import { AgentSelector } from '@/components/sections/commands/AgentSelector';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { updateDesktopSettings } from '@/lib/persistence';
import { isVSCodeRuntime } from '@/lib/desktop';
import { useConfigStore } from '@/stores/useConfigStore';
import { useUIStore } from '@/stores/useUIStore';
import { getRegisteredRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { getModifierLabel, cn } from '@/lib/utils';

const UTILITY_PROVIDER_ID = 'zen';
const UTILITY_PREFERRED_MODEL_ID = 'big-pickle';

const getDisplayModel = (
  storedModel: string | undefined
): { providerId: string; modelId: string } => {
  if (storedModel) {
    const parts = storedModel.split('/');
    if (parts.length === 2 && parts[0] && parts[1]) {
      return { providerId: parts[0], modelId: parts[1] };
    }
  }

  return { providerId: '', modelId: '' };
};

const getUtilityDisplayModel = (
  storedGitProviderId: string | undefined,
  storedGitModelId: string | undefined,
  zenModel: string | undefined,
  providers: Array<{ id: string; models: Array<{ id: string }> }>
): { providerId: string; modelId: string } => {
  if (storedGitProviderId && storedGitModelId) {
    const provider = providers.find((p) => p.id === storedGitProviderId);
    if (provider?.models.some((m) => m.id === storedGitModelId)) {
      return { providerId: storedGitProviderId, modelId: storedGitModelId };
    }
  }

  const utilityProvider = providers.find((p) => p.id === UTILITY_PROVIDER_ID);
  if (zenModel && utilityProvider?.models.some((m) => m.id === zenModel)) {
    return { providerId: UTILITY_PROVIDER_ID, modelId: zenModel };
  }

  const preferredUtilityModel = utilityProvider?.models.find((m) => m.id === UTILITY_PREFERRED_MODEL_ID);
  if (preferredUtilityModel) {
    return { providerId: UTILITY_PROVIDER_ID, modelId: preferredUtilityModel.id };
  }

  if (utilityProvider?.models.length) {
    const randomIndex = Math.floor(Math.random() * utilityProvider.models.length);
    const randomModel = utilityProvider.models[randomIndex];
    if (randomModel?.id) {
      return { providerId: UTILITY_PROVIDER_ID, modelId: randomModel.id };
    }
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
  const settingsGitProviderId = useConfigStore((state) => state.settingsGitProviderId);
  const settingsGitModelId = useConfigStore((state) => state.settingsGitModelId);
  const setSettingsGitProviderId = useConfigStore((state) => state.setSettingsGitProviderId);
  const setSettingsGitModelId = useConfigStore((state) => state.setSettingsGitModelId);
  const showDeletionDialog = useUIStore((state) => state.showDeletionDialog);
  const setShowDeletionDialog = useUIStore((state) => state.setShowDeletionDialog);
  const providers = useConfigStore((state) => state.providers);

  const [defaultModel, setDefaultModel] = React.useState<string | undefined>();
  const [defaultVariant, setDefaultVariant] = React.useState<string | undefined>();
  const [defaultAgent, setDefaultAgent] = React.useState<string | undefined>();
  const [isLoading, setIsLoading] = React.useState(true);

  const parsedModel = React.useMemo(() => getDisplayModel(defaultModel), [defaultModel]);
  const utilityDisplayModel = React.useMemo(() => {
    return getUtilityDisplayModel(settingsGitProviderId, settingsGitModelId, settingsZenModel, providers);
  }, [settingsGitProviderId, settingsGitModelId, settingsZenModel, providers]);
  const isVSCode = React.useMemo(() => isVSCodeRuntime(), []);

  React.useEffect(() => {
    const loadSettings = async () => {
      try {
        let data: {
          defaultModel?: string;
          defaultVariant?: string;
          defaultAgent?: string;
          zenModel?: string;
          gitProviderId?: string;
          gitModelId?: string;
        } | null = null;

        if (!data) {
          const runtimeSettings = getRegisteredRuntimeAPIs()?.settings;
          if (runtimeSettings) {
            try {
              const result = await runtimeSettings.load();
              const settings = result?.settings;
              if (settings) {
                data = {
                  defaultModel: typeof settings.defaultModel === 'string' ? settings.defaultModel : undefined,
                  defaultVariant:
                    typeof (settings as Record<string, unknown>).defaultVariant === 'string'
                      ? ((settings as Record<string, unknown>).defaultVariant as string)
                      : undefined,
                  defaultAgent: typeof settings.defaultAgent === 'string' ? settings.defaultAgent : undefined,
                  zenModel:
                    typeof (settings as Record<string, unknown>).zenModel === 'string'
                      ? ((settings as Record<string, unknown>).zenModel as string)
                      : undefined,
                  gitProviderId:
                    typeof (settings as Record<string, unknown>).gitProviderId === 'string'
                      ? ((settings as Record<string, unknown>).gitProviderId as string)
                      : undefined,
                  gitModelId:
                    typeof (settings as Record<string, unknown>).gitModelId === 'string'
                      ? ((settings as Record<string, unknown>).gitModelId as string)
                      : undefined,
                };
              }
            } catch {
              // fall through
            }
          }
        }

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
          const zen =
            typeof data.zenModel === 'string' && data.zenModel.trim().length > 0
              ? data.zenModel.trim()
              : undefined;
          const gitProviderId =
            typeof data.gitProviderId === 'string' && data.gitProviderId.trim().length > 0
              ? data.gitProviderId.trim()
              : undefined;
          const gitModelId =
            typeof data.gitModelId === 'string' && data.gitModelId.trim().length > 0
              ? data.gitModelId.trim()
              : undefined;

          if (model !== undefined) setDefaultModel(model);
          if (variant !== undefined) setDefaultVariant(variant);
          if (agent !== undefined) setDefaultAgent(agent);
          if (zen !== undefined) setSettingsZenModel(zen);
          if (gitProviderId !== undefined) setSettingsGitProviderId(gitProviderId);
          if (gitModelId !== undefined) setSettingsGitModelId(gitModelId);
        }
      } catch (error) {
        console.warn('Failed to load defaults settings:', error);
      } finally {
        setIsLoading(false);
      }
    };
    loadSettings();
  }, [setSettingsGitModelId, setSettingsGitProviderId, setSettingsZenModel]);

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
        const response = await fetch('/api/config/settings', {
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

  const handleAutoWorktreeChange = React.useCallback(
    async (enabled: boolean) => {
      setSettingsAutoCreateWorktree(enabled);
      try {
        await updateDesktopSettings({ autoCreateWorktree: enabled });
      } catch (error) {
        console.warn('Failed to save auto create worktree setting:', error);
      }
    },
    [setSettingsAutoCreateWorktree]
  );

  const handleUtilityModelChange = React.useCallback(
    async (providerId: string, modelId: string) => {
      setSettingsGitProviderId(providerId);
      setSettingsGitModelId(modelId);
      if (providerId === UTILITY_PROVIDER_ID) {
        setSettingsZenModel(modelId);
      }
      try {
        await updateDesktopSettings({
          gitProviderId: providerId,
          gitModelId: modelId,
          ...(providerId === UTILITY_PROVIDER_ID ? { zenModel: modelId } : {}),
        });
      } catch (error) {
        console.warn('Failed to save utility model setting:', error);
      }
    },
    [setSettingsGitModelId, setSettingsGitProviderId, setSettingsZenModel]
  );

  if (isLoading) {
    return null;
  }

  return (
    <div className="mb-6">
      <div className="mb-0.5 px-1">
        <div className="flex items-center gap-2">
          <h3 className="typography-ui-header font-medium text-foreground">Session Defaults</h3>
        </div>
      </div>

      <section className="px-2 pb-2 pt-0 space-y-0">
        <div className="mt-0 mb-1 typography-meta text-muted-foreground">
          New sessions will start with:{' '}
          {parsedModel.providerId ? (
            <span className="text-foreground">
              {parsedModel.providerId}/{parsedModel.modelId}
              {supportsVariants ? ` (${defaultVariant ?? 'default'})` : ''}
            </span>
          ) : (
            <span className="text-foreground">opencode agent default</span>
          )}
          {defaultAgent && (
            <>
              {' / '}
              <span className="text-foreground">{defaultAgent}</span>
            </>
          )}
        </div>

        <div className={cn('flex flex-col gap-2 py-1 sm:flex-row sm:items-center sm:gap-8')}>
          <div className="flex min-w-0 flex-col sm:w-56 shrink-0">
            <span className="typography-ui-label text-foreground">Default Model</span>
          </div>
          <div className="flex min-w-0 flex-1 items-center gap-2 sm:w-fit sm:flex-initial">
            <ModelSelector providerId={parsedModel.providerId} modelId={parsedModel.modelId} onChange={handleModelChange} />
          </div>
        </div>

        <div className="flex flex-col gap-2 py-1 sm:flex-row sm:items-center sm:gap-8">
          <div className="flex min-w-0 flex-col sm:w-56 shrink-0">
            <span className="typography-ui-label text-foreground">Default Thinking</span>
          </div>
          <div className="flex items-center gap-2 sm:w-fit">
            <Select value={defaultVariant ?? DEFAULT_VARIANT_VALUE} onValueChange={handleVariantChange} disabled={!supportsVariants}>
              <SelectTrigger className="w-fit min-w-[120px]">
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

        <div className="flex flex-col gap-2 py-1 sm:flex-row sm:items-center sm:gap-8">
          <div className="flex min-w-0 flex-col sm:w-56 shrink-0">
            <span className="typography-ui-label text-foreground">Default Agent</span>
          </div>
          <div className="flex min-w-0 flex-1 items-center gap-2 sm:w-fit sm:flex-initial">
            <AgentSelector agentName={defaultAgent || ''} onChange={handleAgentChange} />
          </div>
        </div>

        <div className="flex flex-col gap-2 py-1 sm:flex-row sm:items-center sm:gap-8">
          <div className="flex min-w-0 flex-col sm:w-56 shrink-0">
            <div className="flex items-center gap-2">
              <span className="typography-ui-label text-foreground">Utility Model</span>
              <Tooltip delayDuration={1000}>
                <TooltipTrigger asChild>
                  <RiInformationLine className="h-3.5 w-3.5 text-muted-foreground/60 cursor-help" />
                </TooltipTrigger>
                <TooltipContent sideOffset={8} className="max-w-xs">
                  The model used for lightweight background tasks like commit messages, PR descriptions, and summarization.
                </TooltipContent>
              </Tooltip>
            </div>
          </div>
          <div className="flex min-w-0 flex-1 items-center gap-2 sm:w-fit sm:flex-initial">
            <ModelSelector
              providerId={utilityDisplayModel.providerId}
              modelId={utilityDisplayModel.modelId}
              onChange={handleUtilityModelChange}
            />
          </div>
        </div>

        <div
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
          <Checkbox checked={showDeletionDialog} onChange={setShowDeletionDialog} ariaLabel="Show deletion dialog" />
          <span className="typography-ui-label text-foreground">Show Deletion Dialog</span>
        </div>

        {!isVSCode && (
          <div
            className="group flex cursor-pointer items-center gap-2 py-1"
            role="button"
            tabIndex={0}
            aria-pressed={settingsAutoCreateWorktree}
            onClick={() => {
              void handleAutoWorktreeChange(!settingsAutoCreateWorktree);
            }}
            onKeyDown={(event) => {
              if (event.key === ' ' || event.key === 'Enter') {
                event.preventDefault();
                void handleAutoWorktreeChange(!settingsAutoCreateWorktree);
              }
            }}
          >
            <Checkbox
              checked={settingsAutoCreateWorktree}
              onChange={(checked) => {
                void handleAutoWorktreeChange(checked);
              }}
              ariaLabel="Always create worktree"
            />
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
          </div>
        )}
      </section>
    </div>
  );
};
