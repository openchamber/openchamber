import React from 'react';

import { ComposerRecordingSlotContext, clearComposerRecording, publishComposerRecording } from '@/lib/dictation/composerRecording';
import type { DictationStatusActions, FieldRecordingView } from '@/lib/dictation/fieldDictation';

export function useComposerRecordingPublication(view: FieldRecordingView, controls: DictationStatusActions): void {
    const slotId = React.useContext(ComposerRecordingSlotContext);
    const ownerId = React.useId();
    const controlsRef = React.useRef(controls);
    React.useLayoutEffect(() => {
        controlsRef.current = controls;
    });
    const [actions] = React.useState<DictationStatusActions>(() => ({
        finish: () => controlsRef.current.finish(),
        cancel: () => controlsRef.current.cancel(),
        retry: () => controlsRef.current.retry(),
        discard: () => controlsRef.current.discard(),
        acceptPartial: () => controlsRef.current.acceptPartial(),
        subscribeLevel: (listener) => controlsRef.current.subscribeLevel(listener),
    }));

    const { status, duration, error, errorReason, partialTranscript } = view;
    React.useLayoutEffect(() => {
        if (slotId === null || status === 'idle') {
            clearComposerRecording(ownerId);
            return;
        }
        publishComposerRecording({ ownerId, slotId, view: { status, duration, error, errorReason, partialTranscript }, actions });
    }, [actions, duration, error, errorReason, ownerId, partialTranscript, slotId, status]);
    React.useEffect(() => () => clearComposerRecording(ownerId), [ownerId]);
}
