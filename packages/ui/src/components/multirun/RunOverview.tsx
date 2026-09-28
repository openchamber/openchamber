import React from 'react';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { FusionIcon } from '@/components/icons/FusionIcon';
import { ProviderLogo } from '@/components/ui/ProviderLogo';
import { ScrollableOverlay } from '@/components/ui/ScrollableOverlay';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { normalizePath } from '@/lib/pathNormalization';
import type { Session } from '@/lib/opencode/model';
import { useConfigStore } from '@/stores/useConfigStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useGlobalSessionStatusStore } from '@/sync/global-session-status';
import { useMultiRun } from '@/lib/multirun/useMultiRuns';
import { multiRunVariantLabel, type MultiRunMember, type MultiRunSummary } from '@/lib/multirun/runs';
import { useLaneSummaries, type LaneSummaryInput } from '@/lib/multirun/useLaneSummaries';
import { loadLaneFirstPrompt } from '@/lib/multirun/laneData';
import { keepRunMember } from '@/lib/multirun/keep';
import { fusionModeFor, NoFusionOutputsError, startRunFusion } from '@/lib/multirun/fusion';
import { resolveFusionJudge } from '@/lib/multirun/autoFusion';
import { RUN_LAUNCHER_ID } from '@/lib/multirun/launcher';
import { addLaneToRun, archiveRun, detachFromRun, renameRun } from '@/lib/multirun/runActions';
import { AgentSelector } from './AgentSelector';
import { ModelMultiSelect, generateInstanceId, type ModelSelectionWithId } from './ModelMultiSelect';
import { RunLaneCard } from './RunLaneCard';
import { ModelEffortMenu } from './ModelEffortMenu';
import { LaneStatusIcon } from './LaneStatusIcon';
import { LANE_STATUS_COUNT_KEYS, LANE_STATUS_ORDER, resolveLaneStatus, type LaneStatus } from '@/lib/multirun/laneStatus';
import { useGlobalBlockingRequestsStore } from '@/sync/global-blocking-requests';
import { useNotificationStore } from '@/sync/notification-store';

type BarMode =
  | { kind: 'idle' }
  | { kind: 'keep'; sessionId: string }
  | { kind: 'fuse'; excluded: ReadonlySet<string> };

const modelLabelFor = (member: MultiRunMember, providers: ReturnType<typeof useConfigStore.getState>['providers']): string => {
  const provider = providers.find((entry) => entry.id === member.identity.providerID);
  const name = provider?.models.find((entry) => entry.id === member.identity.modelID)?.name || member.identity.modelID;
  return member.identity.index && member.identity.index > 1 ? `${name} #${member.identity.index}` : name;
};

/** The first prompt of each variant, read once, as the caption over its cards. */
function useVariantPrompts(run: MultiRunSummary | null, sessionById: ReadonlyMap<string, Session>): ReadonlyMap<string, string> {
  const [prompts, setPrompts] = React.useState<ReadonlyMap<string, string>>(new Map());
  const firstLaneByVariant = React.useMemo(() => {
    const map = new Map<string, string>();
    for (const lane of run?.lanes ?? []) {
      const variant = multiRunVariantLabel(lane.identity.runGroup);
      if (!map.has(variant)) map.set(variant, lane.sessionId);
    }
    return map;
  }, [run?.lanes]);
  React.useEffect(() => {
    let cancelled = false;
    for (const [variant, sessionId] of firstLaneByVariant) {
      const session = sessionById.get(sessionId);
      if (!session || prompts.has(variant)) continue;
      loadLaneFirstPrompt(sessionId, session.directory).then((prompt) => {
        if (cancelled || !prompt?.text) return;
        setPrompts((current) => new Map(current).set(variant, prompt.text));
      }, () => undefined);
    }
    return () => { cancelled = true; };
  // Captions are fixed once read; a session update never changes the first prompt.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstLaneByVariant]);
  return prompts;
}

/**
 * The prompt a variant's lanes received: one line until expanded, then the
 * whole text in a bounded, scrollable block. The toggle shows only when the
 * line is actually cut or the prompt has several lines.
 */
function PromptCaption({ prompt, expanded, onToggle }: { prompt: string; expanded: boolean; onToggle: () => void }): React.ReactNode {
  const { t } = useI18n();
  const lineRef = React.useRef<HTMLSpanElement>(null);
  const [overflows, setOverflows] = React.useState(false);
  React.useLayoutEffect(() => {
    const element = lineRef.current;
    if (!element || expanded) return;
    const measure = () => setOverflows(element.scrollWidth > element.clientWidth + 1 || prompt.includes('\n'));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [expanded, prompt]);
  const expandable = overflows || expanded;
  return (
    <div className="flex min-w-0 flex-1 items-start gap-1">
      {expanded ? (
        <div className="max-h-64 min-w-0 flex-1 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-[var(--surface-muted)] px-2 py-1.5 typography-meta text-foreground">
          {prompt}
        </div>
      ) : (
        <span ref={lineRef} className="min-w-0 flex-1 truncate typography-meta text-muted-foreground">{prompt}</span>
      )}
      {expandable ? (
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          className="inline-flex shrink-0 items-center gap-0.5 rounded px-1 typography-meta text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {expanded ? t('multirun.overview.prompt.collapse') : t('multirun.overview.prompt.expand')}
          <Icon name={expanded ? 'arrow-up-s' : 'arrow-down-s'} className="size-3.5" />
        </button>
      ) : null}
    </div>
  );
}

function RunOverviewContent({ runKey }: { runKey: string }): React.ReactNode {
  const { t } = useI18n();
  const { run, sessionById } = useMultiRun(runKey);
  const providers = useConfigStore((state) => state.providers);
  const currentProviderId = useConfigStore((state) => state.currentProviderId);
  const currentModelId = useConfigStore((state) => state.currentModelId);
  const currentAgentName = useConfigStore((state) => state.currentAgentName);
  const projects = useProjectsStore((state) => state.projects);
  const activeSessionIds = useGlobalSessionStatusStore((state) => state.activeSessionIds);
  const blockingBySession = useGlobalBlockingRequestsStore((state) => state.bySession);
  const unseenCountBySession = useNotificationStore((state) => state.index.session.unseenCount);
  // Phones get the overview, fusion and Keep, but never launch lanes (no header back arrow either).
  const isMobile = useUIStore((state) => state.isMobile);
  const [bar, setBar] = React.useState<BarMode>({ kind: 'idle' });
  const [busyAction, setBusyAction] = React.useState<'keep' | 'fuse' | 'ask' | 'archive' | 'member' | null>(null);
  const [judge, setJudge] = React.useState<ModelSelectionWithId[]>([]);
  const [judgeAgent, setJudgeAgent] = React.useState(currentAgentName ?? '');
  const [renaming, setRenaming] = React.useState<string | null>(null);
  const [expandedPrompts, setExpandedPrompts] = React.useState<ReadonlySet<string>>(() => new Set());
  const [pendingModel, setPendingModel] = React.useState<{ runGroup: string | undefined; model: ModelSelectionWithId } | null>(null);

  const projectRoots = React.useMemo(
    () => new Set(projects.map((project) => normalizePath(project.path)).filter((path): path is string => Boolean(path))),
    [projects],
  );
  const members = React.useMemo<LaneSummaryInput[]>(() => (run?.memberIds ?? []).map((sessionId) => {
    const session = sessionById.get(sessionId);
    const directory = normalizePath(session?.directory);
    return { sessionId, session, worktreePath: directory && !projectRoots.has(directory) ? directory : null };
  }), [projectRoots, run?.memberIds, sessionById]);
  const summaries = useLaneSummaries(members, activeSessionIds);
  const variantPrompts = useVariantPrompts(run, sessionById);
  const worktreeById = React.useMemo(() => new Map(members.map((member) => [member.sessionId, member.worktreePath])), [members]);

  React.useEffect(() => {
    if (judge.length > 0) return;
    const auto = run?.autoFusion;
    const providerID = auto?.providerID ?? currentProviderId;
    const modelID = auto?.modelID ?? currentModelId;
    if (providerID && modelID) setJudge([{ providerID, modelID, variant: auto?.variant, instanceId: generateInstanceId() }]);
  }, [currentModelId, currentProviderId, judge.length, run?.autoFusion]);

  if (!run) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center typography-meta text-muted-foreground">
        {t('multirun.overview.missing')}
        <Button variant="outline" size="sm" onClick={() => useUIStore.getState().closeMainSurfaces()}>
          {t('header.mainSurface.backToChat')}
        </Button>
      </div>
    );
  }

  const laneIds = run.lanes.map((lane) => lane.sessionId);
  const finishedLaneIds = laneIds.filter((id) => !activeSessionIds.has(id) && sessionById.get(id)?.time.idle);
  const busyLaneCount = laneIds.filter((id) => activeSessionIds.has(id)).length;
  const isolated = run.lanes.some((lane) => worktreeById.get(lane.sessionId));
  const memberById = new Map([...run.lanes, ...run.fusions].map((member) => [member.sessionId, member]));
  const nameOf = (sessionId: string): string => {
    const member = memberById.get(sessionId);
    return member ? modelLabelFor(member, providers) : '';
  };
  const autoFusionHere = run.autoFusion?.launcherId === RUN_LAUNCHER_ID && run.fusions.length === 0;
  const statusOf = (sessionId: string): LaneStatus | null => {
    const session = sessionById.get(sessionId);
    if (!session) return null;
    const pending = blockingBySession.get(sessionId);
    return resolveLaneStatus({
      session,
      busy: activeSessionIds.has(sessionId),
      blocking: pending?.permissions.length ? 'permission' : pending?.forms.length ? 'question' : null,
      reply: summaries.get(sessionId)?.reply,
    });
  };
  const laneStatusCounts = new Map<LaneStatus, number>();
  for (const id of laneIds) {
    const status = statusOf(id);
    if (status) laneStatusCounts.set(status, (laneStatusCounts.get(status) ?? 0) + 1);
  }
  const waitingLaneCount = (laneStatusCounts.get('permission') ?? 0) + (laneStatusCounts.get('question') ?? 0);

  const openChat = (sessionId: string) => {
    const session = sessionById.get(sessionId);
    useUIStore.getState().closeMainSurfaces();
    useSessionUIStore.getState().setCurrentSession(sessionId, session?.directory ?? null);
  };
  const openDiff = (sessionId: string) => {
    const directory = worktreeById.get(sessionId);
    openChat(sessionId);
    if (directory) useUIStore.getState().openContextPanelTab(directory, { mode: 'diff' });
  };

  const fuseSources = bar.kind === 'fuse' ? finishedLaneIds.filter((id) => !bar.excluded.has(id)) : [];
  const fuseMode = fusionModeFor(fuseSources.map((id) => {
    const diff = summaries.get(id)?.diff;
    return { hasWorktree: Boolean(worktreeById.get(id)), diff: diff?.state === 'ready' ? diff.stat : null };
  }));

  // Cards are only selectable while choosing fusion sources.
  const toggleFuseSource = (sessionId: string) => {
    if (bar.kind !== 'fuse' || !finishedLaneIds.includes(sessionId)) return;
    const excluded = new Set(bar.excluded);
    if (excluded.has(sessionId)) excluded.delete(sessionId); else excluded.add(sessionId);
    setBar({ kind: 'fuse', excluded });
  };

  const handleKeep = async (sessionId: string) => {
    setBusyAction('keep');
    try {
      const keptLabel = nameOf(sessionId);
      const result = await keepRunMember(run, sessionId, sessionById);
      if (result.failures.length > 0) {
        toast.error(result.failures.length === 1
          ? t('multirun.overview.keep.partialSingle', { name: keptLabel, count: result.failures.length })
          : t('multirun.overview.keep.partialPlural', { name: keptLabel, count: result.failures.length }));
      } else {
        toast.success(t('multirun.overview.keep.done', { name: keptLabel }));
      }
      openChat(sessionId);
    } catch (error) {
      console.error('[MultiRun] Keep failed', error);
      toast.error(t('multirun.overview.keep.failed'));
    } finally {
      setBusyAction(null);
      setBar({ kind: 'idle' });
    }
  };

  const handleFuse = async () => {
    const selection = judge[0];
    if (!selection || fuseSources.length < 2) return;
    setBusyAction('fuse');
    try {
      await startRunFusion({
        run,
        sourceIds: fuseSources,
        judge: resolveFusionJudge({ providerID: selection.providerID, modelID: selection.modelID, variant: selection.variant, agent: judgeAgent || undefined }),
        sessionById,
      });
      setBar({ kind: 'idle' });
    } catch (error) {
      console.error('[MultiRun] Fusion failed to start', error);
      toast.error(error instanceof NoFusionOutputsError ? t('multirun.fusion.toast.noOutputs') : t('multirun.fusion.toast.failed'));
    } finally {
      setBusyAction(null);
    }
  };

  const handleAddModel = async (model: ModelSelectionWithId, runGroup: string | undefined) => {
    setBusyAction('ask');
    try {
      await addLaneToRun({
        run,
        runGroup,
        model,
        sessionById,
      });
    } catch (error) {
      console.error('[MultiRun] Could not add a lane', error);
      toast.error(t('multirun.overview.ask.failed'));
    } finally {
      setBusyAction(null);
    }
  };

  const handleRename = async (title: string) => {
    setRenaming(null);
    if (!title.trim() || title.trim() === run.title) return;
    const failed = await renameRun(run, title, sessionById);
    if (failed.length > 0) toast.error(t('multirun.overview.rename.failed'));
  };

  const handleDetach = async (sessionId: string) => {
    const session = sessionById.get(sessionId);
    if (!session) return;
    setBusyAction('member');
    try {
      await detachFromRun(session, run.title);
      toast.success(t('multirun.overview.card.detachDone', { name: nameOf(sessionId) }));
    } catch (error) {
      console.error('[MultiRun] Could not detach a session', error);
      toast.error(t('multirun.overview.card.detachFailed'));
    } finally {
      setBusyAction(null);
    }
  };

  const handleArchiveMember = async (sessionId: string) => {
    setBusyAction('member');
    try {
      const result = await useSessionUIStore.getState().archiveSessions([sessionId]);
      if (result.failedIds.length > 0) toast.error(t('multirun.overview.archive.failed'));
    } finally {
      setBusyAction(null);
    }
  };

  const handleArchive = async () => {
    setBusyAction('archive');
    try {
      const result = await archiveRun(run);
      if (result.failedIds.length > 0) toast.error(t('multirun.overview.archive.failed'));
      else useUIStore.getState().closeMainSurfaces();
    } finally {
      setBusyAction(null);
    }
  };

  const renderCard = (member: MultiRunMember) => {
    const session = sessionById.get(member.sessionId);
    if (!session) return null;
    const isFusion = member.identity.role === 'fusion';
    const finished = finishedLaneIds.includes(member.sessionId);
    return (
      <RunLaneCard
        key={member.sessionId}
        session={session}
        providerID={member.identity.providerID}
        modelLabel={modelLabelFor(member, providers)}
        variantLabel={!isFusion && run.variants.length > 1 ? multiRunVariantLabel(member.identity.runGroup) : null}
        isFusion={isFusion}
        busy={activeSessionIds.has(member.sessionId)}
        status={statusOf(member.sessionId) ?? 'notStarted'}
        unread={(unseenCountBySession[member.sessionId] ?? 0) > 0}
        summary={summaries.get(member.sessionId)}
        fuseSource={bar.kind === 'fuse' && !isFusion
          ? { checked: finished && !bar.excluded.has(member.sessionId), selectable: finished }
          : null}
        hasWorktree={Boolean(worktreeById.get(member.sessionId))}
        onToggleFuseSource={() => toggleFuseSource(member.sessionId)}
        onKeep={isolated && finished && bar.kind === 'idle' && (isFusion ? Boolean(worktreeById.get(member.sessionId)) : true)
          ? () => setBar({ kind: 'keep', sessionId: member.sessionId })
          : undefined}
        onDetach={() => void handleDetach(member.sessionId)}
        onArchive={() => void handleArchiveMember(member.sessionId)}
        actionsDisabled={busyAction !== null || bar.kind !== 'idle'}
        onOpenChat={() => openChat(member.sessionId)}
        onOpenDiff={() => openDiff(member.sessionId)}
      />
    );
  };

  // Two steps: pick the model, then its thinking effort, then run it.
  const renderAddModel = (runGroup: string | undefined) => {
    const pending = pendingModel && pendingModel.runGroup === runGroup ? pendingModel.model : null;
    if (pending) {
      return (
        <span className="inline-flex flex-wrap items-center gap-1.5">
          <span className="inline-flex h-8 items-center gap-1.5 rounded-[9px] border border-border px-2.5 typography-meta text-foreground">
            <ProviderLogo providerId={pending.providerID} className="size-3.5" />
            {pending.displayName || pending.modelID}
          </span>
          <ModelEffortMenu
            appearance="trigger"
            providerID={pending.providerID}
            modelID={pending.modelID}
            variant={pending.variant}
            onChange={(variant) => setPendingModel({ runGroup, model: { ...pending, variant } })}
          />
          <Button
            size="sm"
            disabled={busyAction !== null}
            onClick={() => {
              setPendingModel(null);
              void handleAddModel(pending, runGroup);
            }}
          >
            {t('multirun.overview.addModel.confirm')}
          </Button>
          <Button variant="ghost" size="icon" className="size-8" aria-label={t('multirun.overview.cancel')} onClick={() => setPendingModel(null)}>
            <Icon name="close" className="size-3.5" />
          </Button>
        </span>
      );
    }
    return (
      <span title={t('multirun.overview.addModel.hint')}>
        <ModelMultiSelect
          selectedModels={[]}
          onAdd={(model) => setPendingModel({ runGroup, model })}
          onRemove={() => undefined}
          maxModels={1}
          showChips={false}
          dropdownSide="bottom"
          portal
          addButtonClassName="h-8 min-h-8 px-2.5 typography-meta"
          addButtonLabel={busyAction === 'ask' ? t('multirun.overview.ask.working') : t('multirun.overview.addModel.action')}
        />
      </span>
    );
  };

  // One card per row on a phone: two 280px columns never fit, and a single
  // card squeezed below that clips its actions.
  const cardGridClassName = isMobile
    ? 'grid grid-cols-1 gap-2.5'
    : 'grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-2.5';
  const keepTarget = bar.kind === 'keep' ? bar.sessionId : null;
  const othersCount = run.memberIds.length - 1;

  return (
    <div className="relative flex h-full flex-col">
      <ScrollableOverlay outerClassName="flex-1 min-h-0" className="h-full">
        <div className={cn('mx-auto w-full max-w-5xl pt-5', isMobile ? 'px-4' : 'px-6', isMobile && bar.kind === 'fuse' ? 'pb-56' : 'pb-32')}>
          <div className="flex items-start gap-2">
            {isMobile ? (
              <Button
                variant="ghost"
                size="icon"
                className="-ml-2 shrink-0"
                aria-label={t('header.mainSurface.backToChat')}
                onClick={() => useUIStore.getState().closeMainSurfaces()}
              >
                <Icon name="arrow-left" className="size-[18px]" />
              </Button>
            ) : null}
            <div className="min-w-0 flex-1">
              {renaming !== null ? (
                <form onSubmit={(event) => { event.preventDefault(); void handleRename(renaming); }}>
                  <input
                    autoFocus
                    value={renaming}
                    onChange={(event) => setRenaming(event.target.value)}
                    onBlur={() => void handleRename(renaming)}
                    onKeyDown={(event) => { if (event.key === 'Escape') setRenaming(null); }}
                    aria-label={t('multirun.overview.rename.aria')}
                    className="w-full rounded-md border border-border bg-transparent px-1.5 py-0.5 typography-heading-lg text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                </form>
              ) : (
                <button
                  type="button"
                  onClick={() => setRenaming(run.title)}
                  className="max-w-full truncate text-left typography-heading-lg text-foreground hover:underline decoration-dotted underline-offset-4"
                  title={t('multirun.overview.rename.aria')}
                >
                  {run.title}
                </button>
              )}
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 typography-meta text-muted-foreground">
                <span>
                  {run.lanes.length === 1
                    ? t('multirun.overview.meta.runsSingle', { count: run.lanes.length })
                    : t('multirun.overview.meta.runsPlural', { count: run.lanes.length })}
                  {run.variants.length > 1 ? ` · ${t('multirun.overview.meta.variants', { count: run.variants.length })}` : ''}
                </span>
                <span className="inline-flex items-center gap-1">
                  <Icon name="git-branch" className="size-3.5" />
                  {isolated ? t('multirun.overview.meta.worktrees') : t('multirun.overview.meta.sharedDirectory')}
                </span>
                {LANE_STATUS_ORDER.map((status) => {
                  const count = laneStatusCounts.get(status) ?? 0;
                  if (count === 0) return null;
                  return (
                    <span key={status} className="inline-flex items-center gap-1">
                      <LaneStatusIcon status={status} />
                      {t(LANE_STATUS_COUNT_KEYS[status], { count })}
                    </span>
                  );
                })}
                {autoFusionHere && run.autoFusion ? (
                  <span className="inline-flex items-center gap-1 text-foreground">
                    <FusionIcon className="size-3.5 text-[var(--primary-base)]" />
                    {t('multirun.overview.meta.autoFusion', { model: resolveFusionJudge(run.autoFusion).modelName ?? run.autoFusion.modelID })}
                  </span>
                ) : null}
              </div>
            </div>
            {!isMobile && run.variants.length === 1 ? renderAddModel(run.variants[0]) : null}
            <Button
              variant="ghost"
              size={isMobile ? 'icon' : 'sm'}
              className="shrink-0"
              disabled={busyAction !== null}
              aria-label={t('multirun.overview.archive.action')}
              onClick={() => void handleArchive()}
            >
              <Icon name="inbox-archive" className="size-4" />
              {isMobile ? null : t('multirun.overview.archive.action')}
            </Button>
          </div>

          {run.fusions.length > 0 ? (
            <section className="mt-6">
              <h2 className="mb-2 inline-flex items-center gap-1.5 typography-ui-label font-semibold text-foreground">
                <FusionIcon className="size-4 text-[var(--primary-base)]" />
                {t('multirun.overview.fusedResult')}
              </h2>
              <div className={cardGridClassName}>
                {run.fusions.map(renderCard)}
              </div>
            </section>
          ) : null}

          {run.variants.map((variant) => {
            const label = multiRunVariantLabel(variant);
            const lanes = run.lanes.filter((lane) => lane.identity.runGroup === variant);
            const prompt = variantPrompts.get(label);
            return (
              <section key={label} className="mt-6">
                <div className="mb-2 flex min-w-0 items-start gap-2">
                  {run.variants.length > 1 ? (
                    <span className="shrink-0 rounded border border-border px-1.5 typography-meta font-semibold text-foreground">{label}</span>
                  ) : null}
                  {prompt ? (
                    <PromptCaption
                      prompt={prompt}
                      expanded={expandedPrompts.has(label)}
                      onToggle={() => setExpandedPrompts((current) => {
                        const next = new Set(current);
                        if (next.has(label)) next.delete(label); else next.add(label);
                        return next;
                      })}
                    />
                  ) : null}
                  {!isMobile && run.variants.length > 1 ? <span className="ml-auto shrink-0">{renderAddModel(variant)}</span> : null}
                </div>
                <div className={cardGridClassName}>
                  {lanes.map(renderCard)}
                </div>
              </section>
            );
          })}
        </div>
      </ScrollableOverlay>

      <div className={cn('pointer-events-none absolute inset-x-0 bottom-4 flex justify-center', isMobile ? 'px-3' : 'px-6')}>
        <div className="pointer-events-auto flex w-full max-w-4xl flex-wrap items-center gap-2 rounded-xl border border-[var(--interactive-border-hover)] bg-[var(--surface-elevated)] px-3 py-2 shadow-lg">
          {keepTarget ? (
            <>
              <Icon name="git-branch" className="size-4 text-muted-foreground" />
              <span className="min-w-0 flex-1 typography-meta text-foreground">
                {othersCount === 1
                  ? t('multirun.overview.keep.confirmSingle', { name: nameOf(keepTarget), count: othersCount })
                  : t('multirun.overview.keep.confirmPlural', { name: nameOf(keepTarget), count: othersCount })}
              </span>
              <Button variant="ghost" size="sm" disabled={busyAction !== null} onClick={() => setBar({ kind: 'idle' })}>
                {t('multirun.overview.cancel')}
              </Button>
              <Button size="sm" disabled={busyAction !== null} onClick={() => void handleKeep(keepTarget)}>
                {busyAction === 'keep' ? t('multirun.overview.keep.working') : t('multirun.overview.keep.confirm')}
              </Button>
            </>
          ) : bar.kind === 'fuse' ? (
            <>
              <FusionIcon className="size-4 text-[var(--primary-base)]" />
              <span className="typography-meta text-foreground">{t('multirun.overview.fuse.with')}</span>
              <ModelMultiSelect
                selectedModels={judge}
                onAdd={(model) => setJudge([model])}
                onUpdate={(_, model) => setJudge([model])}
                onRemove={() => setJudge([])}
                maxModels={1}
                showChips={false}
                dropdownSide="top"
                addButtonLabel={judge[0] ? (judge[0].displayName || judge[0].modelID) : t('multirun.fusion.model.placeholder')}
                triggerIcon={judge[0] ? <ProviderLogo providerId={judge[0].providerID} className="mr-1 size-3.5" /> : undefined}
              />
              {judge[0] ? (
                <ModelEffortMenu
                  appearance="trigger"
                  providerID={judge[0].providerID}
                  modelID={judge[0].modelID}
                  variant={judge[0].variant}
                  onChange={(variant) => setJudge((current) => current.map((entry) => ({ ...entry, variant })))}
                />
              ) : null}
              <AgentSelector value={judgeAgent} onChange={setJudgeAgent} className="w-fit" />
              <span className="typography-micro text-muted-foreground">
                {fuseMode === 'code' ? t('multirun.overview.fuse.modeCode') : t('multirun.overview.fuse.modeAnswers')}
              </span>
              <span className="flex-1" />
              <span className="typography-micro text-muted-foreground">
                {t('multirun.overview.fuse.selected', { count: fuseSources.length, total: finishedLaneIds.length })}
              </span>
              <Button variant="ghost" size="sm" disabled={busyAction !== null} onClick={() => setBar({ kind: 'idle' })}>
                {t('multirun.overview.cancel')}
              </Button>
              <Button size="sm" disabled={busyAction !== null || fuseSources.length < 2 || judge.length === 0} onClick={() => void handleFuse()}>
                {busyAction === 'fuse' ? t('multirun.fusion.actions.starting') : t('multirun.fusion.actions.start')}
              </Button>
            </>
          ) : (
            <>
              <span className={cn('min-w-0 flex-1 truncate typography-meta', waitingLaneCount > 0 ? 'text-foreground' : 'text-muted-foreground')}>
                {waitingLaneCount > 0
                  ? t('multirun.overview.bar.waiting', { count: waitingLaneCount })
                  : busyLaneCount > 0
                    ? t('multirun.overview.meta.progress', { done: laneIds.length - busyLaneCount, total: laneIds.length })
                    : t('multirun.overview.bar.hint')}
              </span>
              <Button
                size="sm"
                disabled={finishedLaneIds.length < 2 || busyAction !== null}
                onClick={() => setBar({ kind: 'fuse', excluded: new Set() })}
              >
                <FusionIcon className="size-4" />
                {t('multirun.overview.bar.fuse')}
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** Replaces the chat area while a run overview is open. */
export function RunOverview(): React.ReactNode {
  const runKey = useUIStore((state) => state.runOverviewKey);
  if (!runKey) return null;
  return (
    <div className={cn('absolute inset-0 z-10 bg-background')}>
      <RunOverviewContent key={runKey} runKey={runKey} />
    </div>
  );
}
