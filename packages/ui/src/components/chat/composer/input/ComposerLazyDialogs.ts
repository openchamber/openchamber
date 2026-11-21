import React from 'react';
import { lazyWithChunkRecovery } from '@/lib/chunkLoadRecovery';

export const GuestAttachDialog: React.LazyExoticComponent<typeof import('@/components/layout/GuestAttachDialog').GuestAttachDialog> = React.lazy(() => import('@/components/layout/GuestAttachDialog').then((module) => ({ default: module.GuestAttachDialog })));

export const ToolOutputDialog: React.LazyExoticComponent<typeof import('../../message/ToolOutputDialog').default> = lazyWithChunkRecovery(() => import('../../message/ToolOutputDialog'));
