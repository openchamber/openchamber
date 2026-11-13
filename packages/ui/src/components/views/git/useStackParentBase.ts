import * as React from 'react';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import type { SourceControlReadContext } from '@/lib/api/types';
import type { StackParentResult } from '@/lib/api/pull-stacks';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { supportsGitHubAutomation } from '@/lib/source-control/githubAutomation';

type Detected = Extract<StackParentResult, { connected: true }>['result'];

export type StackParentState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error' }
  | { status: 'ready'; result: Detected };

/**
 * Which open PR in the target the branch sits on. A failed read is `error`,
 * never `none`, so the form keeps its base instead of treating it as unstacked.
 */
export function useStackParentBase(context: SourceControlReadContext | null, branch: string, { enabled, project }: {
  enabled: boolean; project: { owner: string; name: string } | null;
}) {
  const { sourceControl } = useRuntimeAPIs();
  const owner = project?.owner;
  const name = project?.name;
  const [attempt, retry] = React.useReducer((value: number) => value + 1, 0);
  const key = JSON.stringify([getRuntimeKey(), context, branch, owner, name, attempt]);
  const [state, setState] = React.useState<{ key: string; value: StackParentState } | null>(null);
  const active = Boolean(enabled && context && supportsGitHubAutomation(context) && branch && owner && name);
  React.useEffect(() => {
    if (!active || !context || !owner || !name) return;
    let current = true;
    const runtime = getRuntimeKey();
    setState({ key, value: { status: 'loading' } });
    void sourceControl.githubPullStackParent(context, { owner, repo: name, branch }).then((answer) => {
      if (!current || getRuntimeKey() !== runtime) return;
      setState({ key, value: answer.connected ? { status: 'ready', result: answer.result } : { status: 'error' } });
    }).catch(() => {
      if (current && getRuntimeKey() === runtime) setState({ key, value: { status: 'error' } });
    });
    return () => { current = false; };
  }, [active, branch, context, key, name, owner, sourceControl]);
  const value: StackParentState = !active ? { status: 'idle' } : state?.key === key ? state.value : { status: 'loading' };
  return { state: value, retry };
}
