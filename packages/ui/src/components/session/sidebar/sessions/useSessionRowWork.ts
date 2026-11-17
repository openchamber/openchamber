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
  ownsWork: boolean;
  archivedBucket: boolean;
  groupDirectory: string | null | undefined;
  pinnedSessionIds: Set<string>;
  sessionDirectory: string | null;
  isStreaming: boolean;
};

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
  const canTrackWork = sessionWorkEnabled && ownsWork && !archivedBucket && !node.session.parentID && !isChatDirectoryPath(node.session.directory)
    && !isSessionPinned(pinnedSessionIds, normalizePath(node.session.directory ?? null) ?? normalizePath(groupDirectory ?? null), node.session.id);
  const workSessionsInWork = React.useMemo(
    () => (canTrackWork ? collectSessionWorkInWork(node) : []),
    [canTrackWork, node],
  );
  const isInWork = workSessionsInWork.length > 0;
  const showDoneHint = isInWork && !isStreaming && isDoneSuggested(session);
  const toggleWork = () => { void toggleSessionWork(session.id, sessionDirectory, workSessionsInWork, t); };
  return { canTrackWork, isInWork, showDoneHint, toggleWork };
}
