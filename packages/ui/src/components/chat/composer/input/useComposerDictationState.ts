import React from 'react';
import type { DictationOrigin } from '../../composer/state/useDictationOrigin';



export function useComposerDictationState() {
    const dictationSendInFlightRef = React.useRef(false);
    const dictationSendEndRef = React.useRef<(() => void) | null>(null);
    const dictationOriginRef = React.useRef<DictationOrigin | null>(null);

    return {
        dictationSendInFlightRef, dictationSendEndRef, dictationOriginRef,
    };
}
