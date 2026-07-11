import React from 'react';

import { isDesktopShell } from '@/lib/desktop';
import { releaseSessionStartupBarrier } from '@/lib/session-startup-barrier';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { startGlobalSessionIndexStartup } from '@/stores/useGlobalSessionsStore';

/** Owns Electron's one cold-start session restore and root-list refresh. */
export const SessionStartupCoordinator: React.FC = () => {
  const projects = useProjectsStore((state) => state.projects);
  const startedRef = React.useRef(false);

  React.useLayoutEffect(() => {
    if (!isDesktopShell() || startedRef.current) return;
    startedRef.current = true;
    void startGlobalSessionIndexStartup(projects.map((project) => project.path))
      .catch((error) => {
        console.warn('[SessionStartup] Initial session index sync failed:', error);
      })
      .finally(releaseSessionStartupBarrier);
  }, [projects]);

  return null;
};
