import * as React from 'react';

import { revalidateReferences } from '@/components/references/referenceCache';
import { subscribeOpenchamberEvents } from '@/lib/openchamberEvents';

/**
 * Keeps the board's lists and preview current. The desktop board stays
 * mounted while closed, so without this it shows what it read when a list was
 * first shown. While the board is on screen, anything read more than a minute
 * ago is read again when it opens, when the user comes back to the window,
 * and when an agent turn finishes, since the agent may have opened or closed
 * something. The state of what a list shows follows the host on its own
 * (`references/liveReferences.ts`); this brings in what joins or leaves it.
 */
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
