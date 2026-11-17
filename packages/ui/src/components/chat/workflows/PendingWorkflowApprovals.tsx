import React from 'react';

import { proposedWorkflowRunId } from '@/lib/opencode/tools';
import { useSessionWorkflowRuns } from '@/lib/workflows/store';
import { useSessionPartsForMessages } from '@/sync/sync-context';
import type { ChatMessageEntry } from '../lib/turns/types';
import { WorkflowRunCard } from './WorkflowRunCard';
import { OperatorChildWorkflowApprovals } from './OperatorChildWorkflowApprovals';

const NO_LIVE_MESSAGES: readonly string[] = [];

export function PendingWorkflowApprovals(props: {
  sessionId: string;
  messages: readonly ChatMessageEntry[];
  liveMessageIds?: readonly string[];
  directory?: string;
}) {
  return (
    <>
      <OwnWorkflowApprovals {...props} />
      <OperatorChildWorkflowApprovals sessionId={props.sessionId} />
    </>
  );
}

function OwnWorkflowApprovals({ sessionId, messages, liveMessageIds = NO_LIVE_MESSAGES, directory }: {
  sessionId: string;
  messages: readonly ChatMessageEntry[];
  liveMessageIds?: readonly string[];
  directory?: string;
}) {
  const runs = useSessionWorkflowRuns(sessionId);
  const pending = runs.filter((run) => run.state === 'awaiting-approval');
  const livePartsByMessageId = useSessionPartsForMessages(pending.length > 0 ? liveMessageIds : NO_LIVE_MESSAGES, directory);
  if (pending.length === 0) return null;

  const shown = new Set<string>();
  for (const message of messages) {
    const liveParts = livePartsByMessageId[message.info.id];
    for (const part of liveParts?.length ? liveParts : message.parts) {
      if (part.type !== 'tool') continue;
      const runId = proposedWorkflowRunId(part.tool, part.state);
      if (runId) shown.add(runId);
    }
  }
  const missing = pending.filter((run) => !shown.has(run.id));
  if (missing.length === 0) return null;
  return (
    <div className="chat-message-column">
      {missing.map((run) => <WorkflowRunCard key={run.id} sessionId={sessionId} runId={run.id} />)}
    </div>
  );
}
