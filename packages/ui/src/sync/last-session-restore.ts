import { normalizePath } from '@/lib/pathNormalization';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { ensureGlobalSessionsLoaded, refreshGlobalSessions, resolveGlobalSessionDirectory, useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useSessionUIStore } from './session-ui-store';
import { clearLastActiveSession, readLastActiveSession } from './last-session-cache';

export type LastSessionRestoreResult =
    /** The session left open last time is selected again. */
    | 'restored'
    /** Nothing to restore: no pointer, the session is gone, or something else was opened meanwhile. */
    | 'none'
    /** The session list could not be read; the pointer is kept for a later attempt. */
    | 'failed';

/**
 * The session load resolves even when the server could not be read (OpenCode
 * still starting, a network error): it then returns the cached or fallback
 * list and marks the store `error`. Only a completed load may say a session is
 * gone.
 */
const isSessionListAuthoritative = (): boolean => {
    const { hasLoaded, status } = useGlobalSessionsStore.getState();
    return hasLoaded && status !== 'error';
};

const loadSessionList = (refresh: boolean) =>
    (refresh ? refreshGlobalSessions() : ensureGlobalSessionsLoaded()).catch(() => null);

/**
 * Reopens the session that was open when the app last closed, on launch.
 *
 * The pointer is written on every session switch and dropped when the user
 * opens a draft themselves (`openNewSessionDraft`), so it names exactly what
 * was on screen at close. The automatic boot draft does not count as a
 * choice and is replaced. Anything opened while the session list loads (a
 * link, a click) wins, as does a user draft, which clears the pointer.
 */
export const restoreLastActiveSession = async (options: {
    /** Read the session list fresh rather than accept one already loaded (mobile reconnects). */
    readonly refresh: boolean;
}): Promise<LastSessionRestoreResult> => {
    if (useSessionUIStore.getState().currentSessionId) return 'none';
    const runtimeKey = getRuntimeKey();
    const persisted = readLastActiveSession(runtimeKey);
    if (!persisted) return 'none';

    const snapshot = await loadSessionList(options.refresh);
    // A switch to another instance meanwhile makes this pointer and list foreign.
    if (getRuntimeKey() !== runtimeKey) return 'none';
    if (!snapshot || !isSessionListAuthoritative()) return 'failed';

    const session = snapshot.activeSessions.find((entry) => entry.id === persisted.sessionId);
    if (!session) {
        // The authoritative list says it is gone (deleted or archived): drop
        // the stale pointer instead of retrying it on every launch.
        clearLastActiveSession(runtimeKey);
        return 'none';
    }

    const latest = useSessionUIStore.getState();
    if (latest.currentSessionId || readLastActiveSession(runtimeKey)?.sessionId !== persisted.sessionId) {
        return 'none';
    }
    void latest.setCurrentSession(
        session.id,
        resolveGlobalSessionDirectory(session) ?? persisted.directory ?? undefined,
    );
    return 'restored';
};

type ReopenedSession = { readonly runtimeKey: string; readonly sessionId: string };

/**
 * Selects the last session at once, before the session list confirms it, so
 * the launch never shows the automatic draft first. Needs the session's
 * directory without asking OpenCode: the pointer's own, or the persisted
 * session list's. Returns null when it selected nothing.
 */
const reopenLastActiveSession = (): ReopenedSession | null => {
    const ui = useSessionUIStore.getState();
    if (ui.currentSessionId) return null;
    const runtimeKey = getRuntimeKey();
    const persisted = readLastActiveSession(runtimeKey);
    if (!persisted) return null;
    const cached = useGlobalSessionsStore.getState().entityById.get(persisted.sessionId);
    const directory = persisted.directory ?? (cached ? resolveGlobalSessionDirectory(cached) : null);
    if (!directory) return null;
    void ui.setCurrentSession(persisted.sessionId, directory);
    return { runtimeKey, sessionId: persisted.sessionId };
};

/**
 * Checks a reopened session against the authoritative session list. A session
 * the list no longer holds (deleted or archived) loses its pointer, and the
 * chat falls back to the draft unless the user has opened something else
 * since. A session that moved directories is reselected in its new one.
 */
const confirmReopenedSession = async (reopened: ReopenedSession): Promise<LastSessionRestoreResult> => {
    const snapshot = await loadSessionList(false);
    if (getRuntimeKey() !== reopened.runtimeKey) return 'none';
    if (!snapshot || !isSessionListAuthoritative()) return 'failed';

    const latest = useSessionUIStore.getState();
    const stillOpen = latest.currentSessionId === reopened.sessionId;
    const session = snapshot.activeSessions.find((entry) => entry.id === reopened.sessionId);
    if (session) {
        const directory = normalizePath(resolveGlobalSessionDirectory(session));
        if (stillOpen && directory && directory !== latest.currentSessionDirectory) {
            void latest.setCurrentSession(session.id, directory);
        }
        return 'restored';
    }
    if (readLastActiveSession(reopened.runtimeKey)?.sessionId === reopened.sessionId) {
        clearLastActiveSession(reopened.runtimeKey);
    }
    if (stillOpen) void latest.setCurrentSession(null);
    return 'none';
};

/**
 * Launch restore for the web and desktop shell. Call it before the chat's
 * first passive effects, which open the automatic draft when nothing is
 * selected. With `selectNow` it selects the last session at once when its
 * directory is known; otherwise, or without a directory, it waits for the
 * session list as `restoreLastActiveSession` does. Returns the confirmation
 * attempt; `failed` means the session list could not be read yet, and the
 * caller runs the attempt again once startup completes.
 */
export const beginLastSessionRestore = (options: {
    /** False when a route already names a session to open. */
    readonly selectNow: boolean;
}): (() => Promise<LastSessionRestoreResult>) => {
    const reopened = options.selectNow ? reopenLastActiveSession() : null;
    return reopened
        ? () => confirmReopenedSession(reopened)
        : () => restoreLastActiveSession({ refresh: false });
};
