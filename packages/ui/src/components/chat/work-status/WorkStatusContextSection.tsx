import React from 'react';
import { toast } from 'sonner';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useI18n } from '@/lib/i18n';
import { Icon } from '@/components/icon/Icon';
import { selectAvailableSkillsForDirectory, selectSkillsForDirectory, useSkillsStore } from '@/stores/useSkillsStore';
import { useMcpStore } from '@/stores/useMcpStore';
import { useSession, useSessionMessagesSelector } from '@/sync/sync-context';
import type { State } from '@/sync/types';
import type { Message } from '@/lib/opencode/model';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import { resolveLoadedSkillTarget, sameLoadedSkills, selectLoadedSkills, type LoadedSkill } from './loadedSkills';
import { openSkillSettings } from '@/components/sections/skills/openSkillSettings';
import { getDistinctLinkedIssues, getLinkedSidebarChanges, getLinkedSidebarIssues, getRepositoryThreadRef, isLinkedChange, type LinkedIssue, type RepositoryThreadRef } from '@/lib/linkedIssues';
import { useRepositoryUrlMatcher } from '@/lib/source-control/repositoryUrlMatcher';
import { formatChangeRequestReference } from '@/lib/source-control/providers/terminology';
import type { ChangeRequestTerm } from '@/lib/source-control/providers/descriptor';
import { useFreshestSourceControlVisualSummaryForBranch, type PrVisualSummary } from '@/stores/useGitHubPrStatusStore';
import { useEffectiveGitDirectory, useGitStore } from '@/stores/useGitStore';
import { useTrackedIssueStates, useTrackedPullVisualSummaries, useTrackedWorkItemStates } from '@/stores/useTrackedItemsStore';
import { useTrackedItems } from '@/lib/trackedItems/interest';
import { repositoryThread, workItem } from '@/lib/trackedItems/fromLinks';
import { trackerPresentation } from '@/lib/trackers/presentation';
import { useTrackerDescriptors } from '@/lib/trackers/registry';
import { getPrStatusLabel } from '@/components/session/sidebar/prStatusLabel';
import { getIssueStateLook, getTrackerItemStateLook } from '@/components/session/sidebar/sessions/sessionPrSummaries';
import { fetchSessionKnowledgeSummary, setSessionProjectContextPin, type SessionKnowledgeSummary } from '@/lib/sessionKnowledgeApi';
import * as sessionActions from '@/sync/session-actions';
import { useProjectContextStore } from '@/stores/useProjectContextStore';
import { useAgentMemoryStore } from '@/stores/useAgentMemoryStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { resolveProjectForSessionDirectory } from '@/lib/projectResolution';
import { resolveProjectContextId, type ProjectPlanLink, type ProjectRef } from '@/lib/projectContextApi';
import { useConfigStore } from '@/stores/useConfigStore';
import { useOutsideRepository } from '@/components/sourceBoard/useOutsideRepository';
import { useOpenTrackerItem } from '@/components/sourceBoard/openTrackerItem';
import { useCopyReferenceLink } from '@/components/references/useCopyReferenceLink';
import { WorkStatusCollapsibleSection, WorkStatusRow, WorkStatusValue } from './WorkStatusPrimitives';
import { useReportWorkStatusPresence } from './presenceContext';
import { resolveDraftPinnedKnowledge } from './draftKnowledge';
import { changeRequestCopy } from '@/lib/source-control/changeRequestCopy';
import { refTintStyle } from '@/lib/source-control/prVisualState';
import { cn } from '@/lib/utils';
import { useLeaveWorkStatus } from './leaveWorkStatus';
import { useProjectContextOwner } from '@/hooks/useProjectContextOwner';
import { observeProjectContext } from '@/lib/projectContextSync';
import { runBackgroundNetworkTask } from '@/lib/background-network';
import { useUIStore } from '@/stores/useUIStore';
import { useMobileAppActions } from '@/apps/mobileAppContext';

const EMPTY_PLANS: ProjectPlanLink[] = [];

const selectSessionLoadedSkills = (messages: Message[], state: State): LoadedSkill[] => selectLoadedSkills(messages, state.part);

const useSessionLinkedPlans = (sessionId: string | null, projectRef: ProjectRef | null): ProjectPlanLink[] => {
  const contextId = projectRef ? resolveProjectContextId(projectRef) : null;
  const plans = useProjectContextStore((state) => (contextId ? state.entries[contextId]?.plans : undefined) ?? EMPTY_PLANS);
  const projectId = projectRef?.id;
  const projectPath = projectRef?.path;
  React.useEffect(() => {
    if (!sessionId || !projectId || !projectPath) return;
    const project = { id: projectId, path: projectPath };
    return observeProjectContext(project, () => runBackgroundNetworkTask(
      () => useProjectContextStore.getState().load(project, { force: true }),
    ));
  }, [projectId, projectPath, sessionId]);
  return React.useMemo(
    () => (sessionId ? plans.filter((plan) => plan.session?.sessionId === sessionId) : EMPTY_PLANS),
    [plans, sessionId],
  );
};


type Props = {
  sessionId: string | null;
  directory: string | null;
};

const LinkedReference: React.FC<{ reference: string; status?: string | null; url: string; directory: string | null }> = ({ reference, status, url, directory }) => {
  const repository = useOutsideRepository(url, directory);
  return <>{[reference, repository, status].filter(Boolean).join(' · ')}</>;
};

export const WorkStatusContextSection: React.FC<Props> = ({ sessionId, directory }) => {
  const { t } = useI18n();

  const session = useSession(sessionId ?? '', directory ?? undefined);
  const newSessionDraft = useSessionUIStore((state) => state.newSessionDraft);
  const setDraftProjectContextPin = useSessionUIStore((state) => state.setDraftProjectContextPin);
  const availableWorktreesByProject = useSessionUIStore((state) => state.availableWorktreesByProject);
  const projects = useProjectsStore((state) => state.projects);
  const isDraft = sessionId === null && newSessionDraft.open;
  const skills = useSkillsStore((state) => selectAvailableSkillsForDirectory(state));
  const installedSkills = useSkillsStore((state) => selectSkillsForDirectory(state, directory));
  const loadedSkills = useSessionMessagesSelector(sessionId ?? '', directory ?? undefined, selectSessionLoadedSkills, sameLoadedSkills, true);
  const mcpStatus = useMcpStore(
    React.useCallback((state) => state.getStatusForDirectory(directory), [directory]),
  );

  const loadSkills = useSkillsStore((state) => state.loadSkills);
  const isConnected = useConfigStore((state) => state.isConnected);
  React.useEffect(() => {
    void loadSkills();
    if (directory) void loadSkills(directory);
  }, [directory, isConnected, loadSkills]);

  const [knowledge, setKnowledge] = React.useState<SessionKnowledgeSummary>(
    { notes: [], plans: [], memory: { global: 0, project: 0 } },
  );

  const contextEntries = useProjectContextStore((state) => state.entries);
  const loadProjectContext = useProjectContextStore((state) => state.load);
  const memoryProject = useAgentMemoryStore((state) => state.project);
  const memoryGlobal = useAgentMemoryStore((state) => state.global);

  const draftProject = React.useMemo(() => {
    if (!isDraft) return null;
    const selected = newSessionDraft.selectedProjectId
      ? projects.find((project) => project.id === newSessionDraft.selectedProjectId) ?? null
      : null;
    return selected ?? resolveProjectForSessionDirectory(
      projects,
      availableWorktreesByProject,
      newSessionDraft.directoryOverride ?? directory,
    );
  }, [availableWorktreesByProject, directory, isDraft, newSessionDraft.directoryOverride, newSessionDraft.selectedProjectId, projects]);

  const draftContextEntry = draftProject
    ? contextEntries[resolveProjectContextId({ id: draftProject.id, path: draftProject.path })]
    : undefined;

  React.useEffect(() => {
    if (!isDraft || !draftProject) return;
    void loadProjectContext({ id: draftProject.id, path: draftProject.path });
  }, [draftProject, isDraft, loadProjectContext]);

  const openchamberMetadataKey = JSON.stringify(session?.metadata?.openchamber ?? null);
  React.useEffect(() => {
    let cancelled = false;
    void fetchSessionKnowledgeSummary(directory, sessionId).then((summary) => {
      if (!cancelled) setKnowledge(summary);
    });
    return () => { cancelled = true; };
  }, [directory, sessionId, openchamberMetadataKey, contextEntries, memoryProject, memoryGlobal]);

  const visibleKnowledge = React.useMemo<SessionKnowledgeSummary>(() => {
    if (!isDraft) return knowledge;
    const pinned = resolveDraftPinnedKnowledge(
      draftContextEntry?.notes ?? [],
      draftContextEntry?.plans ?? [],
      newSessionDraft.projectContextPins ?? { notes: [], plans: [] },
    );
    return { ...knowledge, ...pinned };
  }, [draftContextEntry?.notes, draftContextEntry?.plans, isDraft, knowledge, newSessionDraft.projectContextPins]);

  const unpinNote = React.useCallback((noteId: string) => {
    if (isDraft) {
      setDraftProjectContextPin('note', noteId, false);
      return;
    }
    if (!directory || !sessionId) return;
    void setSessionProjectContextPin(directory, sessionId, 'note', noteId, false).then((pins) => {
      if (pins) setKnowledge((current) => ({ ...current, notes: current.notes.filter((note) => note.id !== noteId) }));
    });
  }, [directory, isDraft, sessionId, setDraftProjectContextPin]);
  const unpinPlan = React.useCallback((planId: string) => {
    if (isDraft) {
      setDraftProjectContextPin('plan', planId, false);
      return;
    }
    if (!directory || !sessionId) return;
    void setSessionProjectContextPin(directory, sessionId, 'plan', planId, false).then((pins) => {
      if (pins) setKnowledge((current) => ({ ...current, plans: current.plans.filter((plan) => plan.id !== planId) }));
    });
  }, [directory, isDraft, sessionId, setDraftProjectContextPin]);

  const unlinkLinkedThread = React.useCallback((issue: LinkedIssue) => {
    if (!directory || !sessionId) return;
    void sessionActions.setLinkedIssue(sessionId, directory, issue, false).catch(() => {
      toast.error(t('chat.workStatus.linkedIssues.unlinkFailed'));
    });
  }, [directory, sessionId, t]);

  const projectRef = useProjectContextOwner(directory);
  const linkedPlans = useSessionLinkedPlans(sessionId, projectRef);
  const linkedPlanIds = React.useMemo(() => new Set(linkedPlans.map((plan) => plan.id)), [linkedPlans]);
  const pinnedPlanIds = React.useMemo(() => new Set(visibleKnowledge.plans.map((plan) => plan.id)), [visibleKnowledge.plans]);
  const pinnedOnlyPlans = visibleKnowledge.plans.filter((plan) => !linkedPlanIds.has(plan.id));
  const mobile = useMobileAppActions();
  const openProjectKnowledgePlan = useUIStore((state) => state.openProjectKnowledgePlan);
  const openLinkedPlan = (plan: ProjectPlanLink) => {
    if (!projectRef || !directory) return;
    if (mobile) mobile.openPlan({ id: plan.id, title: plan.title, projectRef });
    else openProjectKnowledgePlan(directory, resolveProjectContextId(projectRef), plan.id);
  };

  const runtimeApis = React.useContext(RuntimeAPIContext);
  const leaveWorkStatus = useLeaveWorkStatus();
  const openLoadedSkill = (skill: LoadedSkill) => {
    const target = resolveLoadedSkillTarget(skill, installedSkills);
    if (target.kind === 'settings') {
      openSkillSettings(target.name);
      leaveWorkStatus?.();
      return;
    }
    const ui = useUIStore.getState();
    if (runtimeApis?.editor) {
      void runtimeApis.editor.openFile(target.path);
      return;
    }
    if (!directory) return;
    ui.openContextFile(directory, target.path);
    mobile?.openFiles();
  };

  const memoryCount = visibleKnowledge.memory.global + visibleKnowledge.memory.project;
  const pinnedCount = visibleKnowledge.notes.length + visibleKnowledge.plans.length;

  const urlMatcher = useRepositoryUrlMatcher();
  const linked = React.useMemo(() => getDistinctLinkedIssues(session, urlMatcher), [session, urlMatcher]);
  const repositoryChanges = React.useMemo(
    () => getLinkedSidebarChanges(session, urlMatcher).flatMap((change) => (
      change.repository ? [{ ref: change.repository, item: repositoryThread('pull', change.repository), url: change.url, title: change.title }] : []
    )),
    [session, urlMatcher],
  );
  const linkedSidebarIssues = React.useMemo(() => getLinkedSidebarIssues(session, urlMatcher), [session, urlMatcher]);
  const repositoryIssueRefs = React.useMemo(
    () => linkedSidebarIssues.flatMap((issue) => (issue.source === 'repository' ? [issue.ref] : [])),
    [linkedSidebarIssues],
  );
  const repositoryIssueItems = React.useMemo(() => repositoryIssueRefs.map((ref) => repositoryThread(ref.thread, ref)), [repositoryIssueRefs]);
  const linkedTrackerEntries = React.useMemo(
    () => linkedSidebarIssues.flatMap((issue) => (issue.source === 'tracker' ? [{ key: issue.key, identifier: issue.identifier, item: workItem(issue.provider, issue.identifier) }] : [])),
    [linkedSidebarIssues],
  );
  const linkedWorkItems = React.useMemo(() => linkedTrackerEntries.map((entry) => entry.item), [linkedTrackerEntries]);
  const trackedItems = React.useMemo(() => [
    ...repositoryChanges.map((link) => link.item),
    ...repositoryIssueItems,
    ...linkedWorkItems,
  ], [linkedWorkItems, repositoryChanges, repositoryIssueItems]);
  useTrackedItems(trackedItems);
  const changeSummaries = useTrackedPullVisualSummaries(repositoryChanges);
  const repositoryIssueStates = useTrackedIssueStates(repositoryIssueItems);
  const linkedWorkItemStates = useTrackedWorkItemStates(linkedWorkItems);
  const gitDirectory = useEffectiveGitDirectory(directory);
  const branch = useGitStore(React.useCallback(
    (state) => (gitDirectory ? state.directories.get(gitDirectory)?.status?.current?.trim() || null : null),
    [gitDirectory],
  ));
  const branchPrSummary = useFreshestSourceControlVisualSummaryForBranch(gitDirectory, branch);
  const liveLookById = React.useMemo(() => {
    const looks = new Map<string, { color: string; reference: string; status: string | null }>();
    const changeLook = (summary: PrVisualSummary, ref: RepositoryThreadRef) => {
      const descriptor = urlMatcher.descriptorOf(ref.provider);
      const reference = formatChangeRequestReference(descriptor, ref.number);
      const label = getPrStatusLabel(summary, descriptor.terminology.changeRequest, t);
      return { color: `var(--pr-${summary.visualState})`, reference, status: label };
    };
    repositoryChanges.forEach(({ ref }, index) => {
      const summary = changeSummaries[index];
      if (summary) looks.set(ref.key, changeLook(summary, ref));
    });
    repositoryIssueRefs.forEach((ref, index) => {
      const state = repositoryIssueStates[index];
      if (!state) return;
      const look = getIssueStateLook(state.state);
      const identifier = `${urlMatcher.descriptorOf(ref.provider).terminology.issuePrefix}${ref.number}`;
      looks.set(ref.key, { color: look.color, reference: identifier, status: t(look.statusKey) });
    });
    linkedTrackerEntries.forEach(({ key, identifier }, index) => {
      const state = linkedWorkItemStates[index];
      if (!state) return;
      looks.set(key.toLowerCase(), {
        color: getTrackerItemStateLook(state.state.category).color,
        reference: identifier,
        status: state.state.name,
      });
    });
    if (branchPrSummary?.repo) {
      const owner = branchPrSummary.repo.owner.toLowerCase();
      const repo = branchPrSummary.repo.repo.toLowerCase();
      const match = repositoryChanges.find(({ ref }) => (
        ref.provider === branchPrSummary.provider && ref.number === branchPrSummary.number
        && ref.owner.toLowerCase() === owner && ref.repo.toLowerCase() === repo
      ));
      if (match) looks.set(match.ref.key, changeLook(branchPrSummary, match.ref));
    }
    return looks;
  }, [branchPrSummary, changeSummaries, linkedTrackerEntries, linkedWorkItemStates, repositoryChanges, repositoryIssueRefs, repositoryIssueStates, t, urlMatcher]);
  const openTrackerItem = useOpenTrackerItem();
  const copyLink = useCopyReferenceLink();
  const trackerDescriptors = useTrackerDescriptors();
  const mcpCount = React.useMemo(
    () => Object.values(mcpStatus ?? {}).filter((entry) => entry?.status.status === 'connected').length,
    [mcpStatus],
  );

  useReportWorkStatusPresence(
    'context-sources',
    linked.length > 0 || linkedPlans.length > 0 || loadedSkills.length > 0 || skills.length > 0 || mcpCount > 0 || pinnedCount > 0 || memoryCount > 0,
  );

  if (linked.length === 0 && linkedPlans.length === 0 && loadedSkills.length === 0 && skills.length === 0 && mcpCount === 0 && pinnedCount === 0 && memoryCount === 0) {
    return null;
  }

  const linkedChanges = linked.filter(isLinkedChange);
  const prCount = linkedChanges.length;
  const changeTerms = new Set(linkedChanges.map((entry) => {
    const ref = getRepositoryThreadRef(entry, urlMatcher);
    return ref ? urlMatcher.descriptorOf(ref.provider).terminology.changeRequest : 'pullRequest';
  }));
  const changeTerm: ChangeRequestTerm = changeTerms.size === 1 ? [...changeTerms][0] : 'pullRequest';
  const issueCount = linked.length - prCount;
  const summaryParts: string[] = [];
  if (linkedPlans.length > 0) {
    summaryParts.push(linkedPlans.length === 1
      ? t('chat.workStatus.breakdown.planCountSingle', { count: linkedPlans.length })
      : t('chat.workStatus.breakdown.planCountPlural', { count: linkedPlans.length }));
  }
  if (issueCount > 0) {
    summaryParts.push(issueCount === 1
      ? t('chat.workStatus.breakdown.issueCountSingle', { count: issueCount })
      : t('chat.workStatus.breakdown.issueCountPlural', { count: issueCount }));
  }
  if (prCount > 0) {
    summaryParts.push(prCount === 1
      ? t(changeRequestCopy('chat.workStatus.breakdown.prCountSingle', changeTerm), { count: prCount })
      : t(changeRequestCopy('chat.workStatus.breakdown.prCountPlural', changeTerm), { count: prCount }));
  }
  if (summaryParts.length === 0 && pinnedCount > 0) {
    summaryParts.push(pinnedCount === 1
      ? t('chat.workStatus.breakdown.pinnedKnowledgeSingle', { count: pinnedCount })
      : t('chat.workStatus.breakdown.pinnedKnowledgePlural', { count: pinnedCount }));
  }
  if (summaryParts.length === 0) {
    if (skills.length > 0) {
      summaryParts.push(skills.length === 1
        ? t('chat.workStatus.breakdown.skillCountSingle', { count: skills.length })
        : t('chat.workStatus.breakdown.skillCountPlural', { count: skills.length }));
    }
    if (mcpCount > 0) {
      summaryParts.push(mcpCount === 1
        ? t('chat.workStatus.breakdown.mcpCountSingle', { count: mcpCount })
        : t('chat.workStatus.breakdown.mcpCountPlural', { count: mcpCount }));
    }
  }

  const liveLookOf = (entry: (typeof linked)[number]) => {
    if (entry.kind === 'tracker') return liveLookById.get(entry.id.toLowerCase());
    const ref = getRepositoryThreadRef(entry, urlMatcher);
    return ref ? liveLookById.get(ref.key) : undefined;
  };
  const renderedIdentifier = (entry: (typeof linked)[number]) => {
    const ref = getRepositoryThreadRef(entry, urlMatcher);
    if (ref) {
      const descriptor = urlMatcher.descriptorOf(ref.provider);
      return ref.thread === 'pull' ? formatChangeRequestReference(descriptor, ref.number) : `${descriptor.terminology.issuePrefix}${ref.number}`;
    }
    return entry.kind === 'tracker' || entry.kind === 'guest' || entry.kind === 'external' ? entry.identifier : `#${entry.number}`;
  };
  const openLinkedAriaLabel = (entry: Extract<(typeof linked)[number], { kind: 'issue' | 'pull' }>) => {
    const ref = getRepositoryThreadRef(entry, urlMatcher);
    return ref
      ? t('chat.workStatus.linkedIssues.openOnProvider', { reference: renderedIdentifier(entry), provider: urlMatcher.descriptorOf(ref.provider).label })
      : t('chat.workStatus.linkedIssues.openGuest', { id: renderedIdentifier(entry) });
  };
  const trackerNameOf = (provider: string) => trackerDescriptors.find((descriptor) => descriptor.id === provider)?.name ?? provider;
  const renderLinkedIcon = (entry: (typeof linked)[number]) => {
    const color = liveLookOf(entry)?.color;
    return (
      <Icon
        name={isLinkedChange(entry) ? 'git-pull-request' : entry.kind === 'tracker' ? trackerPresentation(entry.provider).icon : 'record-circle'}
        className={cn('size-[13px] shrink-0', color ? 'oc-ref-tint' : 'text-muted-foreground')}
        style={color ? refTintStyle(color) : undefined}
      />
    );
  };
  const renderLinkedLabel = (entry: (typeof linked)[number]) => {
    const look = liveLookOf(entry);
    const identifier = renderedIdentifier(entry);
    return (
      <>
        <span className={cn('tabular-nums', look && 'oc-ref-tint')} style={look ? refTintStyle(look.color) : undefined}>
          <LinkedReference reference={look?.reference ?? identifier} status={look?.status} url={entry.url} directory={directory} />
        </span>
        {entry.title ? <> · <span dir="auto">{entry.title}</span></> : null}
      </>
    );
  };

  const renderUnpinButton = (unpin: () => void) => (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="pointer-events-auto inline-flex shrink-0">
          <button
            type="button"
            disabled={!isDraft && (!sessionId || !directory)}
            aria-label={t('chat.workStatus.breakdown.unpin')}
            onClick={(event) => {
              event.stopPropagation();
              unpin();
            }}
            className="-m-0.5 shrink-0 rounded p-0.5 opacity-70 transition-opacity hover:opacity-100 disabled:opacity-40"
          >
            <Icon name="pushpin-2-fill" className="size-[13px]" style={{ color: 'var(--primary)' }} />
          </button>
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>{t('chat.workStatus.breakdown.unpin')}</TooltipContent>
    </Tooltip>
  );

  return (
    <WorkStatusCollapsibleSection
      id="context-sources"
      title={t('chat.workStatus.section.contextBreakdown')}
      icon="stack"
      summary={summaryParts.join(' · ')}
    >
      {linkedPlans.map((plan) => (
        <WorkStatusRow
          key={`plan:${plan.id}`}
          muted
          leading={pinnedPlanIds.has(plan.id)
            ? renderUnpinButton(() => unpinPlan(plan.id))
            : <Icon name="file-text" className="size-[13px] shrink-0 text-muted-foreground" />}
          label={<span dir="auto">{plan.title}</span>}
          tooltip={plan.title}
          onClick={projectRef && directory ? () => {
            openLinkedPlan(plan);
            leaveWorkStatus?.();
          } : undefined}
          ariaLabel={t('chat.workStatus.linkedPlans.open', { title: plan.title })}
          value={plan.progress ? (
            plan.progress.done >= plan.progress.total
              ? <WorkStatusValue tone="success">{t('rightSidebar.contextNotesTodo.plans.progress.done')}</WorkStatusValue>
              : <WorkStatusValue tone="muted">{`${plan.progress.done}/${plan.progress.total}`}</WorkStatusValue>
          ) : <WorkStatusValue tone="muted">{t('chat.workStatus.breakdown.pinnedPlan')}</WorkStatusValue>}
        />
      ))}

      {linked.map((entry) => (
        <WorkStatusRow
          key={entry.id}
          leading={renderLinkedIcon(entry)}
          label={renderLinkedLabel(entry)}
          tooltip={entry.title ? renderLinkedLabel(entry) : undefined}
          muted
          onClick={(event) => {
            if (openTrackerItem(entry.url, directory, event) !== 'guest-panel') leaveWorkStatus?.();
          }}
          className="group/linked"
          value={(
            <>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label={t('references.link.copy')}
                    onClick={(event) => {
                      event.stopPropagation();
                      copyLink(entry.url);
                    }}
                    className="hidden shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground group-focus-within/linked:block group-hover/linked:block pointer-coarse:block pointer-coarse:p-2"
                  >
                    <Icon name="link" className="size-[13px]" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top" sideOffset={4}>{t('references.link.copy')}</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="pointer-events-auto inline-flex shrink-0">
                    <button
                      type="button"
                      disabled={!sessionId || !directory}
                      aria-label={t('chat.workStatus.linkedIssues.unlink')}
                      onClick={(event) => {
                        event.stopPropagation();
                        unlinkLinkedThread(entry);
                      }}
                      className="shrink-0 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40 disabled:hover:text-muted-foreground pointer-coarse:p-2"
                    >
                      <Icon name="close" className="size-[13px]" />
                    </button>
                  </span>
                </TooltipTrigger>
                <TooltipContent side="top" sideOffset={4}>{t('chat.workStatus.linkedIssues.unlink')}</TooltipContent>
              </Tooltip>
            </>
          )}
          ariaLabel={entry.kind === 'tracker'
            ? t('chat.workStatus.linkedIssues.openTrackerItem', { identifier: entry.identifier, provider: trackerNameOf(entry.provider) })
            : entry.kind === 'guest' || entry.kind === 'external'
              ? t('chat.workStatus.linkedIssues.openGuest', { id: entry.identifier })
              : openLinkedAriaLabel(entry)}
        />
      ))}

      {visibleKnowledge.notes.map((note) => (
        <WorkStatusRow
          key={note.id}
          muted
          leading={renderUnpinButton(() => unpinNote(note.id))}
          label={note.body.trim().split('\n')[0] || note.body.trim()}
          value={<WorkStatusValue tone="muted">{t('chat.workStatus.breakdown.pinnedNote')}</WorkStatusValue>}
        />
      ))}
      {pinnedOnlyPlans.map((plan) => (
        <WorkStatusRow
          key={plan.id}
          muted
          leading={renderUnpinButton(() => unpinPlan(plan.id))}
          label={plan.title}
          value={<WorkStatusValue tone="muted">{t('chat.workStatus.breakdown.pinnedPlan')}</WorkStatusValue>}
        />
      ))}
      {loadedSkills.map((skill) => (
        <WorkStatusRow
          key={`skill:${skill.id}`}
          muted
          icon="book"
          label={<span dir="auto">{skill.name}</span>}
          tooltip={skill.name}
          onClick={() => openLoadedSkill(skill)}
          ariaLabel={t('chat.workStatus.loadedSkills.open', { name: skill.name })}
        />
      ))}
      {memoryCount > 0 ? (
        <WorkStatusRow
          muted
          label={t('chat.workStatus.breakdown.memory')}
          value={<WorkStatusValue>{memoryCount}</WorkStatusValue>}
        />
      ) : null}

      <WorkStatusRow
        muted
        label={t('chat.workStatus.breakdown.skills')}
        value={<WorkStatusValue>{skills.length}</WorkStatusValue>}
      />
      <WorkStatusRow
        muted
        label={t('chat.workStatus.breakdown.mcp')}
        value={<WorkStatusValue>{mcpCount}</WorkStatusValue>}
      />
    </WorkStatusCollapsibleSection>
  );
};
