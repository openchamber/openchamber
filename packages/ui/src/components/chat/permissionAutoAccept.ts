export type PermissionAutoAcceptToggleArgs = {
    permissionScopeSessionId: string | null;
    newSessionDraftOpen: boolean;
    draftPermissionAutoAcceptEnabled: boolean;
    permissionAutoAcceptEnabled: boolean;
    setDraftPermissionAutoAcceptEnabled: (enabled: boolean) => void;
    setSessionAutoAccept: (sessionId: string, enabled: boolean) => Promise<void>;
    onOpenSessionFirst: () => void;
    onToggleFailed: () => void;
};

export const togglePermissionAutoAccept = (args: PermissionAutoAcceptToggleArgs): void => {
    const {
        permissionScopeSessionId,
        newSessionDraftOpen,
        draftPermissionAutoAcceptEnabled,
        permissionAutoAcceptEnabled,
        setDraftPermissionAutoAcceptEnabled,
        setSessionAutoAccept,
        onOpenSessionFirst,
        onToggleFailed,
    } = args;

    if (!permissionScopeSessionId) {
        if (!newSessionDraftOpen) {
            onOpenSessionFirst();
            return;
        }

        setDraftPermissionAutoAcceptEnabled(!draftPermissionAutoAcceptEnabled);
        return;
    }

    const nextEnabled = !permissionAutoAcceptEnabled;
    void setSessionAutoAccept(permissionScopeSessionId, nextEnabled).catch(onToggleFailed);
};
