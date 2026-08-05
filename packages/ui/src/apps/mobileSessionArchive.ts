import type { SessionNode } from '@/components/session/sidebar/types';

/**
 * Depth-first list of every known descendant session of a session node.
 * Switcher nodes are built from the global active-session cache, which already
 * excludes archived sessions, so the collected subtree is exactly the "known
 * active descendants" an archive confirmation covers.
 */
export const collectSessionNodeDescendantIds = (node: SessionNode): string[] => {
  const ids: string[] = [];
  const visit = (current: SessionNode): void => {
    for (const child of current.children) {
      ids.push(child.session.id);
      visit(child);
    }
  };
  visit(node);
  return ids;
};
