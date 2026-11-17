import React from 'react';
import { useBtwStore } from '@/stores/useBtwStore';
import { usePermissionStore } from '@/stores/permissionStore';



export function useComposerPermissionSettings(currentSessionId: string | null) {
    const setSessionMode = usePermissionStore((state) => state.setSessionMode);

    const pendingBtwPermissionMode = useBtwStore(React.useCallback(
        (state) => currentSessionId ? state.byParent[currentSessionId]?.pendingPermissionMode : undefined,
        [currentSessionId],
    ));

    return {
        setSessionMode, pendingBtwPermissionMode,
    };
}
