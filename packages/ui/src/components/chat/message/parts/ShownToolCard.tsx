import React from 'react';

import type { ToolPart } from '@/lib/opencode/model';
import { generatedImagePaths, proposedWorkflowRunId } from '@/lib/opencode/tools';
import { WorkflowRunCard } from '@/components/chat/workflows/WorkflowRunCard';
import type { ToolPopupContent } from '../types';
import { GeneratedImages } from './GeneratedImages';
import { ShownInterface } from './OpenUIToolPart';

/**
 * What a call the chat shows in place (`isShownInPlace`) draws instead of its
 * row: the run a `workflow.run` call proposed, else its OpenUI prompt.
 */
export function ShownToolCard({ part, onShowPopup }: { part: ToolPart; onShowPopup?: (content: ToolPopupContent) => void }) {
  const runId = React.useMemo(() => proposedWorkflowRunId(part.tool, part.state), [part.tool, part.state]);
  const images = React.useMemo(() => generatedImagePaths(part.tool, part.state), [part.tool, part.state]);
  if (runId) return <WorkflowRunCard sessionId={part.sessionID} runId={runId} />;
  if (images.length > 0) return <GeneratedImages part={part} paths={images} onShowPopup={onShowPopup} />;
  return <ShownInterface part={part} />;
}
