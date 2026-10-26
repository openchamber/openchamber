import { nextPermissionMode, type PermissionMode } from '@/stores/utils/permissionAutoAccept';

type PermissionModeCycleArgs = {
    permissionScopeSessionId: string | null;
    newSessionDraftOpen: boolean;
    /** The mode the button shows now, before `displayedPermissionMode` hides an unavailable safety net. */
    currentMode: PermissionMode;
    safetyAvailable: boolean;
    setDraftPermissionMode: (mode: PermissionMode) => void;
    setSessionMode: (sessionId: string, mode: PermissionMode) => Promise<void>;
    onOpenSessionFirst: () => void;
    onToggleFailed: () => void;
};

/** One press of the composer's shield button: the next mode, on the draft or on the session. */
export const cyclePermissionMode = (args: PermissionModeCycleArgs): void => {
    const {
        permissionScopeSessionId,
        newSessionDraftOpen,
        currentMode,
        safetyAvailable,
        setDraftPermissionMode,
        setSessionMode,
        onOpenSessionFirst,
        onToggleFailed,
    } = args;
    const next = nextPermissionMode(currentMode, safetyAvailable);

    if (!permissionScopeSessionId) {
        if (!newSessionDraftOpen) {
            onOpenSessionFirst();
            return;
        }

        setDraftPermissionMode(next);
        return;
    }

    void setSessionMode(permissionScopeSessionId, next).catch(onToggleFailed);
};
