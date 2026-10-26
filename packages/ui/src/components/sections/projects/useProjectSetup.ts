import React from 'react';
import {
  fetchProjectSetup,
  updateProjectSetup,
  updateSharedProjectSetup,
  type ProjectRef,
  type ProjectSetup,
} from '@/lib/openchamberConfig';
import { PROJECT_ACTIONS_UPDATED_EVENT } from '@/lib/projectActions';
import type { ProjectSetupWriters } from './projectSetupModel';

type ProjectSetupLoad =
  | { state: 'loading' }
  | { state: 'failed' }
  | { state: 'ready'; setup: ProjectSetup };

export type ProjectSetupState = {
  load: ProjectSetupLoad;
  /** Read the setup again; every edit ends with one, so the page shows what is on disk. */
  reload: () => Promise<void>;
  write: ProjectSetupWriters;
};

/**
 * The project's setup for the project page, read once and shared by its tabs.
 * A failed read is its own state: the page must not offer edits that would
 * write a list back over a file it could not read.
 */
export const useProjectSetup = (projectRef: ProjectRef): ProjectSetupState => {
  const [load, setLoad] = React.useState<ProjectSetupLoad>({ state: 'loading' });
  // Only the newest read lands, and none after unmount.
  const requestRef = React.useRef(0);

  const reload = React.useCallback(async () => {
    const request = ++requestRef.current;
    try {
      const setup = await fetchProjectSetup(projectRef);
      if (request === requestRef.current) setLoad({ state: 'ready', setup });
    } catch {
      if (request === requestRef.current) setLoad({ state: 'failed' });
    }
  }, [projectRef]);

  React.useEffect(() => {
    setLoad({ state: 'loading' });
    void reload();
    return () => {
      requestRef.current += 1;
    };
  }, [reload]);

  const write = React.useMemo<ProjectSetupWriters>(() => {
    // The run button and the menus read actions on their own; tell them.
    const notifyActions = (ok: boolean): boolean => {
      if (ok && typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent(PROJECT_ACTIONS_UPDATED_EVENT, { detail: { projectId: projectRef.id } }));
      }
      return ok;
    };
    return {
      personalActions: async (projectActions) => notifyActions(await updateProjectSetup(projectRef, { projectActions })),
      sharedActions: async (projectActions) => notifyActions((await updateSharedProjectSetup(projectRef, { projectActions })) !== null),
      hiddenSharedActionIds: async (ids) => notifyActions(await updateProjectSetup(projectRef, { hiddenSharedActionIds: ids })),
      personalCommands: (setupWorktree) => updateProjectSetup(projectRef, { setupWorktree }),
      sharedCommands: async (setupWorktree) => (await updateSharedProjectSetup(projectRef, { setupWorktree })) !== null,
    };
  }, [projectRef]);

  return { load, reload, write };
};
