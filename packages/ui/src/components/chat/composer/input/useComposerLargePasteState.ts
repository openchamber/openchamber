import React from 'react';
import { LargeTextPasteGesture } from '../../composer/largeTextPaste';
import { type LargeTextPasteChoiceAction } from '../../composer/ui/LargeTextPasteChoice';



export function useComposerLargePasteState() {
    const [largeTextPasteOffer, setLargeTextPasteOffer] = React.useState<{
        id: number;
        resolve: (action: LargeTextPasteChoiceAction, explicitlyChosen: boolean, typedText?: string) => void;
    } | null>(null);

    const largeTextPasteOfferIdRef = React.useRef(0);

    const [largeTextPasteGesture] = React.useState(() => new LargeTextPasteGesture());

    return {
        largeTextPasteOffer, setLargeTextPasteOffer, largeTextPasteOfferIdRef, largeTextPasteGesture,
    };
}
