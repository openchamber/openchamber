import React from 'react';
import { useI18n } from '@/lib/i18n';
import { Icon } from '@/components/icon/Icon';
import { useSkillsStore } from '@/stores/useSkillsStore';
import { useMcpStore } from '@/stores/useMcpStore';
import { useSession } from '@/sync/sync-context';
import { getLinkedIssues, canOpenLinearIssueInContextPanel } from '@/lib/linkedIssues';
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
import { useUIStore } from '@/stores/useUIStore';
import { WorkStatusCollapsibleSection, WorkStatusRow, WorkStatusValue } from './WorkStatusPrimitives';
import { useReportWorkStatusPresence } from './presenceContext';
import { resolveDraftPinnedKnowledge } from './draftKnowledge';

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
  React.useEffect(() => {
    void loadSkills();
  }, [directory, loadSkills]);

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

  const linked = React.useMemo(() => getLinkedIssues(session), [session]);
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
    () => Object.values(mcpStatus ?? {}).filter((entry) => entry?.status === 'connected').length,
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
  const issueCount = linked.filter((entry) => entry.kind === 'issue' || entry.kind === 'linear').length;
  const prCount = linked.filter((entry) => entry.kind === 'pull').length;
  const summaryParts: string[] = [];
  if (issueCount > 0) {
    summaryParts.push(issueCount === 1
      ? t('chat.workStatus.breakdown.issueCountSingle', { count: issueCount })
      : t('chat.workStatus.breakdown.issueCountPlural', { count: issueCount }));
  }
  if (prCount > 0) {
    summaryParts.push(prCount === 1
      ? t('chat.workStatus.breakdown.prCountSingle', { count: prCount })
      : t('chat.workStatus.breakdown.prCountPlural', { count: prCount }));
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
          leading={entry.authorAvatarUrl ? (
            <img src={entry.authorAvatarUrl} alt="" className="size-4 shrink-0 rounded-full" loading="lazy" />
          ) : (
            <Icon
              name={entry.kind === 'pull' ? 'git-pull-request' : entry.kind === 'linear' ? 'linear' : 'error-warning'}
              className="size-4 shrink-0 text-muted-foreground"
            />
          )}
          label={entry.title}
          muted
          // GitHub threads still live on github.com. A Linear issue opens in
          // the right-hand panel when that rail exists; otherwise the Linear URL.
          onClick={() => openLinkedIssue(entry)}
          ariaLabel={entry.kind === 'linear'
            ? t('chat.workStatus.linkedIssues.openLinear', { identifier: entry.identifier })
            : t('chat.workStatus.linkedIssues.open', { number: entry.number })}
          value={(
            <WorkStatusValue tone="muted">
              {entry.kind === 'linear' ? entry.identifier : `#${entry.number}`}
            </WorkStatusValue>
          )}
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
