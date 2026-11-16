import React from 'react';
import { useI18n } from '@/lib/i18n';
import { isChatDirectoryPath } from '@/lib/chatDirectories';
import { isSessionPinned } from '@/lib/sessionPins';
import { isDoneSuggested } from '@/lib/sessionWorkMetadata';
import { useUIStore } from '@/stores/useUIStore';
import type { SessionNode } from '../types';
import { normalizePath } from '../utils';
import { collectSessionWorkInWork } from '../works/sidebarWorks';
import { toggleSessionWork } from './sessionWorkToggle';

type SessionRowWorkInput = {
  node: SessionNode;
  /** The row is a work of its own; a row inside one leaves Track / Done to it. */
  ownsWork: boolean;
  archivedBucket: boolean;
  groupDirectory: string | null | undefined;
  pinnedSessionIds: Set<string>;
  sessionDirectory: string | null;
  isStreaming: boolean;
};

/** Whether a row can be tracked as work, whether it is in work, and the Track / Done toggle. */
export function useSessionRowWork({
  node,
  ownsWork,
  archivedBucket,
  groupDirectory,
  pinnedSessionIds,
  sessionDirectory,
  isStreaming,
}: SessionRowWorkInput) {
  const { t } = useI18n();
  const session = node.session;
  const sessionWorkEnabled = useUIStore((state) => state.sessionWorkEnabled);
  // Track / Done belongs to the rows that are works: Chats are plain
  // conversations, never work, and a session nested in a work is tracked and
  // finished with it, or one group would mix tracked and finished sessions.
  // Touch layouts keep their actions permanently visible, where an icon on
  // every row would be noise: there it lives in the session menu only. A
  // pinned session is never in work, so it offers neither.
  const canTrackWork = sessionWorkEnabled && ownsWork && !archivedBucket && !node.session.parentID && !isChatDirectoryPath(node.session.directory)
    && !isSessionPinned(pinnedSessionIds, normalizePath(node.session.directory ?? null) ?? normalizePath(groupDirectory ?? null), node.session.id);
  // A root row is its work: the session with the reviews and btw sessions
  // nested under it. It is in work when any of them is,
  // and Done closes all of them.
  const workSessionsInWork = React.useMemo(
    () => (canTrackWork ? collectSessionWorkInWork(node) : []),
    [canTrackWork, node],
  );
  const isInWork = workSessionsInWork.length > 0;
  const showDoneHint = isInWork && !isStreaming && isDoneSuggested(session);
  const toggleWork = () => { void toggleSessionWork(session.id, sessionDirectory, workSessionsInWork, t); };
  return { canTrackWork, isInWork, showDoneHint, toggleWork };
}
