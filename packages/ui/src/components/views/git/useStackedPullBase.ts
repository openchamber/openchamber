import * as React from 'react';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import type { GitHubPullReference, SourceControlReadContext } from '@/lib/api/types';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { findPullForStackBase } from '@/lib/source-control/pullStackInference';
import { supportsGitHubAutomation } from '@/lib/source-control/githubAutomation';

/** Only the chosen base is looked up; creating a PR does not download every open PR. */
export function useStackedPullBase(context: SourceControlReadContext | null, base: string, { enabled, project }: {
  enabled: boolean; project: { owner: string; name: string } | null;
}) {
  const { sourceControl } = useRuntimeAPIs();
  const owner = project?.owner;
  const name = project?.name;
  const key = JSON.stringify([getRuntimeKey(), context, base, owner, name]);
  const [result, setResult] = React.useState<{ key: string; pull: GitHubPullReference | null } | null>(null);
  React.useEffect(() => {
    if (!enabled || !context || !supportsGitHubAutomation(context) || !base || !owner || !name) return;
    let active = true;
    const runtime = getRuntimeKey();
    void sourceControl.references(context, { kind: 'pull', state: 'open', query: `head:${base}` }).then((answer) => {
      if (!active || getRuntimeKey() !== runtime) return;
      const pull = answer.connected ? findPullForStackBase(answer.items, base, { owner, repo: name }) : null;
      setResult({ key, pull });
    }).catch(() => { /* An unavailable hint never grants create or registration authority. */ });
    return () => { active = false; };
  }, [base, context, enabled, key, owner, name, sourceControl]);
  return result?.key === key ? result.pull : null;
}
