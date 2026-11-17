import React from 'react';

import { useMessageSelecting, useMessageSelectionStore } from '@/stores/useMessageSelectionStore';
import { useLoadedSessionMessageRecords } from '@/sync/use-sync';
import { listSelectableUnits } from './selectableUnits';

export const MESSAGE_SELECT_UNIT_ATTRIBUTE = 'data-message-select-unit';

export const useMessageSelectionClicks = (sessionId: string | null | undefined, directory: string | null | undefined) => {
    const selecting = useMessageSelecting(sessionId);
    const readLoadedRecords = useLoadedSessionMessageRecords();
    const onClickCapture = React.useCallback((event: React.MouseEvent<HTMLElement>) => {
        if (!sessionId || !(event.target instanceof Element)) return;
        const unit = event.target.closest(`[${MESSAGE_SELECT_UNIT_ATTRIBUTE}]`);
        const key = unit?.getAttribute(MESSAGE_SELECT_UNIT_ATTRIBUTE);
        if (!key) return;
        event.preventDefault();
        event.stopPropagation();
        const store = useMessageSelectionStore.getState();
        if (!event.shiftKey) {
            store.toggle(sessionId, key);
            return;
        }
        const records = directory ? readLoadedRecords({ directory, sessionID: sessionId }) : null;
        store.selectRange(sessionId, key, records ? listSelectableUnits(records).map((entry) => entry.key) : []);
    }, [directory, readLoadedRecords, sessionId]);
    return { selecting, onClickCapture: selecting ? onClickCapture : undefined };
};
