import React from 'react';
import { lazyWithChunkRecovery } from '@/lib/chunkLoadRecovery';

// Guest surfaces load on demand: VS Code and mobile never mount them, and the
// composer must not pay for the guest bridge before an extension is installed.
export const GuestAttachDialog: React.LazyExoticComponent<typeof import('@/components/layout/GuestAttachDialog').GuestAttachDialog> = React.lazy(() => import('@/components/layout/GuestAttachDialog').then((module) => ({ default: module.GuestAttachDialog })));

// Lazy like in ChatMessage: a static import would pull the @pierre/diffs and
// Shiki stacks into the eager startup graph for a dialog opened on demand.
export const ToolOutputDialog: React.LazyExoticComponent<typeof import('../../message/ToolOutputDialog').default> = lazyWithChunkRecovery(() => import('../../message/ToolOutputDialog'));
