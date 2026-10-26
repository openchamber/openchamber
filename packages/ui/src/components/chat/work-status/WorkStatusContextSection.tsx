import React from 'react';
import { toast } from 'sonner';
import { useI18n } from '@/lib/i18n';
import { Icon } from '@/components/icon/Icon';
import { selectAvailableSkillsForDirectory, useSkillsStore } from '@/stores/useSkillsStore';
import { useMcpStore } from '@/stores/useMcpStore';
import { useSession } from '@/sync/sync-context';
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
import { resolveProjectContextId } from '@/lib/projectContextApi';
import { useConfigStore } from '@/stores/useConfigStore';
import { useOpenTrackerItem } from '@/components/sourceBoard/openTrackerItem';
import { WorkStatusCollapsibleSection, WorkStatusRow, WorkStatusValue } from './WorkStatusPrimitives';
import { useReportWorkStatusPresence } from './presenceContext';
import { resolveDraftPinnedKnowledge } from './draftKnowledge';
import { changeRequestCopy } from '@/lib/source-control/changeRequestCopy';
import { refTintStyle } from '@/lib/source-control/prVisualState';
import { cn } from '@/lib/utils';
import { useLeaveWorkStatus } from './leaveWorkStatus';


type Props = {
  sessionId: string | null;
  directory: string | null;
};

/**
 * What is loaded into the agent's context: the issues and change requests this
 * session was pointed at, plus how much ambient material is available.
 *
 * Agents are deliberately absent — an agent is who does the work, not material
 * the work is done with. Tools are absent for want of an honest source:
 * `Agent.tools` is a per-agent override map, not a registry, so its size would
 * report something other than "tools available".
 */
export const WorkStatusContextSection: React.FC<Props> = ({ sessionId, directory }) => {
  const { t } = useI18n();

  const session = useSession(sessionId ?? '', directory ?? undefined);
  const newSessionDraft = useSessionUIStore((state) => state.newSessionDraft);
  const setDraftProjectContextPin = useSessionUIStore((state) => state.setDraftProjectContextPin);
  const availableWorktreesByProject = useSessionUIStore((state) => state.availableWorktreesByProject);
  const projects = useProjectsStore((state) => state.projects);
  const isDraft = sessionId === null && newSessionDraft.open;
  const skills = useSkillsStore((state) => selectAvailableSkillsForDirectory(state));
  const mcpStatus = useMcpStore(
    React.useCallback((state) => state.getStatusForDirectory(directory), [directory]),
  );

  // Skills were previously fetched only when the composer's slash autocomplete
  // opened, so this row reported whatever count happened to be cached — often
  // none — until the user typed "/". The panel states a count, so it is the
  // panel's business to have one. Re-run per directory because skills are
  // discovered relative to the active project. No background-network wrap
  // here: `loadSkills` already gates its own fetch, and wrapping it again
  // would hold a second slot idle for the length of the first.
  const loadSkills = useSkillsStore((state) => state.loadSkills);
  // `isConnected` is a dependency, not a gate: skills are discovered on the
  // connected instance and their caches are dropped when instances switch, so
  // the count has to be asked for again once the new instance is up. Two
  // instances can hold the same project path, which leaves `directory`
  // unchanged across a switch.
  const isConnected = useConfigStore((state) => state.isConnected);
  React.useEffect(() => {
    void loadSkills();
  }, [directory, isConnected, loadSkills]);

  /**
   * What this session carries. Read from the server
   * rather than from the notes panel's store, because this must be right
   * whether or not that panel has ever been opened.
   */
  const [knowledge, setKnowledge] = React.useState<SessionKnowledgeSummary>(
    { notes: [], plans: [], memory: { global: 0, project: 0 } },
  );

  // Re-read when source content or memory changes, not only when the session does.
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

  React.useEffect(() => {
    let cancelled = false;
    void fetchSessionKnowledgeSummary(directory, sessionId).then((summary) => {
      if (!cancelled) setKnowledge(summary);
    });
    return () => { cancelled = true; };
  }, [directory, sessionId, session, contextEntries, memoryProject, memoryGlobal]);

  const visibleKnowledge = React.useMemo<SessionKnowledgeSummary>(() => {
    if (!isDraft) return knowledge;
    const pinned = resolveDraftPinnedKnowledge(
      draftContextEntry?.notes ?? [],
      draftContextEntry?.plans ?? [],
      newSessionDraft.projectContextPins ?? { notes: [], plans: [] },
    );
    return { ...knowledge, ...pinned };
  }, [draftContextEntry?.notes, draftContextEntry?.plans, isDraft, knowledge, newSessionDraft.projectContextPins]);

  // Unpinning from here, like the pinned-messages section: a panel that says
  // what is attached should be able to detach it, or the user has to go find
  // the surface that can.
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

  // Removing a linked thread, like unpinning: the panel that says what the
  // session carries is the one that can take it back off, or an agent's link
  // would be permanent unless metadata were edited by hand. The write is the
  // same metadata patch the attach flows use, so the row leaves when the
  // session's stored list loses the entry.
  const unlinkLinkedThread = React.useCallback((issue: LinkedIssue) => {
    if (!directory || !sessionId) return;
    void sessionActions.setLinkedIssue(sessionId, directory, issue, false).catch(() => {
      toast.error(t('chat.workStatus.linkedIssues.unlinkFailed'));
    });
  }, [directory, sessionId, t]);

  const memoryCount = visibleKnowledge.memory.global + visibleKnowledge.memory.project;
  const pinnedCount = visibleKnowledge.notes.length + visibleKnowledge.plans.length;

  const urlMatcher = useRepositoryUrlMatcher();
  const linked = React.useMemo(() => getDistinctLinkedIssues(session, urlMatcher), [session, urlMatcher]);
  // Live state of the session's linked change requests and issues, from the
  // server's tracked items. This panel follows its own session too: the
  // session need not be on screen in the sidebar.
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
  // The pull request of the branch checked out here, read-only as in the
  // repository readout. When it is also linked, its row shows this state, as
  // the sidebar row does: a full status read carries more than a live summary,
  // and the linked item's own state may not have arrived yet.
  const gitDirectory = useEffectiveGitDirectory(directory);
  const branch = useGitStore(React.useCallback(
    (state) => (gitDirectory ? state.directories.get(gitDirectory)?.status?.current?.trim() || null : null),
    [gitDirectory],
  ));
  const branchPrSummary = useFreshestSourceControlVisualSummaryForBranch(gitDirectory, branch);
  // Repository thread key, or a tracker entry's id (`linear:ENG-12`) lowercased -> the coloured status line.
  const liveLookById = React.useMemo(() => {
    const looks = new Map<string, { color: string; text: string }>();
    const changeLook = (summary: PrVisualSummary, ref: RepositoryThreadRef) => {
      const descriptor = urlMatcher.descriptorOf(ref.provider);
      const reference = formatChangeRequestReference(descriptor, ref.number);
      const label = getPrStatusLabel(summary, descriptor.terminology.changeRequest, t);
      return { color: `var(--pr-${summary.visualState})`, text: label ? `${reference} · ${label}` : reference };
    };
    // A summary belongs to the link at its own index: the same owner/repo#number
    // can be linked from two instances in one session, and only the position
    // tells those two apart.
    repositoryChanges.forEach(({ ref }, index) => {
      const summary = changeSummaries[index];
      if (summary) looks.set(ref.key, changeLook(summary, ref));
    });
    repositoryIssueRefs.forEach((ref, index) => {
      const state = repositoryIssueStates[index];
      if (!state) return;
      const look = getIssueStateLook(state.state);
      const identifier = `${urlMatcher.descriptorOf(ref.provider).terminology.issuePrefix}${ref.number}`;
      looks.set(ref.key, { color: look.color, text: `${identifier} · ${t(look.statusKey)}` });
    });
    // A tracker shows its own state name; the colour comes from its category.
    linkedTrackerEntries.forEach(({ key, identifier }, index) => {
      const state = linkedWorkItemStates[index];
      if (!state) return;
      looks.set(key.toLowerCase(), {
        color: getTrackerItemStateLook(state.state.category).color,
        text: `${identifier} · ${state.state.name}`,
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
  const leaveWorkStatus = useLeaveWorkStatus();
  const trackerDescriptors = useTrackerDescriptors();
  // Connected servers only. A disabled server contributes nothing to the
  // context, so counting it here contradicts the MCP section right above,
  // which shows the same servers switched off.
  const mcpCount = React.useMemo(
    () => Object.values(mcpStatus ?? {}).filter((entry) => entry?.status.status === 'connected').length,
    [mcpStatus],
  );

  useReportWorkStatusPresence(
    'context-sources',
    linked.length > 0 || skills.length > 0 || mcpCount > 0 || pinnedCount > 0 || memoryCount > 0,
  );

  if (linked.length === 0 && skills.length === 0 && mcpCount === 0 && pinnedCount === 0 && memoryCount === 0) {
    return null;
  }

  // The heading names what is distinctive about this session when there is
  // something — an attached thread — and falls back to the ambient counts
  // when there is not. `1 · 33 · 2` said nothing without opening the section.
  const linkedChanges = linked.filter(isLinkedChange);
  const prCount = linkedChanges.length;
  // A provider's own word only when every attached change shares it.
  const changeTerms = new Set(linkedChanges.map((entry) => {
    const ref = getRepositoryThreadRef(entry, urlMatcher);
    return ref ? urlMatcher.descriptorOf(ref.provider).terminology.changeRequest : 'pullRequest';
  }));
  const changeTerm: ChangeRequestTerm = changeTerms.size === 1 ? [...changeTerms][0] : 'pullRequest';
  const issueCount = linked.length - prCount;
  const summaryParts: string[] = [];
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
  // Pinned knowledge outranks ambient counts because the user chose it for this session.
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

  // Identifier and state lead, the title follows and is what truncates: the
  // number and state are what tell links apart, as in the sidebar. A GitHub
  // thread with a known state shows it in the sidebar's colours; anything
  // else keeps the plain muted identifier.
  // Keyed by the repository thread, so an extension's link to a change request
  // shows the same live state as a direct one.
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
    // A link no served provider recognises names no provider.
    return ref
      ? t('chat.workStatus.linkedIssues.openOnProvider', { reference: renderedIdentifier(entry), provider: urlMatcher.descriptorOf(ref.provider).label })
      : t('chat.workStatus.linkedIssues.openGuest', { id: renderedIdentifier(entry) });
  };
  const trackerNameOf = (provider: string) => trackerDescriptors.find((descriptor) => descriptor.id === provider)?.name ?? provider;
  // The kind, never the author: an agent's link has no avatar, and a mix of
  // faces and icons hid which row was a PR. An issue reads as an issue
  // wherever it lives (GitHub, GitLab, an agent's or an extension's link) and
  // wears its state's colour, muted, as on a sidebar row.
  const renderLinkedIcon = (entry: (typeof linked)[number]) => {
    const color = liveLookOf(entry)?.color;
    return (
      <Icon
        name={isLinkedChange(entry) ? 'git-pull-request' : entry.kind === 'tracker' ? trackerPresentation(entry.provider).icon : 'record-circle'}
        className={cn('size-3.5 shrink-0', color ? 'oc-ref-tint' : 'text-muted-foreground')}
        style={color ? refTintStyle(color) : undefined}
      />
    );
  };
  const renderLinkedLabel = (entry: (typeof linked)[number]) => {
    const look = liveLookOf(entry);
    const identifier = renderedIdentifier(entry);
    return (
      <>
        <span className={cn('tabular-nums', look && 'oc-ref-tint')} style={look ? refTintStyle(look.color) : undefined}>{look ? look.text : identifier}</span>
        {entry.title ? <> · {entry.title}</> : null}
      </>
    );
  };

  return (
    <WorkStatusCollapsibleSection
      id="context-sources"
      title={t('chat.workStatus.section.contextBreakdown')}
      icon="stack"
      summary={summaryParts.join(' · ')}
    >
      {/* Attached threads first: they are specific to this session, while the
          counts below describe the workspace. */}
      {linked.map((entry) => (
        <WorkStatusRow
          key={entry.id}
          leading={renderLinkedIcon(entry)}
          label={renderLinkedLabel(entry)}
          // The title truncates in a narrow panel; the full one shows on hover.
          tooltip={entry.title ? renderLinkedLabel(entry) : undefined}
          muted
          // In the Tracker, read through this session's project; Cmd or Ctrl,
          // and anything the app cannot show, opens the link.
          onClick={(event) => {
            openTrackerItem(entry.url, directory, event);
            leaveWorkStatus?.();
          }}
          // The panel that shows what a session carries is the one that can
          // take an item back off; a pinned row's control is the precedent.
          // This sits in the trailing value slot, where row actions live.
          value={(
            <button
              type="button"
              disabled={!sessionId || !directory}
              aria-label={t('chat.workStatus.linkedIssues.unlink')}
              onClick={(event) => {
                event.stopPropagation();
                unlinkLinkedThread(entry);
              }}
              className="shrink-0 rounded p-0.5 text-muted-foreground/60 transition-colors hover:text-foreground disabled:opacity-40 disabled:hover:text-muted-foreground/60"
            >
              <Icon name="close" className="size-3.5" />
            </button>
          )}
          ariaLabel={entry.kind === 'tracker'
            ? t('chat.workStatus.linkedIssues.openTrackerItem', { identifier: entry.identifier, provider: trackerNameOf(entry.provider) })
            : entry.kind === 'guest' || entry.kind === 'external'
              ? t('chat.workStatus.linkedIssues.openGuest', { id: entry.identifier })
              : openLinkedAriaLabel(entry)}
        />
      ))}

      {/* Named individually: a count alone would not identify this session's context. */}
      {/* The pin is the control, exactly as in the pinned-messages section
          above: same icon, same placement, same behaviour. Two pins that look
          different in one panel would read as two different things. */}
      {visibleKnowledge.notes.map((note) => (
        <WorkStatusRow
          key={note.id}
          muted
          leading={(
            <button
              type="button"
              disabled={!isDraft && (!sessionId || !directory)}
              aria-label={t('chat.workStatus.breakdown.unpin')}
              onClick={(event) => {
                event.stopPropagation();
                unpinNote(note.id);
              }}
              className="-m-0.5 shrink-0 rounded p-0.5 opacity-70 transition-opacity hover:opacity-100 disabled:opacity-40"
            >
              <Icon name="pushpin-2-fill" className="size-3.5" style={{ color: 'var(--primary)' }} />
            </button>
          )}
          label={note.body.trim().split('\n')[0] || note.body.trim()}
          value={<WorkStatusValue tone="muted">{t('chat.workStatus.breakdown.pinnedNote')}</WorkStatusValue>}
        />
      ))}
      {visibleKnowledge.plans.map((plan) => (
        <WorkStatusRow
          key={plan.id}
          muted
          leading={(
            <button
              type="button"
              disabled={!isDraft && (!sessionId || !directory)}
              aria-label={t('chat.workStatus.breakdown.unpin')}
              onClick={(event) => {
                event.stopPropagation();
                unpinPlan(plan.id);
              }}
              className="-m-0.5 shrink-0 rounded p-0.5 opacity-70 transition-opacity hover:opacity-100 disabled:opacity-40"
            >
              <Icon name="pushpin-2-fill" className="size-3.5" style={{ color: 'var(--primary)' }} />
            </button>
          )}
          label={plan.title}
          value={<WorkStatusValue tone="muted">{t('chat.workStatus.breakdown.pinnedPlan')}</WorkStatusValue>}
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
