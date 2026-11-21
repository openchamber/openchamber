import React from 'react';



export function useComposerDictationState() {
    const dictationSendInFlightRef = React.useRef(false);
    const dictationSendEndRef = React.useRef<(() => void) | null>(null);

    return {
        dictationSendInFlightRef, dictationSendEndRef,
    };
}
