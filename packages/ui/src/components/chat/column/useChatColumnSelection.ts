import React from 'react';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSessionRenderable } from '@/sync/sync-context';
import { useShownSessionSelection } from '../useShownSessionSelection';
import { usePinnedSessionDirectory } from '../usePinnedSessionDirectory';

// How long the previous timeline stays on screen while a session that is not
// in memory loads, before the skeleton takes over.
const SESSION_SWITCH_HOLD_MS = 400;

export type PinnedSelection = { sessionId: string; directory: string | null };

/**
 * Which session the column shows. The selection is published synchronously by
 * the sidebar click, but the chat swaps its content on a deferred copy: the
 * first commit paints the cheap reactions (active row, URL, tab) while the
 * timeline for the new session renders in an interruptible transition behind
 * it. Both fields travel as one value so the key, the message subscription,
 * and the loader target never mix an old directory with a new session id. A
 * pinned column does not subscribe to the selection.
 */
export const useChatColumnSelection = ({
    pinnedSession,
    autoOpenDraft: autoOpenDraftProp,
}: {
    pinnedSession: PinnedSelection | undefined;
    autoOpenDraft: boolean;
}) => {
    const pinned = pinnedSession !== undefined;
    const autoOpenDraft = autoOpenDraftProp && !pinned;
    // A pinned column starts on its session and moves only through its own
    // navigation. A different session from the owner starts it over.
    const [pinnedOrigin, setPinnedOrigin] = React.useState<PinnedSelection | null>(pinnedSession ?? null);
    const [pinnedSelection, setPinnedSelection] = React.useState<PinnedSelection | null>(pinnedSession ?? null);
    if (pinnedSession && (pinnedSession.sessionId !== pinnedOrigin?.sessionId || pinnedSession.directory !== pinnedOrigin?.directory)) {
        setPinnedOrigin(pinnedSession);
        setPinnedSelection(pinnedSession);
    }
    const globalSessionId = useSessionUIStore((s) => (pinned ? null : s.currentSessionId));
    const globalSessionDirectory = useSessionUIStore((s) => (pinned ? null : s.currentSessionDirectory));
    const pinnedSessionDirectory = usePinnedSessionDirectory(pinned ? pinnedSelection : null);
    const liveSessionId = pinned ? (pinnedSessionDirectory ? pinnedSelection?.sessionId ?? null : null) : globalSessionId;
    const liveSessionDirectory = pinned ? pinnedSessionDirectory : globalSessionDirectory;
    const materializedDraftSessionId = useSessionUIStore((s) => (pinned ? null : s.materializedDraftSessionId));
    const liveSelection = React.useMemo(
        () => ({ sessionId: liveSessionId, directory: liveSessionDirectory }),
        [liveSessionId, liveSessionDirectory],
    );
    // A session whose messages are not in memory yet keeps the previous
    // timeline on screen while they load, instead of flashing a skeleton
    // between two conversations. The hold ends when the session becomes
    // renderable or after SESSION_SWITCH_HOLD_MS, whichever comes first, and
    // never applies when nothing was shown before or when the session was just
    // created from a draft.
    const liveSessionRenderable = useSessionRenderable(liveSessionId ?? '', liveSessionDirectory ?? undefined);
    const shownSelectionRef = React.useRef(liveSelection);
    const [expiredHoldSessionId, setExpiredHoldSessionId] = React.useState<string | null>(null);
    const holdPreviousTimeline = Boolean(liveSessionId)
        && !liveSessionRenderable
        && liveSessionId !== materializedDraftSessionId
        && shownSelectionRef.current.sessionId !== null
        && shownSelectionRef.current.sessionId !== liveSessionId
        && expiredHoldSessionId !== liveSessionId;
    React.useEffect(() => {
        if (!holdPreviousTimeline || !liveSessionId) return;
        const timer = window.setTimeout(() => setExpiredHoldSessionId(liveSessionId), SESSION_SWITCH_HOLD_MS);
        return () => window.clearTimeout(timer);
    }, [holdPreviousTimeline, liveSessionId]);
    const targetSelection = holdPreviousTimeline ? shownSelectionRef.current : liveSelection;
    const { sessionId: currentSessionId, directory: currentSessionDirectory } = useShownSessionSelection(targetSelection);
    shownSelectionRef.current = { sessionId: currentSessionId, directory: currentSessionDirectory };

    return {
        pinned,
        autoOpenDraft,
        pinnedOrigin,
        setPinnedSelection,
        liveSessionId,
        materializedDraftSessionId,
        currentSessionId,
        currentSessionDirectory,
    };
};

/**
 * Selection policy reads the live selection, not the deferred one: right after
 * a click the deferred id still names the previous session (or nothing) for
 * one commit, and acting on that would open a draft over the session the user
 * just chose.
 */
export const useAutoOpenDraft = ({
    autoOpenDraft,
    liveSessionId,
    draftOpen,
}: {
    autoOpenDraft: boolean;
    liveSessionId: string | null;
    draftOpen: boolean;
}): void => {
    const openNewSessionDraft = useSessionUIStore((s) => s.openNewSessionDraft);
    React.useEffect(() => {
        if (!autoOpenDraft || liveSessionId || draftOpen) return;
        // Checked again against the store when the effect runs: a session link
        // can select a session between this render and the effect (a startup
        // route, Strict Mode's effect replay), and a draft opened from the
        // stale render would throw that selection away.
        const live = useSessionUIStore.getState();
        if (live.currentSessionId || live.newSessionDraft.open) return;
        // Programmatic fallback, not user navigation — must not clear the
        // persisted last-session pointer the cold-launch restore reads.
        openNewSessionDraft({ automatic: true });
    }, [autoOpenDraft, liveSessionId, draftOpen, openNewSessionDraft]);
};
