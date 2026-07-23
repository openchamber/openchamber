import { useEffect } from 'react';
import { useMessengerStore } from '@/stores/useMessengerStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import type { ProjectEntry } from '@/lib/api/types';

/**
 * Keep Discord channels in lockstep with the OpenChamber project list.
 *
 * When a project is added, renamed, or removed in the UI, this mirrors the
 * change to Discord (create / rename / delete the project's channel) so web
 * conversations land in a per-project channel instead of dumping a thread into
 * the default #general channel. The work is delegated to the messenger store,
 * which no-ops unless a Discord connection (bot token + Server ID) is
 * configured and project sync is enabled.
 *
 * Implemented as a store subscription (rather than calling into the messenger
 * store from `useProjectsStore`) so the projects store stays free of messenger
 * coupling and we react to every code path that mutates the project list.
 */
export function useMessengerProjectChannelSync() {
  useEffect(() => {
    const reconcile = (next: ProjectEntry[], prev: ProjectEntry[]) => {
      if (next === prev) return;
      const messenger = useMessengerStore.getState();
      const conn = messenger.connections.find((c) => c.type === 'discord');
      // Gate on a configured, sync-enabled Discord connection. Without a Server
      // ID we cannot create per-project channels, so skip entirely.
      if (!conn?.botToken || !conn.discordGuildId || conn.syncProjects === false) return;

      const prevById = new Map(prev.map((p) => [p.id, p]));
      const nextById = new Map(next.map((p) => [p.id, p]));

      for (const project of next) {
        const before = prevById.get(project.id);
        if (!before) {
          void messenger.ensureProjectChannel(project);
        } else if ((before.label ?? '') !== (project.label ?? '')) {
          void messenger.renameProjectChannel(project);
        }
      }
      for (const project of prev) {
        if (!nextById.has(project.id)) {
          void messenger.removeProjectChannel(project.id, project.path);
        }
      }
    };

    return useProjectsStore.subscribe((state, prevState) => {
      reconcile(state.projects, prevState.projects);
    });
  }, []);
}
