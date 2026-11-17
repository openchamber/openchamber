import React from 'react';
import { PlainDiffFallback } from '../PlainDiffFallback';
import { isToolDiffPreviewOversized } from '../toolDiffPreview';
import { lazyWithChunkRecovery } from '@/lib/chunkLoadRecovery';
import { type DiffViewMode } from '../../DiffViewToggle';

const LazyToolPartDiffPreview = lazyWithChunkRecovery(() => import('../ToolPartDiffPreview'));

export const DiffPreview: React.FC<{ diff: string; diffViewMode: DiffViewMode }> = ({ diff, diffViewMode }) => {
    if (isToolDiffPreviewOversized(diff)) return <PlainDiffFallback diff={diff} />;

    return (
        <React.Suspense fallback={<PlainDiffFallback diff={diff} />}>
            <LazyToolPartDiffPreview diff={diff} diffViewMode={diffViewMode} />
        </React.Suspense>
    );
};
