import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { useWorkflowRunAction, workflowAgentLook, workflowRunLook } from '@/components/chat/workflows/workflowRunPresentation';
import { isVSCodeRuntime } from '@/lib/desktop';
import { useI18n } from '@/lib/i18n';
import { groupWorkflowAgentsByPhase, isWorkflowRunOpen, type WorkflowAgent, type WorkflowRun } from '@/lib/workflows/model';
import { openWorkflowRunInPanel } from '@/lib/workflows/panel';
import { useSessionWorkflowRuns } from '@/lib/workflows/store';
import { useUIStore } from '@/stores/useUIStore';
import { WorkStatusCollapsibleSection, WorkStatusRow, WorkStatusRowAction, WorkStatusValue } from './WorkStatusPrimitives';
import { useReportWorkStatusPresence } from './presenceContext';
import { useOpenChildSession } from './useOpenChildSession';

type Props = {
  sessionId: string | null;
  directory: string | null;
};

const SECTION_ID = 'workflows';

const StateGlyph: React.FC<{ icon: React.ComponentProps<typeof Icon>['name']; color?: string }> = ({ icon, color }) => (
  // Centred in the panel's 14px icon slot, like the Subagents rows.
  <span className="flex size-3.5 shrink-0 items-center justify-center">
    <Icon name={icon} className="size-3" style={color ? { color } : undefined} />
  </span>
);

/** Where a running run is, for its one-line row: the phase and how many of its agents finished. */
const runProgress = (run: WorkflowRun): string | null => {
  const phase = groupWorkflowAgentsByPhase(run).find((group) => group.title === run.currentPhase && group.agents.length > 0);
  if (!phase) return null;
  return `${phase.title ?? ''} ${phase.done}/${phase.agents.length}`.trim();
};

/**
 * The workflow runs this session proposed, each with its state and the one
 * action that fits it. Where the context panel exists (desktop, web) a run is
 * one row that opens it in the Workflows panel, which shows its agents, log
 * and result. On the phone, which has no panel, a run unfolds into its phases
 * and agents here, and the agents open like subagents. A run's agents are left
 * out of the Subagents section, so each session shows in one place.
 */
export const WorkStatusWorkflowsSection: React.FC<Props> = ({ sessionId, directory }) => {
  const { t } = useI18n();
  const runs = useSessionWorkflowRuns(sessionId);
  const openChildSession = useOpenChildSession(directory);
  const { pending, act } = useWorkflowRunAction();
  const isMobile = useUIStore((state) => state.isMobile);
  const panelAvailable = !isMobile && !isVSCodeRuntime();
  // Open runs show their phases; a finished one folds to its row until asked.
  const [toggled, setToggled] = React.useState<ReadonlySet<string>>(() => new Set());

  useReportWorkStatusPresence('workflows', runs.length > 0);
  if (runs.length === 0) return null;

  const newestFirst = runs.slice().reverse();
  const openRuns = runs.filter(isWorkflowRunOpen).length;

  if (panelAvailable && sessionId && directory) {
    return (
      <WorkStatusCollapsibleSection
        id={SECTION_ID}
        title={t('chat.workStatus.section.workflows')}
        icon="flow-chart"
        defaultExpanded
        summary={openRuns > 0 ? `${openRuns}/${runs.length}` : runs.length}
      >
        <div className="max-h-72 overflow-y-auto">
          {newestFirst.map((run) => {
            const look = workflowRunLook(run.state);
            const busy = pending === run.id;
            const progress = run.state === 'running' ? runProgress(run) : null;
            return (
              <WorkStatusRow
                key={run.id}
                leading={<StateGlyph icon={look.icon} color={look.color} />}
                label={run.name}
                tooltip={run.error ?? run.description}
                onClick={() => openWorkflowRunInPanel(directory, sessionId, run.id)}
                ariaLabel={[t('chat.workStatus.workflow.openRun', { name: run.name }), t(look.labelKey)].join('. ')}
                value={run.state === 'awaiting-approval' ? (
                  <>
                    <WorkStatusRowAction tone="info" disabled={busy} onClick={() => act(run.id, 'approve')}>{t('chat.workflow.action.run')}</WorkStatusRowAction>
                    <WorkStatusRowAction disabled={busy} onClick={() => act(run.id, 'decline')}>{t('chat.workflow.action.decline')}</WorkStatusRowAction>
                  </>
                ) : run.state === 'failed' || run.state === 'stopped' ? (
                  <WorkStatusRowAction disabled={busy} onClick={() => act(run.id, 'resume')}>{t('chat.workflow.action.resume')}</WorkStatusRowAction>
                ) : progress ? (
                  // The icon carries the state, as in Subagents; a running run adds where it is.
                  <WorkStatusValue tone="muted">{progress}</WorkStatusValue>
                ) : null}
              />
            );
          })}
        </div>
      </WorkStatusCollapsibleSection>
    );
  }

  const toggle = (runId: string) => setToggled((current) => {
    const next = new Set(current);
    if (next.has(runId)) next.delete(runId);
    else next.add(runId);
    return next;
  });

  const runAction = (run: WorkflowRun): React.ReactNode => {
    const busy = pending === run.id;
    if (run.state === 'awaiting-approval') {
      return (
        <>
          <WorkStatusRowAction tone="info" disabled={busy} onClick={() => act(run.id, 'approve')}>{t('chat.workflow.action.run')}</WorkStatusRowAction>
          <WorkStatusRowAction disabled={busy} onClick={() => act(run.id, 'decline')}>{t('chat.workflow.action.decline')}</WorkStatusRowAction>
        </>
      );
    }
    if (run.state === 'running') {
      return <WorkStatusRowAction disabled={busy} onClick={() => act(run.id, 'stop')}>{t('chat.workflow.action.stop')}</WorkStatusRowAction>;
    }
    if (run.state === 'failed' || run.state === 'stopped') {
      return <WorkStatusRowAction disabled={busy} onClick={() => act(run.id, 'resume')}>{t('chat.workflow.action.resume')}</WorkStatusRowAction>;
    }
    // A finished run's icon says how it ended, as a subagent's does.
    return null;
  };

  const agentRow = (agent: WorkflowAgent) => {
    const look = workflowAgentLook(agent.state);
    const sessionOf = agent.sessionId;
    return (
      <WorkStatusRow
        key={agent.key}
        className="ps-8"
        leading={<StateGlyph icon={look.icon} color={look.color} />}
        label={agent.label}
        tooltip={agent.error ?? agent.preview}
        onClick={sessionOf ? () => openChildSession(sessionOf, agent.label) : undefined}
        ariaLabel={[t('chat.workStatus.workflow.openAgent', { name: agent.label }), t(look.labelKey)].join('. ')}
        value={agent.state === 'failed' || agent.replayed ? (
          <WorkStatusValue tone={agent.state === 'failed' ? 'error' : 'muted'}>
            {agent.state === 'failed' ? t(look.labelKey) : t('chat.workflow.agent.reused')}
          </WorkStatusValue>
        ) : null}
      />
    );
  };

  return (
    <WorkStatusCollapsibleSection
      id={SECTION_ID}
      title={t('chat.workStatus.section.workflows')}
      icon="flow-chart"
      defaultExpanded
      summary={openRuns > 0 ? `${openRuns}/${runs.length}` : runs.length}
    >
      <div className="max-h-72 overflow-y-auto">
        {newestFirst.map((run) => {
          const look = workflowRunLook(run.state);
          const expanded = isWorkflowRunOpen(run) !== toggled.has(run.id);
          return (
            <React.Fragment key={run.id}>
              <WorkStatusRow
                leading={<StateGlyph icon={look.icon} color={look.color} />}
                label={run.name}
                tooltip={run.error ?? run.description}
                onClick={() => toggle(run.id)}
                ariaLabel={[run.name, t(look.labelKey)].join('. ')}
                value={runAction(run)}
              />
              {expanded ? groupWorkflowAgentsByPhase(run).map((phase) => (
                <React.Fragment key={phase.title ?? ''}>
                  <WorkStatusRow
                    className="ps-5"
                    label={phase.title ?? t('chat.workflow.phase.unphased')}
                    value={phase.agents.length > 0 ? (
                      <WorkStatusValue tone="muted">{`${phase.done}/${phase.agents.length}`}</WorkStatusValue>
                    ) : null}
                  />
                  {phase.agents.map(agentRow)}
                </React.Fragment>
              )) : null}
            </React.Fragment>
          );
        })}
      </div>
    </WorkStatusCollapsibleSection>
  );
};
