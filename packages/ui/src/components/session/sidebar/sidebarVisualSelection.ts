import { flushSync } from 'react-dom';

import { beginSessionSwitchMeasure, markSessionSwitchHighlightPainted } from '@/lib/sessionSwitchPerf';
import {
    announceSessionSwitchIntent,
    getSessionSwitchIntent,
    subscribeSessionSwitchIntent,
    type SessionSwitchIntent,
} from '@/lib/sessionSwitchIntent';
import {
    createDefaultProjectSessionFocus,
    isSessionFocusEqual,
    useSessionFocusStore,
    type SessionFocusIdentity,
} from '@/stores/useSessionFocusStore';

export { useSessionFocusStore as useSidebarVisualSelectionStore } from '@/stores/useSessionFocusStore';

type SidebarVisualSelectionTarget = SessionFocusIdentity | string;

type PendingSelection = {
    commit: () => void;
    commitFrame: number | null;
    fallbackTimer: number | null;
    intent: SessionSwitchIntent;
    paintFrame: number | null;
    scheduled: boolean;
    focus: SessionFocusIdentity;
};

let pendingSelection: PendingSelection | null = null;
let announcingRequestedSelection = false;

const resolveSessionFocus = (
    target: SidebarVisualSelectionTarget | null,
    currentFocus: SessionFocusIdentity | null = useSessionFocusStore.getState().focus,
): SessionFocusIdentity | null => {
    if (target === null) return null;
    if (typeof target !== 'string') return target;
    if (currentFocus?.sessionId === target) return currentFocus;
    return createDefaultProjectSessionFocus(target);
};

const cancelFrames = (pending: PendingSelection): void => {
    if (typeof window === 'undefined') {
        return;
    }
    if (pending.commitFrame !== null) {
        window.cancelAnimationFrame(pending.commitFrame);
    }
    if (pending.paintFrame !== null) {
        window.cancelAnimationFrame(pending.paintFrame);
    }
    if (pending.fallbackTimer !== null) {
        window.clearTimeout(pending.fallbackTimer);
    }
};

export const cancelPendingSidebarVisualSelection = (): void => {
    if (!pendingSelection) {
        return;
    }
    cancelFrames(pendingSelection);
    pendingSelection = null;
};

export const requestSidebarVisualSelection = (
    target: SidebarVisualSelectionTarget,
    commit: () => void,
): void => {
    cancelPendingSidebarVisualSelection();
    beginSessionSwitchMeasure(true);
    const focus = resolveSessionFocus(target);
    if (!focus) return;
    announcingRequestedSelection = true;
    let intent: SessionSwitchIntent;
    try {
        intent = announceSessionSwitchIntent(focus.sessionId);
    } finally {
        announcingRequestedSelection = false;
    }
    pendingSelection = {
        commit,
        commitFrame: null,
        fallbackTimer: null,
        focus,
        intent,
        paintFrame: null,
        scheduled: false,
    };
    flushSync(() => {
        useSessionFocusStore.getState().setFocus(focus);
    });
    if (typeof window !== 'undefined') {
        pendingSelection.fallbackTimer = window.setTimeout(() => {
            notifySidebarVisualSelectionCommitted(focus);
        }, 150);
    }
};

export const notifySidebarVisualSelectionCommitted = (target: SidebarVisualSelectionTarget): void => {
    const pending = pendingSelection;
    const focus = resolveSessionFocus(target);
    if (!pending || !isSessionFocusEqual(pending.focus, focus) || pending.scheduled) {
        return;
    }
    pending.scheduled = true;
    if (typeof window !== 'undefined' && pending.fallbackTimer !== null) {
        window.clearTimeout(pending.fallbackTimer);
        pending.fallbackTimer = null;
    }

    const commitPendingSelection = () => {
        if (pendingSelection !== pending || getSessionSwitchIntent() !== pending.intent) {
            return;
        }
        pendingSelection = null;
        markSessionSwitchHighlightPainted();
        pending.commit();
    };

    if (typeof window === 'undefined') {
        commitPendingSelection();
        return;
    }

    // This interaction owns its paint barrier instead of joining the shared
    // background hydration queue. The first rAF lets the visual row selection
    // paint; the second commits session authority before the following paint.
    pending.commitFrame = window.requestAnimationFrame(() => {
        if (pendingSelection !== pending || getSessionSwitchIntent() !== pending.intent) {
            return;
        }
        pending.paintFrame = window.requestAnimationFrame(commitPendingSelection);
    });
};

export const syncSidebarVisualSelection = (
    target: SidebarVisualSelectionTarget | null,
): void => {
    if (pendingSelection) {
        return;
    }
    const state = useSessionFocusStore.getState();
    state.setFocus(resolveSessionFocus(target, state.focus));
};

subscribeSessionSwitchIntent((intent) => {
    if (announcingRequestedSelection) {
        return;
    }
    const pending = pendingSelection;
    if (pending?.intent === intent) {
        return;
    }
    if (pending) {
        cancelPendingSidebarVisualSelection();
    }
    const state = useSessionFocusStore.getState();
    state.setFocus(resolveSessionFocus(intent.sessionId, state.focus));
});
