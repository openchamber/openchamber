import type { SessionSidebarRow } from '@/components/session/sidebar/sessionSidebarRowModel';
import type { SessionNode } from '@/components/session/sidebar/types';

const nodeHolds = (nodes: readonly SessionNode[], sessionId: string): boolean => nodes.some((node) => (
  node.session.id === sessionId || nodeHolds(node.children, sessionId)
));

const levelsTo = (nodes: readonly SessionNode[], sessionId: string): number => {
  let nearest = Infinity;
  for (const node of nodes) {
    nearest = Math.min(nearest, node.session.id === sessionId ? 1 : 1 + levelsTo(node.children, sessionId));
  }
  return nearest;
};

const findHoldingSessionRowIndex = (rows: readonly SessionSidebarRow[], sessionId: string): number => {
  let holder = -1;
  let nearest = Infinity;
  rows.forEach((row, index) => {
    if (row.kind !== 'session') return;
    const levels = levelsTo(row.node.children, sessionId);
    if (levels < nearest) {
      nearest = levels;
      holder = index;
    }
  });
  return holder;
};

export const findCurrentRowIndex = (
  rows: readonly SessionSidebarRow[],
  current: { sessionId: string | null; runKey: string | null; projectId: string | null },
): number => {
  const { sessionId, runKey, projectId } = current;
  if (runKey) {
    const index = rows.findIndex((row) => row.kind === 'run' && row.run.key === runKey);
    if (index >= 0) return index;
  }
  if (sessionId) {
    const index = rows.findIndex((row) => (
      (row.kind === 'session' && row.node.session.id === sessionId)
      || (row.kind === 'run' && row.run.memberIds.includes(sessionId))
    ));
    if (index >= 0) return index;
    const holder = findHoldingSessionRowIndex(rows, sessionId);
    if (holder >= 0) return holder;
    const header = rows.findIndex((row) => row.kind === 'group-header' && nodeHolds(row.group.sessions, sessionId));
    if (header >= 0) return header;
  }
  return projectId ? rows.findIndex((row) => row.kind === 'project-header' && row.section.project.id === projectId) : -1;
};
