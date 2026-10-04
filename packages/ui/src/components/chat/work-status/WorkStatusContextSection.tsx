import React from 'react';
import { useI18n } from '@/lib/i18n';
import { Icon } from '@/components/icon/Icon';
import { useSkillsStore } from '@/stores/useSkillsStore';
import { useMcpStore } from '@/stores/useMcpStore';
import { useSession } from '@/sync/sync-context';
import { getDistinctLinkedIssues, getLinkedGitHubPullRequests, getLinkedGitLabThreads, getLinkedSidebarIssues, canOpenLinearIssueInContextPanel, getGitHubThreadRef, getGitLabThreadRef, isLinkedChange } from '@/lib/linkedIssues';
import type { PrVisualSummary } from '@/stores/useGitHubPrStatusStore';
import { useTrackedIssueStates, useTrackedLinearStates, useTrackedPullVisualSummaries } from '@/stores/useTrackedItemsStore';
import { useTrackedItems } from '@/lib/trackedItems/interest';
import { githubThread, gitlabThread, linearIssue } from '@/lib/trackedItems/fromLinks';
import { getPrStatusLabel } from '@/components/session/sidebar/prStatusLabel';
import { getIssueStateLook, getLinearIssueStateLook } from '@/components/session/sidebar/sessions/sessionPrSummaries';
import { fetchSessionKnowledgeSummary, setSessionProjectContextPin, type SessionKnowledgeSummary } from '@/lib/sessionKnowledgeApi';
import { useProjectContextStore } from '@/stores/useProjectContextStore';
import { useAgentMemoryStore } from '@/stores/useAgentMemoryStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { resolveProjectForSessionDirectory } from '@/lib/projectResolution';
import { resolveProjectContextId } from '@/lib/projectContextApi';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useMobileAppActions } from '@/apps/mobileAppContext';
import { useLinearAuthStore } from '@/stores/useLinearAuthStore';
import { useConfigStore } from '@/stores/useConfigStore';
import { useUIStore } from '@/stores/useUIStore';
import { WorkStatusCollapsibleSection, WorkStatusRow, WorkStatusValue } from './WorkStatusPrimitives';
import { useReportWorkStatusPresence } from './presenceContext';
import { resolveDraftPinnedKnowledge } from './draftKnowledge';
import { changeRequestCopy } from '@/lib/source-control/changeRequestCopy';


type Props = {
  sessionId: string | null;
  directory: string | null;
};

/**
 * What is loaded into the agent's context: the GitHub threads this session was
 * pointed at, plus how much ambient material is available.
 *
 * Agents are deliberately absent — an agent is who does the work, not material
 * the work is done with. Tools are absent for want of an honest source:
 * `Agent.tools` is a per-agent override map, not a registry, so its size would
 * report something other than "tools available".
 */
export const WorkStatusContextSection: React.FC<Props> = ({ sessionId, directory }) => {
  const { t } = useI18n();
  const { linear } = useRuntimeAPIs();
  const linearConnected = useLinearAuthStore((state) => state.status?.connected === true);
  const mobileActions = useMobileAppActions();
  const openContextPanelTab = useUIStore((state) => state.openContextPanelTab);
  const setLinearIssueFocus = useUIStore((state) => state.setLinearIssueFocus);

  const session = useSession(sessionId ?? '', directory ?? undefined);
  const newSessionDraft = useSessionUIStore((state) => state.newSessionDraft);
  const setDraftProjectContextPin = useSessionUIStore((state) => state.setDraftProjectContextPin);
  const availableWorktreesByProject = useSessionUIStore((state) => state.availableWorktreesByProject);
  const projects = useProjectsStore((state) => state.projects);
  const isDraft = sessionId === null && newSessionDraft.open;
  const skills = useSkillsStore((state) => state.skills);
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

  const memoryCount = visibleKnowledge.memory.global + visibleKnowledge.memory.project;
  const pinnedCount = visibleKnowledge.notes.length + visibleKnowledge.plans.length;

  const linked = React.useMemo(() => getDistinctLinkedIssues(session), [session]);
  // Live state of the session's linked PRs, merge requests and issues, from
  // the server's tracked items. This panel follows its own session too: the
  // session need not be on screen in the sidebar.
  const linkedPrs = React.useMemo(() => getLinkedGitHubPullRequests(session), [session]);
  const linkedPullLinks = React.useMemo(
    () => linkedPrs.map((link) => ({ item: githubThread('pull', link), url: link.url, title: link.title })),
    [linkedPrs],
  );
  const linkedIssueRefs = React.useMemo(
    () => getLinkedSidebarIssues(session).flatMap((issue) => (issue.source === 'github' ? [{ owner: issue.owner, repo: issue.repo, number: issue.number }] : [])),
    [session],
  );
  const linkedIssueItems = React.useMemo(() => linkedIssueRefs.map((ref) => githubThread('issue', ref)), [linkedIssueRefs]);
  const linkedLinearIdentifiers = React.useMemo(
    () => getLinkedSidebarIssues(session).flatMap((issue) => (issue.source === 'linear' ? [issue.identifier] : [])),
    [session],
  );
  const linkedLinearItems = React.useMemo(() => linkedLinearIdentifiers.map(linearIssue), [linkedLinearIdentifiers]);
  const linkedGitLab = React.useMemo(() => getLinkedGitLabThreads(session), [session]);
  const linkedGitLabChanges = React.useMemo(() => {
    const byKey = new Map(linked.flatMap((entry) => {
      const ref = getGitLabThreadRef(entry);
      return ref ? [[ref.key, entry] as const] : [];
    }));
    return linkedGitLab.filter((ref) => ref.thread === 'pull')
      .map((ref) => ({ ref, item: gitlabThread('pull', ref), url: byKey.get(ref.key)?.url ?? '', title: byKey.get(ref.key)?.title ?? '' }));
  }, [linked, linkedGitLab]);
  const linkedGitLabIssues = React.useMemo(() => linkedGitLab.filter((ref) => ref.thread === 'issue'), [linkedGitLab]);
  const linkedGitLabIssueItems = React.useMemo(() => linkedGitLabIssues.map((ref) => gitlabThread('issue', ref)), [linkedGitLabIssues]);
  const trackedItems = React.useMemo(() => [
    ...linkedPullLinks.map((link) => link.item),
    ...linkedIssueItems,
    ...linkedLinearItems,
    ...linkedGitLabChanges.map((link) => link.item),
    ...linkedGitLabIssueItems,
  ], [linkedGitLabChanges, linkedGitLabIssueItems, linkedIssueItems, linkedLinearItems, linkedPullLinks]);
  useTrackedItems(trackedItems);
  const linkedPullVisuals = useTrackedPullVisualSummaries(linkedPullLinks);
  const linkedPrSummaries = React.useMemo(
    () => linkedPullVisuals.filter((summary): summary is PrVisualSummary => summary !== null),
    [linkedPullVisuals],
  );
  const linkedIssueStates = useTrackedIssueStates(linkedIssueItems);
  const linkedLinearStates = useTrackedLinearStates(linkedLinearItems);
  const gitlabChangeSummaries = useTrackedPullVisualSummaries(linkedGitLabChanges);
  const gitlabIssueStates = useTrackedIssueStates(linkedGitLabIssueItems);
  // Entry id (`owner/repo#number`, lowercased) -> the coloured status line.
  const liveLookById = React.useMemo(() => {
    const looks = new Map<string, { color: string; text: string }>();
    for (const summary of linkedPrSummaries) {
      const label = getPrStatusLabel(summary, t);
      looks.set(`${summary.repo?.owner ?? ''}/${summary.repo?.repo ?? ''}#${summary.number}`.toLowerCase(), {
        color: `var(--pr-${summary.visualState})`,
        text: label ? `#${summary.number} · ${label}` : `#${summary.number}`,
      });
    }
    linkedIssueRefs.forEach((ref, index) => {
      const state = linkedIssueStates[index];
      if (!state) return;
      const look = getIssueStateLook(state.state);
      looks.set(`${ref.owner}/${ref.repo}#${ref.number}`.toLowerCase(), {
        color: look.color,
        text: `#${ref.number} · ${t(look.statusKey)}`,
      });
    });
    // Linear shows its team's own state name; the colour comes from its type.
    linkedLinearIdentifiers.forEach((identifier, index) => {
      const state = linkedLinearStates[index];
      if (!state) return;
      looks.set(`linear:${identifier}`.toLowerCase(), {
        color: getLinearIssueStateLook(state.state.type).color,
        text: `${identifier} · ${state.state.name}`,
      });
    });
    linkedGitLabChanges.forEach(({ ref }, index) => {
      const summary = gitlabChangeSummaries[index];
      if (!summary) return;
      const label = getPrStatusLabel(summary, t);
      looks.set(ref.key, {
        color: `var(--pr-${summary.visualState})`,
        text: label ? `!${ref.number} · ${label}` : `!${ref.number}`,
      });
    });
    linkedGitLabIssues.forEach((ref, index) => {
      const state = gitlabIssueStates[index];
      if (!state) return;
      const look = getIssueStateLook(state.state);
      looks.set(ref.key, { color: look.color, text: `#${ref.number} · ${t(look.statusKey)}` });
    });
    return looks;
  }, [gitlabChangeSummaries, gitlabIssueStates, linkedGitLabChanges, linkedGitLabIssues, linkedIssueRefs, linkedIssueStates, linkedLinearIdentifiers, linkedLinearStates, linkedPrSummaries, t]);
  const openLinkedIssue = React.useCallback((entry: (typeof linked)[number]) => {
    if (
      entry.kind === 'linear'
      && directory
      && canOpenLinearIssueInContextPanel({
        linearAvailable: Boolean(linear),
        linearConnected,
        inDedicatedMobileShell: mobileActions != null,
        directory,
      })
    ) {
      setLinearIssueFocus(entry.identifier);
      openContextPanelTab(directory, { mode: 'linear' });
      return;
    }
    window.open(entry.url, '_blank', 'noopener,noreferrer');
  }, [directory, linear, linearConnected, mobileActions, openContextPanelTab, setLinearIssueFocus]);
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
  // GitLab's word only when every attached change is a GitLab merge request.
  const changeProvider = linkedChanges.length > 0 && linkedChanges.every((entry) => getGitLabThreadRef(entry))
    ? 'gitlab' as const
    : 'github' as const;
  const issueCount = linked.length - prCount;
  const summaryParts: string[] = [];
  if (issueCount > 0) {
    summaryParts.push(issueCount === 1
      ? t('chat.workStatus.breakdown.issueCountSingle', { count: issueCount })
      : t('chat.workStatus.breakdown.issueCountPlural', { count: issueCount }));
  }
  if (prCount > 0) {
    summaryParts.push(prCount === 1
      ? t(changeRequestCopy('chat.workStatus.breakdown.prCountSingle', changeProvider), { count: prCount })
      : t(changeRequestCopy('chat.workStatus.breakdown.prCountPlural', changeProvider), { count: prCount }));
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
  // Keyed by the GitHub thread, so an extension's link to a github.com PR
  // shows the same live state as a direct one.
  const liveLookOf = (entry: (typeof linked)[number]) => {
    if (entry.kind === 'linear') return liveLookById.get(entry.id.toLowerCase());
    const ref = getGitHubThreadRef(entry);
    if (ref) return liveLookById.get(ref.key.toLowerCase());
    const gitlab = getGitLabThreadRef(entry);
    return gitlab ? liveLookById.get(gitlab.key) : undefined;
  };
  const renderedIdentifier = (entry: (typeof linked)[number]) => {
    const ref = getGitHubThreadRef(entry);
    const gitlab = ref ? null : getGitLabThreadRef(entry);
    return ref ? `#${ref.number}`
      : gitlab ? `${gitlab.thread === 'pull' ? '!' : '#'}${gitlab.number}`
        : entry.kind === 'linear' || entry.kind === 'guest' || entry.kind === 'external' ? entry.identifier : `#${entry.number}`;
  };
  const renderLinkedLabel = (entry: (typeof linked)[number]) => {
    const look = liveLookOf(entry);
    const identifier = renderedIdentifier(entry);
    return (
      <>
        <span className="tabular-nums" style={look ? { color: look.color } : undefined}>{look ? look.text : identifier}</span>
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
          // The kind, never the author: an agent's link has no avatar, and a
          // mix of faces and icons hid which row was a PR.
          // An issue reads as an issue wherever it lives — GitHub, GitLab, an
          // agent's or an extension's link — as on a sidebar row.
          icon={isLinkedChange(entry)
            ? 'git-pull-request'
            : entry.kind === 'linear'
              ? 'linear'
              : 'record-circle'}
          // The state's colour on the icon too, as on a sidebar row.
          iconColor={liveLookOf(entry)?.color}
          label={renderLinkedLabel(entry)}
          muted
          // GitHub threads still live on github.com. A Linear issue opens in
          // the right-hand panel when that rail exists; otherwise the Linear URL.
          onClick={() => openLinkedIssue(entry)}
          ariaLabel={entry.kind === 'linear'
            ? t('chat.workStatus.linkedIssues.openLinear', { identifier: entry.identifier })
            : entry.kind === 'guest' || entry.kind === 'external'
              ? t('chat.workStatus.linkedIssues.openGuest', { id: entry.identifier })
              : getGitLabThreadRef(entry)
                ? t('chat.workStatus.linkedIssues.openGitLab', { reference: renderedIdentifier(entry) })
                : t('chat.workStatus.linkedIssues.open', { number: entry.number })}
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
              className="shrink-0 rounded p-0.5 transition-opacity hover:opacity-70 disabled:opacity-40"
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
              className="shrink-0 rounded p-0.5 transition-opacity hover:opacity-70 disabled:opacity-40"
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
