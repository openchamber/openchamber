import React from 'react';

import { sameCommentOrigin, type DiffCommentOrigin } from '@/lib/diffCommentOrigin';
import { normalizePath } from '@/lib/pathNormalization';
import { useUIStore } from '@/stores/useUIStore';

type MobileChangesCommentMode = 'working' | 'turn' | 'branch' | 'commit' | 'pr';

type ComparisonMode = 'branch' | 'commit' | 'pr';

interface MobileChangesCommentNavigationOptions {
    ownerKey: string;
    rootDirectory: string;
    mode: MobileChangesCommentMode;
    comparisonKey: string | null;
    comparisonFiles: readonly { path: string }[] | null;
    commentOrigin: DiffCommentOrigin | undefined;
    openComparison: (mode: ComparisonMode) => void;
    openComparisonFile: (path: string, sourceKey: string) => void;
}

const comparisonModeOf = (origin: DiffCommentOrigin): ComparisonMode => (
    origin.kind === 'change-request' ? 'pr' : origin.kind === 'commit' ? 'commit' : 'branch'
);

export function useMobileChangesCommentNavigation({
    ownerKey, rootDirectory, mode, comparisonKey, comparisonFiles, commentOrigin,
    openComparison, openComparisonFile,
}: MobileChangesCommentNavigationOptions) {
    const pendingCommentLocation = useUIStore((state) => state.pendingCommentLocation);
    const setPendingCommentLocation = useUIStore((state) => state.setPendingCommentLocation);
    const nonce = React.useRef(0);
    const [commentTarget, setCommentTarget] = React.useState<{ path: string; sourceKey: string; line: number; side: 'additions' | 'deletions'; nonce: number } | null>(null);
    const [fullContextTarget, setFullContextTarget] = React.useState<{ path: string; sourceKey: string } | null>(null);

    React.useEffect(() => {
        const request = pendingCommentLocation;
        if (!request) return;
        if (normalizePath(request.directory) !== normalizePath(rootDirectory)) return;
        openComparison(comparisonModeOf(request.origin));
    }, [openComparison, pendingCommentLocation, rootDirectory]);

    const clearTargets = React.useCallback(() => {
        setCommentTarget(null);
        setFullContextTarget(null);
    }, []);

    React.useEffect(() => {
        clearTargets();
    }, [clearTargets, mode, ownerKey]);

    React.useEffect(() => {
        const request = pendingCommentLocation;
        if (!request || !comparisonFiles || !comparisonKey) return;
        if (normalizePath(request.directory) !== normalizePath(rootDirectory)) return;
        if (mode !== comparisonModeOf(request.origin)) return;
        if (!sameCommentOrigin(commentOrigin, request.origin)) return;
        setPendingCommentLocation(null);
        if (!comparisonFiles.some((file) => file.path === request.filePath)) return;
        if (request.line !== null) {
            setFullContextTarget({ path: request.filePath, sourceKey: comparisonKey });
            setCommentTarget({
                path: request.filePath, sourceKey: comparisonKey, line: request.line, side: request.side,
                nonce: nonce.current += 1,
            });
        }
        openComparisonFile(request.filePath, comparisonKey);
    }, [commentOrigin, comparisonFiles, comparisonKey, mode, openComparisonFile, pendingCommentLocation, rootDirectory, setPendingCommentLocation]);

    const onTargetReached = React.useCallback(() => setCommentTarget(null), []);
    const commentFullContextPath = fullContextTarget && fullContextTarget.sourceKey === comparisonKey ? fullContextTarget.path : null;
    return { commentTarget, commentFullContextPath, onTargetReached, clearCommentTargets: clearTargets };
}
