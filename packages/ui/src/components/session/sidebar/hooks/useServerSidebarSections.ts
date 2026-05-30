import React from 'react';
import type { SessionGroup } from '../types';
import type { ServerInfo } from '@/sync/server-context';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useI18n } from '@/lib/i18n';

type ProjectItem = {
  id: string;
  label?: string;
  normalizedPath: string;
  icon?: string;
  color?: string;
  iconImage?: { mime: string; updatedAt: number; source: 'custom' | 'auto' };
  iconBackground?: string;
};

type ProjectSection = {
  project: ProjectItem;
  groups: SessionGroup[];
};

export interface ServerSection {
  serverId: string;
  label: string;
  type: 'local' | 'ssh' | 'remote-url';
  status: 'connecting' | 'connected' | 'disconnected' | 'error';
  errorMessage?: string;
  isCollapsed: boolean;
  url: string;
  projectSections: ProjectSection[];
}

export function useServerSidebarSections(opts: {
  servers: ServerInfo[];
  projectSections: ProjectSection[];
  collapsedServers: Set<string>;
}): ServerSection[] {
  const { servers, projectSections, collapsedServers } = opts;

  const { t } = useI18n();
  const projectsSub = useProjectsStore((s) => s.projects);

  const projectServerMap = React.useMemo(() => {
    const map = new Map<string, string>();
    for (const p of projectsSub) {
      if (p.serverId) {
        map.set(p.id, p.serverId);
      }
    }
    return map;
  }, [projectsSub]);

  return React.useMemo(() => {
    if (servers.length === 0) {
      return [{
        serverId: 'local',
        label: t('server.sidebar.localLabel'),
        type: 'local' as const,
        status: 'connected' as const,
        isCollapsed: false,
        url: '',
        projectSections,
      }];
    }

    const serverProjectMap = new Map<string, ProjectSection[]>()
    for (const ps of projectSections) {
      const mappedServerId = projectServerMap.get(ps.project.id) ?? 'local'
      const bucket = serverProjectMap.get(mappedServerId)
      if (bucket) {
        bucket.push(ps)
      } else {
        serverProjectMap.set(mappedServerId, [ps])
      }
    }

    const sections: ServerSection[] = servers.map((server) => ({
      serverId: server.id,
      label: server.label,
      type: server.type,
      status: server.status,
      errorMessage: server.errorMessage,
      isCollapsed: collapsedServers.has(server.id),
      url: server.url,
      projectSections: serverProjectMap.get(server.id) ?? [],
    }));

    const matchedProjectIds = new Set<string>();
    for (const section of sections) {
      for (const ps of section.projectSections) {
        matchedProjectIds.add(ps.project.id);
      }
    }

    const orphanSections = projectSections.filter((ps) => !matchedProjectIds.has(ps.project.id));
    if (orphanSections.length > 0) {
      const existingLocal = sections.find((s) => s.serverId === 'local');
      if (existingLocal) {
        sections[sections.indexOf(existingLocal)] = {
          ...existingLocal,
          projectSections: [...existingLocal.projectSections, ...orphanSections],
        };
      } else {
        sections.push({
          serverId: 'local',
          label: t('server.sidebar.localLabel'),
          type: 'local' as const,
          status: 'connected' as const,
          isCollapsed: collapsedServers.has('local'),
          url: '',
          projectSections: orphanSections,
        });
      }
    }

    return sections;
  }, [servers, projectSections, collapsedServers, projectServerMap, t]);
}
