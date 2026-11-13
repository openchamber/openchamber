import type { Project, SourceControlAPI, SourceControlReadContext } from '@/lib/api/types';
import { sourceControlReadContextParts } from '@/lib/source-control/identity';

type DetectedUpstreamResult = {
  upstream: Project | null;
  viewerCanPush: boolean;
};

export const getDetectedUpstreamContextKey = (context: SourceControlReadContext): string =>
  JSON.stringify(sourceControlReadContextParts(context));

/**
 * The fork parent and positive push evidence for default target selection only.
 * Missing evidence chooses the same default as false; neither authorizes a mutation.
 */
export const loadDetectedUpstreamRepo = async (
  sourceControl: Pick<SourceControlAPI, 'projectUpstream'>,
  context: SourceControlReadContext,
): Promise<DetectedUpstreamResult> => {
  const result = await sourceControl.projectUpstream(context);
  return {
    upstream: result?.isFork && result.upstream ? result.upstream : null,
    viewerCanPush: result?.viewerCanPush === true,
  };
};
