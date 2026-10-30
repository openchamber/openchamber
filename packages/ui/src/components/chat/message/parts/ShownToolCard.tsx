import React from 'react';

import type { ToolPart } from '@/lib/opencode/model';
import { generatedImagePaths, proposedWorkflowRunId, requestedSecret } from '@/lib/opencode/tools';
import { WorkflowRunCard } from '@/components/chat/workflows/WorkflowRunCard';
import type { ToolPopupContent } from '../types';
import { GeneratedImages } from './GeneratedImages';
import { ShownPage } from './HtmlRenderFrame';
import { SecretRequestCard } from './SecretRequestCard';

/**
 * What a call the chat shows in place (`isShownInPlace`) draws instead of its
 * row: the run a `workflow.run` call proposed, the images `image.generate`
 * made, the card a secret request asks on, else the page it showed.
 */
export function ShownToolCard({ part, onShowPopup }: { part: ToolPart; onShowPopup?: (content: ToolPopupContent) => void }) {
  const runId = React.useMemo(() => proposedWorkflowRunId(part.tool, part.state), [part.tool, part.state]);
  const images = React.useMemo(() => generatedImagePaths(part.tool, part.state), [part.tool, part.state]);
  const secret = React.useMemo(() => requestedSecret(part.tool, part.state), [part.tool, part.state]);
  if (runId) return <WorkflowRunCard sessionId={part.sessionID} runId={runId} />;
  if (images.length > 0) return <GeneratedImages part={part} paths={images} onShowPopup={onShowPopup} />;
  if (secret) return <SecretRequestCard part={part} request={secret} />;
  return <ShownPage part={part} />;
}
