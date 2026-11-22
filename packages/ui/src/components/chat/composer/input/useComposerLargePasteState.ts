import React from 'react';
import { LargeTextPasteGesture } from '../../composer/largeTextPaste';
import { type LargeTextPasteChoiceAction, type LargeTextPasteChoiceKind } from '../../composer/ui/LargeTextPasteChoice';



type LargeTextPasteOffer = {
    id: number;
    kind: LargeTextPasteChoiceKind;
    resolve: (action: LargeTextPasteChoiceAction, explicitlyChosen: boolean, typedText?: string) => void;
    onDismiss?: () => void;
};

export function useComposerLargePasteState() {
    const [largeTextPasteOffer, setOffer] = React.useState<LargeTextPasteOffer | null>(null);
    const offerRef = React.useRef<LargeTextPasteOffer | null>(null);

    const setLargeTextPasteOffer = React.useCallback((next: LargeTextPasteOffer | null) => {
        const previous = offerRef.current;
        offerRef.current = next;
        setOffer(next);
        if (previous && previous !== next) previous.onDismiss?.();
    }, []);

    const largeTextPasteOfferIdRef = React.useRef(0);

    const [largeTextPasteGesture] = React.useState(() => new LargeTextPasteGesture());

    return {
        largeTextPasteOffer, setLargeTextPasteOffer, largeTextPasteOfferIdRef, largeTextPasteGesture,
    };
}
