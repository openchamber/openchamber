import React from 'react';

import type { ToolPart } from '@/lib/opencode/model';
import { proposedWorkflowRunId } from '@/lib/opencode/tools';
import { WorkflowRunCard } from '@/components/chat/workflows/WorkflowRunCard';
import { ShownPage } from './HtmlRenderFrame';

/**
 * What a call the chat shows in place (`isShownInPlace`) draws instead of its
 * row: the run a `workflow.run` call proposed, else the page it showed.
 */
export function ShownToolCard({ part }: { part: ToolPart }) {
  const runId = React.useMemo(() => proposedWorkflowRunId(part.tool, part.state), [part.tool, part.state]);
  if (runId) return <WorkflowRunCard sessionId={part.sessionID} runId={runId} />;
  return <ShownPage part={part} />;
}
