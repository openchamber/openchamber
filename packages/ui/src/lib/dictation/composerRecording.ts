import React from 'react';
import { create } from 'zustand';

import type { DictationStatusActions, FieldRecordingView } from './fieldDictation';

interface ComposerRecording {
    ownerId: string;
    slotId: string;
    view: FieldRecordingView;
    actions: DictationStatusActions;
}

export const ComposerRecordingSlotContext = React.createContext<string | null>(null);

export const ComposerPromptReadOnlyContext = React.createContext(false);

export const ComposerUnderMessageSelectionContext = React.createContext(false);

const useComposerRecordingStore = create<{ recording: ComposerRecording | null }>(() => ({ recording: null }));

export const publishComposerRecording = (recording: ComposerRecording): void => {
    useComposerRecordingStore.setState({ recording });
};

export const clearComposerRecording = (ownerId: string): void => {
    if (useComposerRecordingStore.getState().recording?.ownerId === ownerId) {
        useComposerRecordingStore.setState({ recording: null });
    }
};

export const useSlotComposerRecording = (slotId: string): ComposerRecording | null => (
    useComposerRecordingStore((state) => (state.recording?.slotId === slotId ? state.recording : null))
);

export const useSlotHasComposerRecording = (slotId: string): boolean => (
    useComposerRecordingStore((state) => state.recording?.slotId === slotId)
);

export const useOwnSlotComposerRecording = (): ComposerRecording | null => (
    useSlotComposerRecording(React.useContext(ComposerRecordingSlotContext) ?? '')
);

export const useOwnSlotHasComposerRecording = (): boolean => (
    useSlotHasComposerRecording(React.useContext(ComposerRecordingSlotContext) ?? '')
);
