import type { Project, SourceControlAPI, SourceControlReadContext } from '@/lib/api/types';
import { sourceControlReadContextParts } from '@/lib/source-control/identity';

type DetectedUpstreamResult = {
  upstream: Project | null;
  branches: string[];
};

export const getDetectedUpstreamContextKey = (context: SourceControlReadContext): string =>
  JSON.stringify(sourceControlReadContextParts(context));

export const loadDetectedUpstreamRepo = async (
  sourceControl: Pick<SourceControlAPI, 'projectUpstream' | 'projectBranches'>,
  context: SourceControlReadContext,
): Promise<DetectedUpstreamResult> => {
  const result = await sourceControl.projectUpstream(context);
  if (!result?.isFork || !result.upstream) {
    return { upstream: null, branches: [] };
  }

  const branches = await sourceControl.projectBranches(
    context,
    result.upstream.owner,
    result.upstream.name,
  );
  return { upstream: result.upstream, branches };
};
