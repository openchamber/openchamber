import React from 'react';



export function useComposerAttachmentWork() {
    const pendingPastedAttachmentFilenamesRef = React.useRef<Set<string>>(new Set());

    const pendingAttachWorkRef = React.useRef<Set<Promise<void>>>(new Set());

    const waitForPendingAttachments = React.useCallback(async (): Promise<boolean> => {
        if (pendingAttachWorkRef.current.size === 0) return false;
        await Promise.allSettled([...pendingAttachWorkRef.current]);
        await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
        return true;
    }, []);

    return {
        pendingPastedAttachmentFilenamesRef, pendingAttachWorkRef, waitForPendingAttachments,
    };
}
