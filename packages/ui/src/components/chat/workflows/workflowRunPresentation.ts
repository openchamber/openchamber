import React from 'react';

import type { IconName } from '@/components/icon/icons';
import { toast } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import type { I18nKey } from '@/lib/i18n/messages/en';
import { sendWorkflowRunAction, type WorkflowRunAction } from '@/lib/workflows/api';
import type { WorkflowAgentState, WorkflowRunState } from '@/lib/workflows/model';

type StateLook = { icon: IconName; color?: string; labelKey: I18nKey };

const WORKFLOW_RUN_STATE_LOOK = {
  'awaiting-approval': { icon: 'time', color: 'var(--status-warning)', labelKey: 'chat.workflow.state.awaitingApproval' },
  running: { icon: 'record-circle', color: 'var(--status-info)', labelKey: 'chat.workflow.state.running' },
  completed: { icon: 'checkbox-circle', color: 'var(--status-success)', labelKey: 'chat.workflow.state.completed' },
  failed: { icon: 'close-circle', color: 'var(--status-error)', labelKey: 'chat.workflow.state.failed' },
  stopped: { icon: 'stop', labelKey: 'chat.workflow.state.stopped' },
  declined: { icon: 'close-circle', labelKey: 'chat.workflow.state.declined' },
} satisfies Record<WorkflowRunState, StateLook>;

const WORKFLOW_AGENT_STATE_LOOK = {
  queued: { icon: 'time', labelKey: 'chat.workflow.agent.queued' },
  running: { icon: 'record-circle', color: 'var(--status-info)', labelKey: 'chat.workflow.agent.running' },
  completed: { icon: 'checkbox-circle', color: 'var(--status-success)', labelKey: 'chat.workflow.agent.completed' },
  failed: { icon: 'close-circle', color: 'var(--status-error)', labelKey: 'chat.workflow.agent.failed' },
  stopped: { icon: 'stop', labelKey: 'chat.workflow.agent.stopped' },
} satisfies Record<WorkflowAgentState, StateLook>;

export const workflowRunLook = (state: WorkflowRunState): StateLook => WORKFLOW_RUN_STATE_LOOK[state];

export const workflowAgentLook = (state: WorkflowAgentState): StateLook => WORKFLOW_AGENT_STATE_LOOK[state];

type WorkflowRunActions = {
  pending: string | null;
  act: (runId: string, action: WorkflowRunAction) => void;
};

export const useWorkflowRunAction = (): WorkflowRunActions => {
  const { t } = useI18n();
  const [pending, setPending] = React.useState<string | null>(null);
  const act = React.useCallback((runId: string, action: WorkflowRunAction) => {
    setPending(runId);
    void sendWorkflowRunAction(runId, action)
      .catch((error: Error) => {
        toast.error(t('chat.workflow.actionFailed'), { description: error.message });
      })
      .finally(() => setPending((current) => (current === runId ? null : current)));
  }, [t]);
  return { pending, act };
};
