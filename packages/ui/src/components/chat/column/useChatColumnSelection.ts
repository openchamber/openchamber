import React from 'react';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useSessionRenderable } from '@/sync/sync-context';
import { useShownSessionSelection } from '../useShownSessionSelection';
import { usePinnedSessionDirectory } from '../usePinnedSessionDirectory';

const SESSION_SWITCH_HOLD_MS = 400;

export type PinnedSelection = { sessionId: string; directory: string | null };

export const useChatColumnSelection = ({
    pinnedSession,
    autoOpenDraft: autoOpenDraftProp,
}: {
    pinnedSession: PinnedSelection | undefined;
    autoOpenDraft: boolean;
}) => {
    const pinned = pinnedSession !== undefined;
    const autoOpenDraft = autoOpenDraftProp && !pinned;
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
    const draftOpen = useSessionUIStore((s) => !pinned && s.newSessionDraft.open);
    const liveSelection = React.useMemo(
        () => ({ sessionId: liveSessionId, directory: liveSessionDirectory }),
        [liveSessionId, liveSessionDirectory],
    );
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
    const { sessionId: currentSessionId, directory: currentSessionDirectory } = useShownSessionSelection(targetSelection, draftOpen);
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
        const live = useSessionUIStore.getState();
        if (live.currentSessionId || live.newSessionDraft.open) return;
        openNewSessionDraft({ automatic: true });
    }, [autoOpenDraft, liveSessionId, draftOpen, openNewSessionDraft]);
};
