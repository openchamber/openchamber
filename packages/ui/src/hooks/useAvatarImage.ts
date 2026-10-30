import * as React from 'react';

/**
 * Whether an avatar image has failed to load. The failure resets when the URL
 * changes, so a new URL gets a chance to load normally.
 */
export const useAvatarImage = (url: string | null | undefined): { broken: boolean; onError: () => void } => {
    const [broken, setBroken] = React.useState(false);
    const lastUrl = React.useRef(url);
    if (lastUrl.current !== url) {
        lastUrl.current = url;
        setBroken(false);
    }
    return { broken, onError: () => setBroken(true) };
};
