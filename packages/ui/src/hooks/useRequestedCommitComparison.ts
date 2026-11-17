import React from 'react';

import { useCommitComparison } from '@/hooks/useCommitComparison';
import type { GitLogEntry } from '@/lib/api/types';
import { normalizePath } from '@/lib/pathNormalization';
import { useUIStore } from '@/stores/useUIStore';

interface RequestedCommitComparisonOptions {
    comparisonDirectory: string | null;
    requestDirectory: string | null;
    branch: string | null;
    enabled: boolean;
}

export function useRequestedCommitComparison({
    comparisonDirectory, requestDirectory, branch, enabled,
}: RequestedCommitComparisonOptions) {
    const pendingCommentLocation = useUIStore((state) => state.pendingCommentLocation);
    const selectionKey = JSON.stringify([comparisonDirectory, branch]);
    const [requested, setRequested] = React.useState<{ selectionKey: string; hash: string } | null>(null);
    const openingHash = pendingCommentLocation?.origin.kind === 'commit'
        && normalizePath(pendingCommentLocation.directory) === normalizePath(requestDirectory ?? '')
        ? pendingCommentLocation.origin.hash
        : null;
    React.useEffect(() => {
        if (openingHash) setRequested({ selectionKey, hash: openingHash });
    }, [openingHash, selectionKey]);
    const requestedHash = requested?.selectionKey === selectionKey ? requested.hash : null;
    const commitComparison = useCommitComparison(comparisonDirectory, branch, enabled, requestedHash ?? undefined);
    const selectedCommitHash = requestedHash ?? commitComparison.selectedCommit?.hash ?? null;
    const select = commitComparison.select;
    React.useEffect(() => {
        if (!requestedHash) return;
        const match = commitComparison.commits.find((commit) => commit.hash === requestedHash);
        if (!match) return;
        if (commitComparison.selectedCommit?.hash === match.hash) {
            setRequested(null);
            return;
        }
        select(match);
    }, [commitComparison.commits, commitComparison.selectedCommit?.hash, requestedHash, select]);
    const chooseCommit = React.useCallback((commit: GitLogEntry) => {
        setRequested(null);
        select(commit);
    }, [select]);
    return { commitComparison, selectedCommitHash, chooseCommit };
}
