import React from 'react';
import { isAbsoluteFilePath } from '@/lib/path-utils';
import type { PendingDiffScope } from '@/stores/useUIStore';
import type { DiffScope } from './types';

interface DiffViewNavigationOptions {
    visible: boolean;
    activeDiffScope: DiffScope;
    pendingDiffScope: PendingDiffScope | null;
    pendingDiffFile: string | null;
    pendingDiffStaged: boolean;
    setActiveDiffScope: React.Dispatch<React.SetStateAction<DiffScope>>;
    setDisplayFile: React.Dispatch<React.SetStateAction<string | null>>;
    setDisplayFileStaged: React.Dispatch<React.SetStateAction<boolean>>;
    setPendingDiffFile: (file: string | null) => void;
    shouldPinAfterAlignRef: React.RefObject<boolean>;
    pendingScrollTargetRef: React.RefObject<string | null>;
    expandStackedFile: (path: string) => void;
    setScrollRequestNonce: React.Dispatch<React.SetStateAction<number>>;
    targetFilePath: string | null;
}

export function useDiffViewNavigation({
    visible, activeDiffScope, pendingDiffScope, pendingDiffFile, setActiveDiffScope, setDisplayFile,
    setDisplayFileStaged, pendingDiffStaged, setPendingDiffFile, shouldPinAfterAlignRef, pendingScrollTargetRef,
    expandStackedFile, setScrollRequestNonce, targetFilePath,
}: DiffViewNavigationOptions) {
    React.useEffect(() => {
        if (!visible || (activeDiffScope !== 'all' && !pendingDiffScope)) {
            return;
        }
        if (pendingDiffFile) {
            if (pendingDiffScope) {
                setActiveDiffScope(pendingDiffScope);
            }
            setDisplayFile(pendingDiffFile);
            setDisplayFileStaged(pendingDiffScope === 'staged' || (!pendingDiffScope && pendingDiffStaged));
            setPendingDiffFile(null);
            shouldPinAfterAlignRef.current = true;
            pendingScrollTargetRef.current = pendingDiffFile;
            expandStackedFile(pendingDiffFile);
            setScrollRequestNonce((value) => value + 1);
        }
    }, [activeDiffScope, expandStackedFile, pendingDiffFile, pendingDiffScope, pendingDiffStaged, setPendingDiffFile, visible]);

    React.useEffect(() => {
        if (activeDiffScope === 'all') {
            return;
        }
        const normalizedTarget = targetFilePath?.trim();
        if (!normalizedTarget || isAbsoluteFilePath(normalizedTarget)) {
            return;
        }
        setDisplayFile(normalizedTarget);
        setDisplayFileStaged(activeDiffScope === 'staged');
        shouldPinAfterAlignRef.current = true;
        pendingScrollTargetRef.current = normalizedTarget;
        expandStackedFile(normalizedTarget);
        setScrollRequestNonce((value) => value + 1);
    }, [activeDiffScope, expandStackedFile, targetFilePath]);
}
