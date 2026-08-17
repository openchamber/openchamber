import type { Session } from '@opencode-ai/sdk/v2/client';

export const getSessionParentId = (session: Session): string | null => (
  // SAFETY: OpenCode session payloads may include the optional parentID field even when the SDK type omits it.
  (session as Session & { parentID?: string | null }).parentID ?? null
);

export const selectPinnedRootSessionIds = (
  sessions: readonly Session[],
  isPinned: (session: Session) => boolean,
): Set<string> => {
  const rootIds = new Set<string>();
  for (const session of sessions) {
    if (!getSessionParentId(session) && isPinned(session)) {
      rootIds.add(session.id);
    }
  }
  return rootIds;
};

/**
 * Return every session in the supplied roots' in-snapshot subtrees.
 *
 * The parent index is built once for all roots, and the visited set makes the
 * traversal safe when malformed snapshots contain parent cycles.
 */
export const collectSessionSubtreeIds = (
  sessions: readonly Session[],
  rootIds: ReadonlySet<string>,
): Set<string> => {
  const childrenByParent = new Map<string, string[]>();
  for (const session of sessions) {
    const parentId = getSessionParentId(session);
    if (!parentId) continue;
    const children = childrenByParent.get(parentId);
    if (children) {
      children.push(session.id);
    } else {
      childrenByParent.set(parentId, [session.id]);
    }
  }

  const subtreeIds = new Set<string>();
  const pending = [...rootIds];
  for (let index = 0; index < pending.length; index += 1) {
    const sessionId = pending[index];
    if (subtreeIds.has(sessionId)) continue;
    subtreeIds.add(sessionId);
    pending.push(...(childrenByParent.get(sessionId) ?? []));
  }
  return subtreeIds;
};
