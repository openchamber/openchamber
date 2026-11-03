import React from 'react';

import type { ToolPart } from '@/lib/opencode/model';
import type { ShownPart } from '../../lib/turns/liveActivity';
import AssistantTextPart from './AssistantTextPart';
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

/**
 * A part a collapsed Activity keeps in view (`getShownPages`): a call drawn in
 * place, or the text with a UI block the agent wrote before a later step.
 */
export function ShownPartCard({ part, onShowPopup }: { part: ShownPart; onShowPopup?: (content: ToolPopupContent) => void }) {
  if (part.type === 'tool') return <ShownToolCard part={part} onShowPopup={onShowPopup} />;
  return (
    <AssistantTextPart
      part={part}
      sessionId={part.sessionID}
      messageId={part.messageID}
      streamPhase={part.time?.end === undefined ? 'streaming' : 'completed'}
      onShowPopup={onShowPopup}
    />
  );
}
