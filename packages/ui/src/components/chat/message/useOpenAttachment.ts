import React from 'react';

import { useMobileAppActions } from '@/apps/mobileAppContext';
import { RuntimeAPIContext } from '@/contexts/runtimeAPIContext';
import { useEffectiveDirectory } from '@/hooks/useEffectiveDirectory';
import type { AttachmentOpenTarget } from '@/lib/messages/attachmentPreview';
import { getDirectoryForFilePath } from '@/lib/path-utils';
import { openExternalUrl } from '@/lib/url';
import { useUIStore } from '@/stores/useUIStore';
import type { ToolPopupContent } from './types';

/**
 * Opens what an attachment of a sent message resolves to. A file attached by
 * path opens like any file path in the chat: in the editor in VS Code, in the
 * Files drawer in the mobile app, in a Files tab elsewhere.
 */
export function useOpenAttachment(onShowPopup: ((content: ToolPopupContent) => void) | undefined) {
    const runtime = React.useContext(RuntimeAPIContext);
    const mobileActions = useMobileAppActions();
    const effectiveDirectory = useEffectiveDirectory();

    return React.useCallback((target: AttachmentOpenTarget) => {
        if (target.kind === 'external') {
            void openExternalUrl(target.url);
            return;
        }
        if (target.kind === 'popup') {
            onShowPopup?.(target.popup);
            return;
        }
        if (runtime?.editor) {
            void runtime.editor.openFile(target.path);
            return;
        }
        const directory = effectiveDirectory || getDirectoryForFilePath(effectiveDirectory, target.path);
        useUIStore.getState().openContextFile(directory, target.path);
        mobileActions?.openFiles();
    }, [effectiveDirectory, mobileActions, onShowPopup, runtime]);
}
