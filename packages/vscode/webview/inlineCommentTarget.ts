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

export interface InlineCommentRecord {
    draftId?: unknown;
    filePath?: unknown;
    relativePath?: unknown;
    source?: unknown;
    side?: unknown;
    startLine?: unknown;
    endLine?: unknown;
    code?: unknown;
    language?: unknown;
    comment?: unknown;
    targetSessionId?: unknown;
    openInComposer?: unknown;
}

export function needsComposerDraft(snapshot: CommentTargetSnapshot, openInComposer: boolean, targetSessionId?: string): boolean {
    return openInComposer && !targetSessionId && !snapshot.currentSessionId && !snapshot.draftOpen;
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
