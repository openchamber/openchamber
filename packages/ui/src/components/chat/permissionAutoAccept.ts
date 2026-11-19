import { nextPermissionMode, type PermissionMode } from '@/stores/utils/permissionAutoAccept';

type PermissionModeCycleArgs = {
    permissionScopeSessionId: string | null;
    newSessionDraftOpen: boolean;
    currentMode: PermissionMode;
    safetyAvailable: boolean;
    setDraftPermissionMode: (mode: PermissionMode) => void;
    setSessionMode: (sessionId: string, mode: PermissionMode) => Promise<void>;
    onOpenSessionFirst: () => void;
    onToggleFailed: () => void;
};

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
