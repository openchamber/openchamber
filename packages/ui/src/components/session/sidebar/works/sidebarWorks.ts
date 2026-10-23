import type { Session } from '@/lib/opencode/model';
import { normalizePath } from '@/lib/pathNormalization';
import type { SessionGroup, SessionNode } from '../types';
import type { ProjectSection } from '../projects/sessionProjectRender';

/**
 * A work is what the sidebar lists as one entry: a linked worktree with all
 * its sessions, or a root session of the project root (or of a space) with
 * the sessions nested under it. See DOCUMENTATION.md next to this file.
 */
export type SidebarWorkRef =
  | { kind: 'worktree'; key: string; projectId: string; group: SessionGroup }
  | { kind: 'session'; key: string; projectId: string; rootSessionId: string };

type SidebarWorktreeWorkRef = Extract<SidebarWorkRef, { kind: 'worktree' }>;

type SidebarWorkIndex = {
  bySessionId: ReadonlyMap<string, SidebarWorkRef>;
  /** Every worktree work, in section and group order, sessions or not. */
  worktreeWorks: readonly SidebarWorktreeWorkRef[];
};

/** A linked worktree's group: the one kind of group that is a work of its own. */
export const isWorktreeWorkGroup = (group: SessionGroup): boolean => (
  !group.isMain && group.isArchivedBucket !== true && !group.space && group.worktree !== null
);

const worktreeWorkGroupKey = (projectId: string, group: SessionGroup): string => `${projectId}:${group.id}`;

/**
 * A worktree's entry in a folder of its project root, beside the session ids
 * there. The folder store and the server treat members as opaque ids, so a
 * worktree is filed with the same assign and unassign changes as a session.
 */
export const worktreeFolderMemberId = (directory: string | null): string | null => {
  const normalized = normalizePath(directory);
  return normalized ? `worktree:${normalized}` : null;
};

const sessionWorkKey = (rootSessionId: string): string => `session:${rootSessionId}`;

/** Which work each listed session belongs to, from the project sections. */
export const buildSidebarWorkIndex = (sections: readonly ProjectSection[]): SidebarWorkIndex => {
  const bySessionId = new Map<string, SidebarWorkRef>();
  const worktreeWorks: SidebarWorktreeWorkRef[] = [];
  const claim = (node: SessionNode, ref: SidebarWorkRef): void => {
    const stack = [node];
    while (stack.length > 0) {
      const current = stack.pop();
      if (!current || bySessionId.has(current.session.id)) continue;
      bySessionId.set(current.session.id, ref);
      stack.push(...current.children);
    }
  };
  for (const section of sections) {
    const projectId = section.project.id;
    for (const group of section.groups) {
      if (group.isArchivedBucket) continue;
      if (isWorktreeWorkGroup(group)) {
        const ref: SidebarWorktreeWorkRef = { kind: 'worktree', key: worktreeWorkGroupKey(projectId, group), projectId, group };
        worktreeWorks.push(ref);
        group.sessions.forEach((node) => claim(node, ref));
        continue;
      }
      for (const node of group.sessions) {
        claim(node, { kind: 'session', key: sessionWorkKey(node.session.id), projectId, rootSessionId: node.session.id });
      }
    }
  }
  return { bySessionId, worktreeWorks };
};

/**
 * The works of the sessions `include` accepts, each once, in the order of the
 * first of their sessions in `orderedSessions` (the sidebar's lifecycle order,
 * so a work moves up when any of its sessions does).
 */
export const orderSidebarWorks = (
  orderedSessions: readonly Session[],
  index: SidebarWorkIndex,
  include: (session: Session) => boolean,
): SidebarWorkRef[] => {
  const works: SidebarWorkRef[] = [];
  const seen = new Set<string>();
  for (const session of orderedSessions) {
    if (!include(session)) continue;
    const ref = index.bySessionId.get(session.id);
    if (!ref || seen.has(ref.key)) continue;
    seen.add(ref.key);
    works.push(ref);
  }
  return works;
};
