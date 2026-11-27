import React from 'react';

import { requestCommentPullRequest } from './useReviewScopeCommentJump';
import { commentComparisonScope, commentRepository, type CommentComparisonScope, type CommentLocationRequest } from '@/lib/commentLocation';
import { changeRequestMoved, sameCommentOrigin, shortRef, type DiffCommentOrigin } from '@/lib/diffCommentOrigin';
import { normalizePath } from '@/lib/pathNormalization';


type MobileChangesCommentMode = 'working' | 'turn' | CommentComparisonScope;

type MobileCommentTarget = { path: string; sourceKey: string; line: number; side: 'additions' | 'deletions'; nonce: number };

export function useMobileChangesCommentNavigation({
    jump, done, leave, ownerKey, currentDirectory, mode, branch, branchBaseMissing, comparisonKey, comparisonFiles, comparisonError, commentOrigin,
    openComparison, openComparisonFile,
}: {
    jump: CommentLocationRequest | null;
    done: () => void;
    leave: () => void;
    ownerKey: string;
    currentDirectory: string;
    mode: MobileChangesCommentMode;
    branch: string | null;
    branchBaseMissing: boolean;
    comparisonKey: string | null;
    comparisonFiles: readonly { path: string }[] | null;
    comparisonError: string | null;
    commentOrigin: DiffCommentOrigin | undefined;
    openComparison: (mode: CommentComparisonScope) => void;
    openComparisonFile: (path: string, sourceKey: string) => void;
}) {
    const nonce = React.useRef(0);
    const startedRef = React.useRef<typeof jump>(null);
    const [commentTarget, setCommentTarget] = React.useState<MobileCommentTarget | null>(null);
    const [fullContextTarget, setFullContextTarget] = React.useState<{ path: string; sourceKey: string } | null>(null);
    const [unavailablePath, setUnavailablePath] = React.useState<string | null>(null);

    const clearTargets = React.useCallback(() => {
        setCommentTarget(null);
        setFullContextTarget(null);
        setUnavailablePath(null);
    }, []);

    React.useEffect(() => {
        clearTargets();
    }, [clearTargets, comparisonKey, mode, ownerKey]);

    React.useEffect(() => {
        const request = jump;
        if (!request) return;
        const scope = commentComparisonScope(request.origin);
        if (normalizePath(commentRepository(request)) !== normalizePath(currentDirectory)) {
            done();
            setUnavailablePath(request.filePath);
            return;
        }
        if (request.origin.kind === 'branch') {
            if (branch === null) return;
            if (shortRef(request.origin.headRef) !== branch) {
                done();
                return;
            }
            if (branchBaseMissing) {
                leave();
                setUnavailablePath(request.filePath);
                return;
            }
        }
        if (startedRef.current !== request) {
            startedRef.current = request;
            requestCommentPullRequest(currentDirectory, request);
            if (mode !== scope) {
                openComparison(scope);
                return;
            }
        }
        if (mode !== scope) {
            done();
            return;
        }
        if (changeRequestMoved(commentOrigin, request.origin)) {
            done();
            setUnavailablePath(request.filePath);
            return;
        }
        if (!comparisonKey || !sameCommentOrigin(commentOrigin, request.origin)) return;
        if (comparisonError !== null) {
            done();
            return;
        }
        if (!comparisonFiles) return;
        done();
        if (!comparisonFiles.some((file) => file.path === request.filePath)) return;
        if (request.line !== null) {
            setFullContextTarget({ path: request.filePath, sourceKey: comparisonKey });
            setCommentTarget({
                path: request.filePath, sourceKey: comparisonKey, line: request.line, side: request.side,
                nonce: nonce.current += 1,
            });
        }
        openComparisonFile(request.filePath, comparisonKey);
    }, [
        branch, branchBaseMissing, commentOrigin, comparisonError, comparisonFiles, comparisonKey, currentDirectory, done, jump, leave, mode,
        openComparison, openComparisonFile,
    ]);

    const onTargetReached = React.useCallback(() => setCommentTarget(null), []);
    const commentFullContextPath = fullContextTarget && fullContextTarget.sourceKey === comparisonKey ? fullContextTarget.path : null;
    return { commentTarget, commentFullContextPath, unavailablePath, onTargetReached, clearCommentTargets: clearTargets };
}
