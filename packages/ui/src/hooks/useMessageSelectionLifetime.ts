import React from 'react';

import { isIMECompositionEvent } from '@/lib/ime';
import { useMessageSelectionStore } from '@/stores/useMessageSelectionStore';
import { hasOpenDropdown } from './keyboard-shortcut-dom';

export const useEndMessageSelectionOnLeave = (sessionId: string | null | undefined): void => {
    React.useEffect(() => {
        if (!sessionId) return;
        return () => useMessageSelectionStore.getState().end(sessionId);
    }, [sessionId]);
};

export const useMessageSelectionEscape = (sessionId: string): void => {
    React.useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key !== 'Escape' || event.defaultPrevented || isIMECompositionEvent(event) || hasOpenDropdown()) return;
            if (document.querySelector('[role="dialog"][data-open], [role="alertdialog"][data-open]')) return;
            event.preventDefault();
            useMessageSelectionStore.getState().end(sessionId);
        };
        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [sessionId]);
};
