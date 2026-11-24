import React from 'react';

import { useMobileAppActions } from '@/apps/mobileAppContext';
import { toast } from '@/components/ui';
import { FULL_CONTEXT_DIFF_LINES } from '@/components/views/diffView/diffContextLines';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import { useI18n } from '@/lib/i18n';
import { opencodeClient } from '@/lib/opencode/client';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';

import { openTurnFileDiffInEditor } from './openTurnFileDiffInEditor';

export type TurnDiffTarget = {
    directory: string | null;
    file: string;
    sessionId: string | null;
    turnId?: string;
};

export function useOpenTurnDiff() {
    const { t } = useI18n();
    const isMobile = useUIStore((state) => state.isMobile);
    const navigateToDiff = useUIStore((state) => state.navigateToDiff);
    const openContextDiff = useUIStore((state) => state.openContextDiff);
    const setPendingTurnDiffFile = useUIStore((state) => state.setPendingTurnDiffFile);
    const mobileActions = useMobileAppActions();
    const runtime = React.useContext(RuntimeAPIContext);

    return React.useCallback(({ directory, file, sessionId, turnId }: TurnDiffTarget) => {
        const editor = runtime?.editor;
        if (runtime?.runtime.isVSCode && editor && directory) {
            if (!sessionId) return;
            void opencodeClient.getSessionTurnDiff(sessionId, { directory, from: turnId, context: FULL_CONTEXT_DIFF_LINES })
                .then((turnDiff) => openTurnFileDiffInEditor({ directory, editor, file, turnDiff }))
                .catch(() => toast.error(t('diffView.state.failedToLoadDiff')));
            return;
        }

        if (mobileActions) {
            mobileActions.openChanges({ diffPath: file, scope: 'turn', turnId, sessionId, directory });
            return;
        }

        setPendingTurnDiffFile({ file, sessionId, turnId, panelSessionId: useSessionUIStore.getState().currentSessionId });
        if (!isMobile && directory) {
            openContextDiff(directory, file, false, 'turn');
            return;
        }

        navigateToDiff(file, false, 'turn');
    }, [isMobile, mobileActions, navigateToDiff, openContextDiff, runtime, setPendingTurnDiffFile, t]);
}
