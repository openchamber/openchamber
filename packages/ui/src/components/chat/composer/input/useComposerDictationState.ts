import React from 'react';



export function useComposerDictationState() {
    const dictationSendInFlightRef = React.useRef(false);
    // The record-and-send overlay holds the composer open until its submit
    // settles; the hold is released here (both handlers cover every exit).
    const dictationSendEndRef = React.useRef<(() => void) | null>(null);

    return {
        dictationSendInFlightRef, dictationSendEndRef,
    };
}
