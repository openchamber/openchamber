import { getRuntimeKey } from '@/lib/runtime-switch';
import { ensureGlobalSessionsLoaded, refreshGlobalSessions, resolveGlobalSessionDirectory } from '@/stores/useGlobalSessionsStore';
import { useSessionUIStore } from './session-ui-store';
import { clearLastActiveSession, readLastActiveSession } from './last-session-cache';

type LastSessionRestoreResult =
    /** The session left open last time is selected again. */
    | 'restored'
    /** Nothing to restore: no pointer, the session is gone, or something else was opened meanwhile. */
    | 'none'
    /** The session list could not be read; the pointer is kept for the next launch. */
    | 'failed';

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

    const snapshot = await (options.refresh ? refreshGlobalSessions() : ensureGlobalSessionsLoaded()).catch(() => null);
    // A switch to another instance meanwhile makes this pointer and list foreign.
    if (getRuntimeKey() !== runtimeKey) return 'none';
    if (!snapshot) return 'failed';

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
