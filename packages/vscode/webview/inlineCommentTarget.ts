/**
 * Where a comment arriving from the editor should be filed.
 *
 * Inline drafts are keyed by directory and session, and the composer reads
 * exactly one key: the current session's, or `draft` while a new-session draft
 * is open. A panel that has just been opened knows its directory before it has
 * selected its session, so filing on the first snapshot that has a directory
 * put the draft under `draft`, a key that panel's composer never reads. The
 * chip never appeared while the editor thread reported it attached.
 */

export interface CommentTargetSnapshot {
    currentSessionId: string | null;
    /** The current session's directory, when the session has one. */
    sessionDirectory: string | null;
    /** Whether a new-session draft is open, and the directory it points at. */
    draftOpen: boolean;
    draftDirectory: string | null;
    /** The webview's current directory, the last resort. */
    currentDirectory: string | null;
}

export interface CommentTarget {
    directory: string;
    sessionKey: string;
}

/**
 * The draft key for this snapshot, or null while the surface is not yet
 * showing the session the comment is for.
 *
 * @param targetSessionId the session the extension delivered the comment to,
 *   when it knows one (a session panel); undefined for the sidebar and a
 *   new-session panel, which file wherever their composer currently is
 */
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
    // No session and no draft yet: the surface is still booting.
    return null;
}
