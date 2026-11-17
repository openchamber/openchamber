import React from 'react';

import { useGitPanelInSpace } from '@/lib/spaces/useGitPanelInSpace';
import { SyncActions } from './SyncActions';

export const GitPanelSyncActions: React.FC<React.ComponentProps<typeof SyncActions>> = (props) => (useGitPanelInSpace() ? null : <SyncActions {...props} />);
