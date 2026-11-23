import React from 'react';
import { SessionFolderItem } from '../../SessionFolderItem';
import type { SessionNode } from '../types';
import { useCollapsedSessionActivityState } from '../sessions/collapsedActivityState';

type Props = React.ComponentProps<typeof SessionFolderItem<SessionNode>> & {
  activityNodes: readonly SessionNode[];
};

export function SessionSidebarFolderItem({ activityNodes, ...props }: Props): React.ReactNode {
  const collapsedActivityState = useCollapsedSessionActivityState({
    nodes: activityNodes,
    enabled: props.isCollapsed && !props.archivedBucket,
  });
  return <SessionFolderItem {...props} collapsedActivityState={collapsedActivityState} />;
}
