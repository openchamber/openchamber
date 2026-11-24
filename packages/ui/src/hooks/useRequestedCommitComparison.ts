import React from 'react';

import { useCommitComparison } from '@/hooks/useCommitComparison';
import type { GitLogEntry } from '@/lib/api/types';

interface RequestedCommitComparisonOptions {
    directory: string | null;
    branch: string | null;
    enabled: boolean;
    requestedHash?: string | null;
    commitLimit?: number;
}

export function useRequestedCommitComparison({
    directory, branch, enabled, requestedHash: openingHash = null, commitLimit,
}: RequestedCommitComparisonOptions) {
    const selectionKey = JSON.stringify([directory, branch]);
    const [requested, setRequested] = React.useState<{ selectionKey: string; hash: string } | null>(null);
    React.useEffect(() => {
        if (openingHash) setRequested({ selectionKey, hash: openingHash });
    }, [openingHash, selectionKey]);
    const requestedHash = requested?.selectionKey === selectionKey ? requested.hash : null;
    const commitComparison = useCommitComparison(directory, branch, enabled, requestedHash ?? undefined, commitLimit);
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
