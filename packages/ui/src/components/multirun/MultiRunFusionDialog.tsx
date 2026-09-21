import React from 'react';
import type { Session } from '@opencode-ai/sdk/v2/client';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Icon } from '@/components/icon/Icon';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import { useI18n } from '@/lib/i18n';
import { opencodeClient } from '@/lib/opencode/client';
import { useConfigStore } from '@/stores/useConfigStore';
import { resolveGlobalSessionDirectory, useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useAllLiveSessions } from '@/sync/sync-context';
import { getFusionSessionTitle } from '@/lib/multirun/title';
import { getMultiRunIdentity, isFusionSource } from '@/lib/multirun/identity';
import { loadFusionOutputs, type FusionSource } from '@/lib/multirun/fusion';
import { createMultiRunSession } from '@/lib/multirun/createSession';
import { registerMultiRunSession } from '@/stores/useMultiRunStore';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { renderMagicPrompt } from '@/lib/magicPrompts';
import { AgentSelector } from './AgentSelector';
import { ModelMultiSelect, generateInstanceId, type ModelSelectionWithId } from './ModelMultiSelect';

const buildSourcePart = (source: FusionSource, text: string, index: number): string => {
  const title = source.session.title?.trim() || source.session.id;
  return `\n\n--- RESULT ${index + 1}: ${title} ---\n${text.trim()}\n--- END RESULT ${index + 1} ---`;
};

const getSessionProjectDirectory = (sessionId: string, directory: string | null): string | null => {
  const metadata = useSessionUIStore.getState().getWorktreeMetadata(sessionId);
  return metadata?.projectDirectory ?? directory;
};

export function MultiRunFusionDialog({
  session,
  open,
  onOpenChange,
}: {
  session: Session;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useI18n();
  const liveSessions = useAllLiveSessions();
  const activeSessions = useGlobalSessionsStore((state) => state.activeSessions);
  const archivedSessions = useGlobalSessionsStore((state) => state.archivedSessions);
  const sessionsReady = useGlobalSessionsStore((state) => state.status === 'ready');
  const providers = useConfigStore((state) => state.providers);
  const currentProviderId = useConfigStore((state) => state.currentProviderId);
  const currentModelId = useConfigStore((state) => state.currentModelId);
  const currentAgentName = useConfigStore((state) => state.currentAgentName);
  const [providerID, setProviderID] = React.useState(currentProviderId ?? '');
  const [modelID, setModelID] = React.useState(currentModelId ?? '');
  const [selectedModelSelection, setSelectedModelSelection] = React.useState<ModelSelectionWithId[]>(() => (
    currentProviderId && currentModelId
      ? [{ providerID: currentProviderId, modelID: currentModelId, instanceId: generateInstanceId() }]
      : []
  ));
  const [variant, setVariant] = React.useState<string>('');
  const [agent, setAgent] = React.useState(currentAgentName ?? '');
  const [excludedSources, setExcludedSources] = React.useState<string[]>([]);
  const [isStarting, setIsStarting] = React.useState(false);

  const parsed = React.useMemo(() => getMultiRunIdentity(session,
    getSessionProjectDirectory(session.id, session.directory) ?? session.directory), [session]);
  const allSessions = React.useMemo(() => {
    const byId = new Map<string, Session>();
    for (const candidate of liveSessions) byId.set(candidate.id, candidate);
    for (const candidate of activeSessions) byId.set(candidate.id, candidate);
    for (const candidate of archivedSessions) byId.set(candidate.id, candidate);
    if (session.id) byId.set(session.id, session);
    return Array.from(byId.values());
  }, [activeSessions, archivedSessions, liveSessions, session]);

  React.useEffect(() => { setExcludedSources([]); }, [open, session.id]);
  const sources = React.useMemo(() => {
    if (!open || !parsed) return [];
    return allSessions
      .map((candidate): FusionSource | null => {
        if (excludedSources.includes(candidate.id)) return null;
        const directory = useSessionUIStore.getState().getDirectoryForSession(candidate.id)
          ?? resolveGlobalSessionDirectory(candidate);
        const projectDirectory = getSessionProjectDirectory(candidate.id, directory);
        const identity = getMultiRunIdentity(candidate, projectDirectory ?? candidate.directory);
        if (!identity || !isFusionSource(parsed, identity)) return null;
        return { session: candidate, directory, projectDirectory, identity };
      })
      .filter((source): source is FusionSource => source !== null)
      .sort((a, b) => (a.session.time?.created ?? 0) - (b.session.time?.created ?? 0));

  }, [allSessions, open, parsed, excludedSources]);

  const selectedProvider = providers.find((provider) => provider.id === providerID);
  const selectedProviderModel = selectedProvider?.models.find((model) => model.id === modelID);
  const variantKeys = selectedProviderModel?.variants ? Object.keys(selectedProviderModel.variants) : [];
  const canStart = Boolean(parsed && sessionsReady && providerID && modelID && sources.length > 0 && !isStarting);

  const handleModelSelect = React.useCallback((model: ModelSelectionWithId) => {
    setSelectedModelSelection([model]);
    setProviderID(model.providerID);
    setModelID(model.modelID);
    setVariant('');
  }, []);

  const selectedModelLabel = selectedModelSelection[0]?.displayName || selectedModelSelection[0]?.modelID || t('multirun.fusion.model.placeholder');

  const handleStart = async () => {
    if (!parsed || !canStart) return;
    const runtimeKey = getRuntimeKey();
    const client = opencodeClient.getSdkClient();
    const assertCurrent = () => {
      if (getRuntimeKey() !== runtimeKey || opencodeClient.getSdkClient() !== client) throw new Error('Runtime changed');
    };
    setIsStarting(true);
    try {
      const usableSources = await loadFusionOutputs(client, sources, parsed, assertCurrent);

      if (usableSources.length === 0) {
        toast.error(t('multirun.fusion.toast.noOutputs'));
        return;
      }

      const directory = sources[0]?.projectDirectory ?? sources[0]?.directory ?? null;
      if (!directory) throw new Error('Fusion requires a session directory');
      const fusionTitle = getFusionSessionTitle(parsed.groupSlug, providerID, modelID, parsed.runGroup);
      const [visiblePrompt, instructionsPrompt] = await Promise.all([
        renderMagicPrompt('session.fusion.visible'),
        renderMagicPrompt('session.fusion.instructions'),
      ]);
      const fusionSession = await createMultiRunSession(client, {
        title: fusionTitle, directory,
        identity: { group: parsed.group, groupSlug: parsed.groupSlug, runGroup: parsed.runGroup,
          role: 'fusion', providerID, modelID },
      }, assertCurrent);
      registerMultiRunSession(fusionSession, directory);

      useSessionUIStore.getState().setCurrentSession(fusionSession.id, directory);
      onOpenChange(false);

      assertCurrent();
      await opencodeClient.sendMessage({
        runtimeKey,
        id: fusionSession.id,
        providerID,
        modelID,
        variant: variant || undefined,
        agent: agent || undefined,
        text: visiblePrompt,
        additionalParts: [
          { text: instructionsPrompt, synthetic: true },
          ...usableSources.map((item, index) => ({ text: buildSourcePart(item.source, item.text, index), synthetic: true })),
          { text: '\n\n--- FUSION INPUTS END ---\nNow write the final fused answer.', synthetic: true },
        ],
        directory,
      });
    } catch (error) {
      if (getRuntimeKey() !== runtimeKey || opencodeClient.getSdkClient() !== client) return;
      console.error('[MultiRunFusion] Failed to start fusion', error);
      toast.error(t('multirun.fusion.toast.failed'));
    } finally {
      setIsStarting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl overflow-visible">
        <DialogHeader>
          <DialogTitle>{t('multirun.fusion.title')}</DialogTitle>
          <DialogDescription>{t('multirun.fusion.description')}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-2">
          <div className="max-w-full">
            <ModelMultiSelect
              selectedModels={selectedModelSelection}
              onAdd={handleModelSelect}
              onUpdate={(_, model) => handleModelSelect(model)}
              onRemove={() => {
                setSelectedModelSelection([]);
                setProviderID('');
                setModelID('');
                setVariant('');
              }}
              maxModels={1}
              addButtonLabel={selectedModelLabel}
              showChips={false}
              addButtonClassName="w-fit max-w-[min(28rem,calc(100vw-8rem))] justify-start"
              dropdownSide="bottom"
              dropdownClassName="w-[min(28rem,calc(100vw-8rem))]"
              triggerIcon={providerID ? <ProviderLogo providerId={providerID} className="h-3.5 w-3.5 mr-1" /> : undefined}
            />
          </div>

          {variantKeys.length > 0 ? (
            <Select value={variant || '__default__'} onValueChange={(value) => setVariant(value === '__default__' ? '' : value)}>
              <SelectTrigger size="lg" className="w-fit">
                <Icon name="brain-ai-3" className="h-3.5 w-3.5 text-muted-foreground" />
                <SelectValue>{(value) => value === '__default__' ? t('multirun.modelMultiSelect.variant.default') : value}</SelectValue>
              </SelectTrigger>
              <SelectContent fitContent portalToBody>
                <SelectItem value="__default__">{t('multirun.modelMultiSelect.variant.default')}</SelectItem>
                {variantKeys.map((key) => <SelectItem key={key} value={key}>{key}</SelectItem>)}
              </SelectContent>
            </Select>
          ) : null}

          <AgentSelector value={agent} onChange={setAgent} portalToBody />
        </div>

        <div className="space-y-2">
          <div className="typography-meta font-medium text-foreground">{t('multirun.fusion.sources.label', { count: sources.length })}</div>
          <div className="max-h-56 space-y-1 overflow-auto rounded-lg border border-[var(--interactive-border)] p-1">
            {sources.map((source) => (
              <div key={source.session.id} className="flex items-center gap-2 rounded-md px-2 py-1.5 typography-meta">
                <ProviderLogo providerId={source.identity.providerID} className="h-4 w-4" />
                <span className="min-w-0 flex-1 truncate">{source.session.title || source.session.id}</span>
                <button type="button" onClick={() => setExcludedSources((prev) => [...prev, source.session.id])} className="text-muted-foreground hover:text-foreground">
                  <Icon name="close" className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>{t('multirun.fusion.actions.cancel')}</Button>
          <Button onClick={handleStart} disabled={!canStart}>{isStarting ? t('multirun.fusion.actions.starting') : t('multirun.fusion.actions.start')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
