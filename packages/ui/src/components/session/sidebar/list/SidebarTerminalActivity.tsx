import React from 'react';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { groupTerminalSessionsByDirectory } from '@/lib/projectActionTerminal';
import { observeTerminalSessions } from '@/lib/terminalSessionObserver';
import { isActiveProjectActionTab, useTerminalStore } from '@/stores/useTerminalStore';

const selectHasActiveProjectAction = (state: ReturnType<typeof useTerminalStore.getState>): boolean => {
  for (const directory of state.sessions.values()) {
    if (directory.tabs.some(isActiveProjectActionTab)) return true;
  }
  return false;
};

/**
 * Mounted with the visible sidebar, independently of row count and grouping.
 *
 * The listing loop runs only while a project action is known to be running,
 * because that is the only time the indicator can change on its own. With
 * nothing running the sidebar lists once on mount, to pick up runs another
 * client started, and then stays quiet; the terminal panel and the actions
 * header keep their own loops while open.
 */
export const SidebarTerminalActivity = () => {
  const { terminal } = useRuntimeAPIs();
  const hasActiveProjectAction = useTerminalStore(selectHasActiveProjectAction);
  React.useEffect(() => {
    const apply = (result: Parameters<Parameters<typeof observeTerminalSessions>[3]>[0]) => {
      const store = useTerminalStore.getState();
      const byDirectory = groupTerminalSessionsByDirectory(result.sessions);
      const directories = new Set([...store.sessions.keys(), ...byDirectory.keys()]);
      for (const directory of directories) {
        store.reconcileServerSessions(directory, byDirectory.get(directory) ?? [], {
          startedActionMutationRevisions: result.startedActionMutationRevisions,
        });
      }
    };
    const capture = () => new Map(useTerminalStore.getState().actionMutationRevisions);
    if (hasActiveProjectAction) return observeTerminalSessions(terminal, '', capture, apply);
    let stop = () => {};
    stop = observeTerminalSessions(terminal, '', capture, (result) => {
      apply(result);
      stop();
    });
    return () => stop();
  }, [terminal, hasActiveProjectAction]);
  return null;
};
