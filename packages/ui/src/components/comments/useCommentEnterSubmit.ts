import type React from 'react';

import { shouldSubmitEnter } from '@/components/chat/composer/keyboardPolicy';
import { useHardwareKeyboard } from '@/lib/hardwareKeyboard';
import { useUIStore } from '@/stores/useUIStore';

export function useCommentEnterSubmit(desktopSubmits = true) {
    const isMobile = useUIStore((state) => state.isMobile);
    const mobileReturnKeySends = useUIStore((state) => state.mobileReturnKeySends);
    const hasHardwareKeyboard = useHardwareKeyboard();

    return {
        returnKeySends: isMobile && mobileReturnKeySends,
        preserveDeferredEnterShift: !isMobile || !mobileReturnKeySends || hasHardwareKeyboard,
        shouldSubmit(event: Pick<React.KeyboardEvent, 'shiftKey' | 'ctrlKey' | 'metaKey' | 'altKey'>): boolean {
            return shouldSubmitEnter({
                isMobile,
                isDesktopExpanded: false,
                enterToSend: desktopSubmits,
                enterToSendConfigured: true,
                returnKeySends: mobileReturnKeySends,
                shiftKey: event.shiftKey,
                ctrlKey: event.ctrlKey,
                metaKey: event.metaKey,
                altKey: event.altKey,
            });
        },
    };
}
