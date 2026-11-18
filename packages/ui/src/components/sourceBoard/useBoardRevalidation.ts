import * as React from 'react';

import { revalidateReferences } from '@/components/references/referenceCache';
import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';

export function useBoardRevalidation(onScreen: boolean): void {
    React.useEffect(() => {
        if (!onScreen) return undefined;
        revalidateReferences();
        const onReturn = () => {
            if (document.visibilityState === 'visible') revalidateReferences();
        };
        window.addEventListener('focus', onReturn);
        document.addEventListener('visibilitychange', onReturn);
        const releaseEvents = subscribeOpenchamberEvents((event) => {
            if (event.type === 'source-control-activity') revalidateReferences();
        });
        return () => {
            window.removeEventListener('focus', onReturn);
            document.removeEventListener('visibilitychange', onReturn);
            releaseEvents();
        };
    }, [onScreen]);
}
