import React from 'react';

import { sameCommentOrigin, type DiffCommentOrigin } from '@/lib/diffCommentOrigin';
import { normalizePath } from '@/lib/pathNormalization';
import { useUIStore } from '@/stores/useUIStore';
import { isFindRevealFor } from '@/components/views/diffView/diffData';
import type { DiffScope, FileEntry } from '@/components/views/diffView/types';

interface DiffViewCommentLocationOptions {
    visible: boolean;
    activeDiffScope: DiffScope;
    effectiveDirectory: string | undefined;
    changedFiles: FileEntry[];
    comparisonKey: string | null;
    comparisonFiles: readonly { path: string }[] | null;
    comparisonLoading: boolean;
    commentOrigin: DiffCommentOrigin | undefined;
    scrollToLocation: (target: { filePath: string; lineNumber: number; side: 'additions' | 'deletions' }) => void;
    revealListedFile: (path: string) => void;
}

export function useDiffViewCommentLocation({
    visible, activeDiffScope, effectiveDirectory, changedFiles, comparisonKey, comparisonFiles,
    comparisonLoading, commentOrigin, scrollToLocation, revealListedFile,
}: DiffViewCommentLocationOptions) {
    const pendingCommentLocation = useUIStore((state) => state.pendingCommentLocation);
    const setPendingCommentLocation = useUIStore((state) => state.setPendingCommentLocation);
    const [commentFullContext, setCommentFullContext] = React.useState<{ path: string; comparisonKey: string | null } | null>(null);

    React.useEffect(() => {
        const request = pendingCommentLocation;
        if (!visible || !request) return;
        if (normalizePath(request.directory) !== normalizePath(effectiveDirectory ?? '')) return;
        const scope: DiffScope = request.origin.kind === 'change-request' ? 'pr' : request.origin.kind === 'commit' ? 'commit' : 'branch';
        if (activeDiffScope !== scope) return;
        if (!sameCommentOrigin(commentOrigin, request.origin)) return;
        const rowPath = changedFiles.find((file) => file.path === request.filePath || isFindRevealFor(file.path, request.filePath))?.path;
        if (rowPath === undefined) {
            if (comparisonFiles !== null && !comparisonLoading) setPendingCommentLocation(null);
            return;
        }
        setPendingCommentLocation(null);
        if (request.line === null) {
            revealListedFile(rowPath);
            return;
        }
        setCommentFullContext({ path: rowPath, comparisonKey });
        scrollToLocation({ filePath: rowPath, lineNumber: request.line, side: request.side });
    }, [activeDiffScope, changedFiles, commentOrigin, comparisonFiles, comparisonKey, comparisonLoading, effectiveDirectory, pendingCommentLocation, revealListedFile, scrollToLocation, setPendingCommentLocation, visible]);

    return commentFullContext;
}
