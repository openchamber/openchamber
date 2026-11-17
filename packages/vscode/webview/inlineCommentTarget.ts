export interface CommentTargetSnapshot {
    currentSessionId: string | null;
    sessionDirectory: string | null;
    draftOpen: boolean;
    draftDirectory: string | null;
    currentDirectory: string | null;
}

export interface CommentTarget {
    directory: string;
    sessionKey: string;
}

export function resolveCommentTarget(snapshot: CommentTargetSnapshot, targetSessionId?: string): CommentTarget | null {
    const { currentSessionId } = snapshot;
    if (targetSessionId) {
        if (currentSessionId !== targetSessionId) return null;
        const directory = snapshot.sessionDirectory ?? snapshot.currentDirectory;
        return directory ? { directory, sessionKey: targetSessionId } : null;
    }
    if (currentSessionId) {
        const directory = snapshot.sessionDirectory ?? snapshot.currentDirectory;
        return directory ? { directory, sessionKey: currentSessionId } : null;
    }
    if (snapshot.draftOpen) {
        const directory = snapshot.draftDirectory ?? snapshot.currentDirectory;
        return directory ? { directory, sessionKey: 'draft' } : null;
    }
    return null;
}
