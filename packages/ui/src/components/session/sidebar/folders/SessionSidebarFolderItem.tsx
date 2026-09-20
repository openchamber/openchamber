import React from 'react';
import { SessionFolderItem } from '../../SessionFolderItem';
import type { SessionNode } from '../types';
import { useCollapsedSessionActivityState } from '../sessions/collapsedActivityState';

type Props = React.ComponentProps<typeof SessionFolderItem<SessionNode>> & {
  notifyOnSubtasks: boolean;
  activityNodes: readonly SessionNode[];
};

/** Keep activity subscriptions on the mounted folder row, not the entire list. */
export function SessionSidebarFolderItem({ notifyOnSubtasks, activityNodes, ...props }: Props): React.ReactNode {
  const collapsedActivityState = useCollapsedSessionActivityState({
    nodes: activityNodes,
    includeUnreadSubtasks: notifyOnSubtasks,
    enabled: props.isCollapsed && !props.archivedBucket,
  });
  return <SessionFolderItem {...props} collapsedActivityState={collapsedActivityState} />;
}
