import React from 'react';

import { registerBackLayer } from '@/lib/mobileBackLayers';

export const usePreviewDismissLayer = (open: boolean, onOpenChange: (open: boolean) => void): void => {
    const onOpenChangeRef = React.useRef(onOpenChange);
    React.useLayoutEffect(() => {
        onOpenChangeRef.current = onOpenChange;
    }, [onOpenChange]);

    React.useEffect(() => {
        if (!open) {
            return;
        }

        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                event.stopPropagation();
                onOpenChangeRef.current(false);
            }
        };

        window.addEventListener('keydown', onKeyDown, { capture: true });
        const unregister = registerBackLayer(() => onOpenChangeRef.current(false));
        return () => {
            window.removeEventListener('keydown', onKeyDown, { capture: true });
            unregister();
        };
    }, [open]);
};
