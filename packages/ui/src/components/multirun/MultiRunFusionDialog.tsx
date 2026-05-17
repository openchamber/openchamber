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
import { getSyncMessages, getSyncParts } from '@/sync/sync-refs';
import { flattenAssistantTextParts } from '@/lib/messages/messageText';
import { getFusionSessionTitle, parseMultiRunSessionTitle } from '@/lib/multirun/title';
import { renderMagicPrompt } from '@/lib/magicPrompts';
import { AgentSelector } from './AgentSelector';
import { ModelMultiSelect, generateInstanceId, type ModelSelectionWithId } from './ModelMultiSelect';

type FusionSource = {
  session: Session;
  directory: string | null;
  projectDirectory: string | null;
};

const buildSourcePart = (source: FusionSource, text: string, index: number): string => {
  const title = source.session.title?.trim() || source.session.id;
  return `\n\n--- RESULT ${index + 1}: ${title} ---\n${text.trim()}\n--- END RESULT ${index + 1} ---`;
};

const getSessionProjectDirectory = (sessionId: string, directory: string | null): string | null => {
  const metadata = useSessionUIStore.getState().getWorktreeMetadata(sessionId);
  return metadata?.projectDirectory ?? directory;
};

const getLastAssistantText = async (source: FusionSource): Promise<string> => {
  const directory = source.directory ?? undefined;
  const messages = getSyncMessages(source.session.id, directory);

  if (messages.length === 0 && source.directory) {
    const result = await opencodeClient.withDirectory(source.directory, () =>
      opencodeClient.getSdkClient().session.messages({
        sessionID: source.session.id,
        directory: source.directory ?? undefined,
        limit: 50,
      })
    );
    const records = result.data ?? [];
    for (let index = records.length - 1; index >= 0; index -= 1) {
      const record = records[index] as { info?: { role?: string }; parts?: unknown[] };
      if (record.info?.role !== 'assistant') continue;
      return flattenAssistantTextParts((record.parts ?? []) as Parameters<typeof flattenAssistantTextParts>[0]).trim();
    }
    return '';
  }

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== 'assistant') continue;
    return flattenAssistantTextParts(getSyncParts(message.id, directory)).trim();
  }

  return '';
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
  const [sources, setSources] = React.useState<FusionSource[]>([]);
  const [isStarting, setIsStarting] = React.useState(false);

  const parsed = React.useMemo(() => parseMultiRunSessionTitle(session.title), [session.title]);
  const allSessions = React.useMemo(() => {
    const byId = new Map<string, Session>();
    for (const candidate of liveSessions) byId.set(candidate.id, candidate);
    for (const candidate of activeSessions) byId.set(candidate.id, candidate);
    for (const candidate of archivedSessions) byId.set(candidate.id, candidate);
    if (session.id) byId.set(session.id, session);
    return Array.from(byId.values());
  }, [activeSessions, archivedSessions, liveSessions, session]);

  React.useEffect(() => {
    if (!open || !parsed) return;

    const currentDirectory = useSessionUIStore.getState().getDirectoryForSession(session.id);
    const currentProjectDirectory = getSessionProjectDirectory(session.id, currentDirectory);
    const nextSources = allSessions
      .map((candidate): FusionSource | null => {
        const candidateParsed = parseMultiRunSessionTitle(candidate.title);
        if (!candidateParsed || candidateParsed.groupSlug !== parsed.groupSlug || candidateParsed.fusion) return null;
        const directory = useSessionUIStore.getState().getDirectoryForSession(candidate.id)
          ?? resolveGlobalSessionDirectory(candidate);
        const projectDirectory = getSessionProjectDirectory(candidate.id, directory);
        if (currentProjectDirectory && projectDirectory && currentProjectDirectory !== projectDirectory) return null;
        return { session: candidate, directory, projectDirectory };
      })
      .filter((source): source is FusionSource => source !== null)
      .sort((a, b) => (a.session.time?.created ?? 0) - (b.session.time?.created ?? 0));

    setSources(nextSources);
  }, [allSessions, open, parsed, session.id]);

  const selectedProvider = providers.find((provider) => provider.id === providerID);
  const selectedProviderModel = selectedProvider?.models.find((model) => model.id === modelID) as { variants?: Record<string, unknown> } | undefined;
  const variantKeys = selectedProviderModel?.variants ? Object.keys(selectedProviderModel.variants) : [];
  const canStart = Boolean(parsed && providerID && modelID && sources.length > 0 && !isStarting);

  const handleModelSelect = React.useCallback((model: ModelSelectionWithId) => {
    setSelectedModelSelection([model]);
    setProviderID(model.providerID);
    setModelID(model.modelID);
    setVariant('');
  }, []);

  const selectedModelLabel = selectedModelSelection[0]?.displayName || selectedModelSelection[0]?.modelID || t('multirun.fusion.model.placeholder');

  const handleStart = async () => {
    if (!parsed || !providerID || !modelID) return;
    setIsStarting(true);
    try {
      const sourceTexts = await Promise.all(sources.map((source) => getLastAssistantText(source)));
      const usableSources = sources
        .map((source, index) => ({ source, text: sourceTexts[index] ?? '' }))
        .filter((item) => item.text.trim().length > 0);

      if (usableSources.length === 0) {
        toast.error(t('multirun.fusion.toast.noOutputs'));
        return;
      }

      const directory = sources[0]?.projectDirectory ?? sources[0]?.directory ?? null;
      const fusionTitle = getFusionSessionTitle(parsed.groupSlug, providerID, modelID);
      const [visiblePrompt, instructionsPrompt] = await Promise.all([
        renderMagicPrompt('session.fusion.visible'),
        renderMagicPrompt('session.fusion.instructions'),
      ]);
      const fusionSession = await useSessionUIStore.getState().createSession(fusionTitle, directory, null);
      if (!fusionSession) throw new Error('Failed to create fusion session');

      useSessionUIStore.getState().setCurrentSession(fusionSession.id, directory);
      onOpenChange(false);

      await opencodeClient.withDirectory(directory ?? opencodeClient.getDirectory(), () =>
        opencodeClient.sendMessage({
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
        })
      );
    } catch (error) {
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
              addButtonClassName="h-8 w-fit max-w-[min(28rem,calc(100vw-8rem))] justify-start rounded-[9px] [corner-shape:squircle] supports-[corner-shape:squircle]:rounded-[50px] px-3 py-1.5"
              dropdownSide="bottom"
              dropdownClassName="w-[min(28rem,calc(100vw-8rem))]"
              triggerIcon={providerID ? <ProviderLogo providerId={providerID} className="h-3.5 w-3.5 mr-1" /> : undefined}
            />
          </div>

          {variantKeys.length > 0 ? (
            <Select value={variant || '__default__'} onValueChange={(value) => setVariant(value === '__default__' ? '' : value)}>
              <SelectTrigger size="lg" className="h-8 w-fit rounded-[9px] [corner-shape:squircle] supports-[corner-shape:squircle]:rounded-[50px] !border-border/80 !bg-[var(--surface-subtle)] hover:!bg-[var(--interactive-hover)]/70 typography-meta font-medium text-foreground px-3 py-1.5">
                <Icon name="brain-ai-3" className="h-3.5 w-3.5 text-muted-foreground" />
                <SelectValue>{(value) => value === '__default__' ? t('multirun.modelMultiSelect.variant.default') : value}</SelectValue>
              </SelectTrigger>
              <SelectContent fitContent portalToBody>
                <SelectItem value="__default__">{t('multirun.modelMultiSelect.variant.default')}</SelectItem>
                {variantKeys.map((key) => <SelectItem key={key} value={key}>{key}</SelectItem>)}
              </SelectContent>
            </Select>
          ) : null}

          <AgentSelector value={agent} onChange={setAgent} portalToBody className="h-8 rounded-[9px] [corner-shape:squircle] supports-[corner-shape:squircle]:rounded-[50px] px-3 py-1.5" />
        </div>

        <div className="space-y-2">
          <div className="typography-meta font-medium text-foreground">{t('multirun.fusion.sources.label', { count: sources.length })}</div>
          <div className="max-h-56 space-y-1 overflow-auto rounded-lg border border-[var(--interactive-border)] p-1">
            {sources.map((source) => (
              <div key={source.session.id} className="flex items-center gap-2 rounded-md px-2 py-1.5 typography-meta">
                <ProviderLogo providerId={parseMultiRunSessionTitle(source.session.title)?.providerID ?? ''} className="h-4 w-4" />
                <span className="min-w-0 flex-1 truncate">{source.session.title || source.session.id}</span>
                <button type="button" onClick={() => setSources((prev) => prev.filter((item) => item.session.id !== source.session.id))} className="text-muted-foreground hover:text-foreground">
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
