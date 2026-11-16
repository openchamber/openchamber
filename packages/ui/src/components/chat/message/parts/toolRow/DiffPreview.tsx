import React from 'react';
import { PlainDiffFallback } from '../PlainDiffFallback';
import { isToolDiffPreviewOversized } from '../toolDiffPreview';
import { lazyWithChunkRecovery } from '@/lib/chunkLoadRecovery';
import { type DiffViewMode } from '../../DiffViewToggle';

// The rich diff preview is the only tool-card piece that needs the
// @pierre/diffs + Shiki stack; lazy-loading it keeps that stack out of the
// eager chat graph. While the chunk loads, the plain-text patch renders as the
// Suspense fallback, mirroring the preview's own error fallback.
const LazyToolPartDiffPreview = lazyWithChunkRecovery(() => import('../ToolPartDiffPreview'));

export const DiffPreview: React.FC<{ diff: string; diffViewMode: DiffViewMode }> = ({ diff, diffViewMode }) => {
    if (isToolDiffPreviewOversized(diff)) return <PlainDiffFallback diff={diff} />;

    return (
        <React.Suspense fallback={<PlainDiffFallback diff={diff} />}>
            <LazyToolPartDiffPreview diff={diff} diffViewMode={diffViewMode} />
        </React.Suspense>
    );
};
