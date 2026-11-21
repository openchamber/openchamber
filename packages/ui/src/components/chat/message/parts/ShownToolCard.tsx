import React from 'react';

import type { ToolPart } from '@/lib/opencode/model';
import { isSettledAsk, type ShownPart } from '../../lib/turns/liveActivity';
import AssistantTextPart from './AssistantTextPart';
import { PageAskStatus } from './PageAskStatus';
import { generatedImagePaths, proposedWorkflowRunId, renderedPage, requestedSecret, requestedSecretForget, requestedSecretRun } from '@/lib/opencode/tools';
import { WorkflowRunCard } from '@/components/chat/workflows/WorkflowRunCard';
import type { ToolPopupContent } from '../types';
import { GeneratedImages } from './GeneratedImages';
import { ShownPage } from './HtmlRenderFrame';
import { SecretForgetCard, SecretRequestCard, SecretRunCard } from './SecretRequestCard';

export function ShownToolCard({ part, onShowPopup }: { part: ToolPart; onShowPopup?: (content: ToolPopupContent) => void }) {
  const runId = React.useMemo(() => proposedWorkflowRunId(part.tool, part.state), [part.tool, part.state]);
  const images = React.useMemo(() => generatedImagePaths(part.tool, part.state), [part.tool, part.state]);
  const secret = React.useMemo(() => requestedSecret(part.tool, part.state), [part.tool, part.state]);
  const secretRun = React.useMemo(() => requestedSecretRun(part.tool, part.state), [part.tool, part.state]);
  const secretForget = React.useMemo(() => requestedSecretForget(part.tool, part.state), [part.tool, part.state]);
  if (runId) return <WorkflowRunCard sessionId={part.sessionID} runId={runId} />;
  if (images.length > 0) return <GeneratedImages part={part} paths={images} onShowPopup={onShowPopup} />;
  if (secret) return <SecretRequestCard part={part} request={secret} />;
  if (secretRun) return <SecretRunCard part={part} run={secretRun} />;
  if (secretForget) return <SecretForgetCard part={part} />;
  return <ShownPage part={part} />;
}

function SettledAskLine({ part }: { part: ToolPart }) {
  const page = React.useMemo(() => renderedPage(part.tool, part.state), [part.tool, part.state]);
  if (!page) return null;
  return (
    <div className="my-2">
      <PageAskStatus ask={page.ask} answeredSummary={page.ask.kind === 'answered' ? page.ask.summary : undefined} />
    </div>
  );
}

export function ShownPartCard({ part, onShowPopup }: { part: ShownPart; onShowPopup?: (content: ToolPopupContent) => void }) {
  if (part.type === 'tool') {
    if (isSettledAsk(part)) return <SettledAskLine part={part} />;
    return <ShownToolCard part={part} onShowPopup={onShowPopup} />;
  }
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
