import * as React from 'react';

export const useAvatarImage = (url: string | null | undefined): { broken: boolean; onError: () => void } => {
    const [broken, setBroken] = React.useState(false);
    const lastUrl = React.useRef(url);
    if (lastUrl.current !== url) {
        lastUrl.current = url;
        setBroken(false);
    }
    return { broken, onError: () => setBroken(true) };
};
