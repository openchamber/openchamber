import React from 'react';
import { isVSCodeRuntime } from '@/lib/desktop';
import { listIntegrateConflicts, type IntegrateConflict } from '@/lib/git/integrateWorktreeCommits';
import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';
import { captureRuntimeInstance, subscribeRuntimeEndpointChanged } from '@/lib/runtime-switch';
import { isSpaceDirectory } from '@/lib/spaces/space-route';

const NONE: readonly IntegrateConflict[] = [];

export const useIntegrateConflicts = (directory: string | null | undefined, isGitRepo: boolean) => {
  const [loaded, setLoaded] = React.useState<{ directory: string; conflicts: readonly IntegrateConflict[] } | null>(null);
  const latest = React.useRef(0);
  const target = directory && isGitRepo && !isVSCodeRuntime() && !isSpaceDirectory(directory) ? directory : null;

  const reload = React.useCallback(async () => {
    if (!target) return;
    const request = ++latest.current;
    const isCurrent = captureRuntimeInstance();
    const conflicts = await listIntegrateConflicts(target).catch(() => null);
    if (!conflicts || !isCurrent() || request !== latest.current) return;
    setLoaded({ directory: target, conflicts });
  }, [target]);

  React.useEffect(() => {
    void reload();
    const stopEvents = subscribeOpenchamberEvents((event) => {
      if (event.type === 'worktree-changed' || event.type === 'event-stream-ready') void reload();
    });
    const stopRuntime = subscribeRuntimeEndpointChanged(() => {
      latest.current += 1;
      setLoaded(null);
    });
    return () => {
      latest.current += 1;
      stopEvents();
      stopRuntime();
    };
  }, [reload]);

  return { conflicts: loaded?.directory === target ? loaded.conflicts : NONE, reload };
};
