import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { BusyDots } from '@/components/ui/busy-dots';
import { Button } from '@/components/ui/button';
import { isVSCodeRuntime } from '@/lib/desktop';
import { useI18n } from '@/lib/i18n';
import { groupWorkflowAgentsByPhase, type WorkflowRun } from '@/lib/workflows/model';
import { openWorkflowRunInPanel } from '@/lib/workflows/panel';
import { useWorkflowRunsStore, useWorkflowRun } from '@/lib/workflows/store';
import { useUIStore } from '@/stores/useUIStore';
import { useWorkflowRunAction, workflowRunLook } from './workflowRunPresentation';

/**
 * The run a `workflow.run` call proposed, drawn in place of the call's row:
 * the plan the user approves, then how far the run got. The state comes from
 * the server's run, not from the call, so the card is current after a reload
 * and on every device.
 */
export const WorkflowRunCard: React.FC<{ sessionId: string; runId: string }> = ({ sessionId, runId }) => {
  const { t } = useI18n();
  const run = useWorkflowRun(sessionId, runId);
  const status = useWorkflowRunsStore((state) => state.bySession[sessionId]?.status);
  // A build without workflows reads no runs; a card from an earlier one says so.
  const available = useUIStore((state) => state.agentWorkflowFeatureAvailable);

  if (!available) {
    return <div className="my-2 oc-tile rounded-xl px-3 py-2.5 text-sm text-muted-foreground">{t('chat.workflow.unavailable')}</div>;
  }
  if (!run) {
    return (
      <div className="my-2 oc-tile rounded-xl px-3 py-2.5 text-sm text-muted-foreground">
        {status === 'ready'
          ? t('chat.workflow.unavailable')
          : status === 'error'
            ? t('chat.workflow.loadFailed')
            : <>{t('chat.workflow.loading')}<BusyDots /></>}
      </div>
    );
  }
  return <WorkflowRunCardBody run={run} />;
};

const WorkflowRunCardBody: React.FC<{ run: WorkflowRun }> = ({ run }) => {
  const { t } = useI18n();
  const { pending, act } = useWorkflowRunAction();
  const look = workflowRunLook(run.state);
  const phases = React.useMemo(() => groupWorkflowAgentsByPhase(run), [run]);
  const busy = pending === run.id;
  // The Workflows panel lives in the context panel, which the phone and VS Code do not have.
  const isMobile = useUIStore((state) => state.isMobile);
  const panelAvailable = !isMobile && !isVSCodeRuntime();

  return (
    <div data-component="workflow-run" className="my-2 oc-tile rounded-xl px-3 py-2.5">
      <div className="flex min-w-0 items-center gap-2">
        <Icon name="flow-chart" className="size-4 shrink-0 text-muted-foreground" />
        {panelAvailable ? (
          <button
            type="button"
            onClick={() => openWorkflowRunInPanel(run.directory, run.parentSessionId, run.id)}
            title={t('chat.workStatus.workflow.openRun', { name: run.name })}
            className="min-w-0 truncate text-start typography-ui-label text-foreground/80 hover:text-foreground"
            dir="auto"
          >
            {run.name}
          </button>
        ) : (
          <span className="min-w-0 truncate typography-ui-label text-foreground" dir="auto">{run.name}</span>
        )}
        <span className="ms-auto flex shrink-0 items-center gap-1 text-xs" style={look.color ? { color: look.color } : undefined}>
          <Icon name={look.icon} className="size-3.5" />
          {t(look.labelKey)}
        </span>
      </div>
      <p className="mt-1 text-sm text-muted-foreground">{run.description}</p>

      {phases.length > 0 ? (
        <ol className="mt-2 flex flex-col gap-0.5">
          {phases.map((phase) => (
            <li key={phase.title ?? ''} className="flex min-w-0 items-center gap-2 text-[0.8125rem]">
              <span className="min-w-0 flex-1 truncate text-foreground">{phase.title ?? t('chat.workflow.phase.unphased')}</span>
              {phase.agents.length > 0 ? (
                <span className="shrink-0 tabular-nums text-muted-foreground" dir="auto">
                  {phase.done}/{phase.agents.length}
                </span>
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}

      {run.error && (run.state === 'failed' || run.state === 'stopped') ? (
        <p className="mt-2 text-[0.8125rem]" style={{ color: run.state === 'failed' ? 'var(--status-error)' : undefined }}>
          {run.error}
        </p>
      ) : null}

      {run.state === 'awaiting-approval' ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button type="button" size="sm" disabled={busy} onClick={() => act(run.id, 'approve')}>
            <Icon name="play" className="size-3.5" />
            {t('chat.workflow.action.run')}
          </Button>
          <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => act(run.id, 'decline')}>
            {t('chat.workflow.action.decline')}
          </Button>
        </div>
      ) : run.state === 'running' ? (
        <div className="mt-3 flex items-center gap-2">
          <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => act(run.id, 'stop')}>
            <Icon name="stop" className="size-3.5" />
            {t('chat.workflow.action.stop')}
          </Button>
        </div>
      ) : run.state === 'failed' || run.state === 'stopped' ? (
        <div className="mt-3 flex items-center gap-2">
          <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => act(run.id, 'resume')}>
            <Icon name="restart" className="size-3.5" />
            {t('chat.workflow.action.resume')}
          </Button>
        </div>
      ) : null}
    </div>
  );
};
