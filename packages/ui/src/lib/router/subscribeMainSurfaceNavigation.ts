import { useSessionUIStore } from '@/sync/session-ui-store';
import { useUIStore } from '@/stores/useUIStore';

/** Retire a main page when navigation selects a session or opens another draft. */
export function subscribeMainSurfaceNavigation(): () => void {
  return useSessionUIStore.subscribe((state, previous) => {
    const sessionSelected = Boolean(state.currentSessionId) && state.currentSessionId !== previous.currentSessionId;
    const draftOpened = state.newSessionDraft.open && (
      !previous.newSessionDraft.open || state.newSessionDraft.draftId !== previous.newSessionDraft.draftId
    );
    if (sessionSelected || draftOpened) useUIStore.getState().closeMainSurfaces();
  });
}
