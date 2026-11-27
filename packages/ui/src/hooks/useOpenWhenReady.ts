import React from 'react';

export const useOpenWhenReady = (owner: string | null, ready: boolean, unavailable: boolean, setOpen: (open: boolean) => void) => {
    const [wanted, setWanted] = React.useState<{ owner: string | null } | null>(null);

    React.useEffect(() => {
        if (!wanted) return;
        if (ready || unavailable || wanted.owner !== owner) {
            setWanted(null);
            if (ready && wanted.owner === owner) setOpen(true);
            return;
        }
        const drop = () => setWanted(null);
        document.addEventListener('pointerdown', drop, true);
        document.addEventListener('keydown', drop, true);
        window.addEventListener('blur', drop);
        return () => {
            document.removeEventListener('pointerdown', drop, true);
            document.removeEventListener('keydown', drop, true);
            window.removeEventListener('blur', drop);
        };
    }, [owner, ready, setOpen, unavailable, wanted]);

    return React.useCallback((open: boolean) => {
        if (ready) setOpen(open);
        else setWanted(open && !unavailable ? { owner } : null);
    }, [owner, ready, setOpen, unavailable]);
};
