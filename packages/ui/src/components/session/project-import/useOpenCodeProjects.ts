import React from 'react';
import { ensureChatsRootDirectory } from '@/lib/chatDirectories';
import { opencodeClient } from '@/lib/opencode/client';
import { normalizePath } from '@/lib/pathNormalization';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { openCodeProjectCandidates, type OpenCodeProject } from './openCodeProjectCandidates';

const NONE: OpenCodeProject[] = [];

/** Read only while enabled, so startup and a closed dialog touch nothing. */
export function useOpenCodeProjects(enabled: boolean, runtimeKey: string): OpenCodeProject[] {
  const [loaded, setLoaded] = React.useState<{ runtimeKey: string; projects: OpenCodeProject[] } | null>(null);
  const hasServerSnapshot = useProjectsStore((state) => state.hasServerSnapshot);

  React.useEffect(() => {
    if (!enabled || !hasServerSnapshot) return;
    let cancelled = false;
    const load = async () => {
      await ensureChatsRootDirectory();
      const projects = await opencodeClient.listProjects();
      if (cancelled) return;
      const configured = new Set(useProjectsStore.getState().projects.flatMap((project) => normalizePath(project.path) ?? []));
      const candidates = openCodeProjectCandidates(projects, configured);
      // The client batches these filesystem probes. They do not start OpenCode
      // locations, and an unavailable or unknown folder is never offered.
      const available = await Promise.all(candidates.map(async (candidate) =>
        await opencodeClient.getDirectoryAvailability(candidate.path) === 'available' ? candidate : null));
      if (!cancelled) setLoaded({ runtimeKey, projects: available.filter((candidate) => candidate !== null) });
    };
    // The list is an extra way in: without it the dialog simply does not offer
    // it, and the next opening reads again.
    void load().catch(() => {});
    return () => {
      cancelled = true;
      setLoaded(null);
    };
  }, [enabled, hasServerSnapshot, runtimeKey]);

  return loaded?.runtimeKey === runtimeKey ? loaded.projects : NONE;
}
