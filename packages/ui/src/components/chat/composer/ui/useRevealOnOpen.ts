import React from 'react';

export const useRevealOnOpen = (ref: React.RefObject<HTMLElement | null>, open: boolean): void => {
    const revealedRef = React.useRef(false);
    React.useEffect(() => {
        if (!open || revealedRef.current) return;
        revealedRef.current = true;
        ref.current?.scrollIntoView({ block: 'nearest' });
    }, [open, ref]);
};
