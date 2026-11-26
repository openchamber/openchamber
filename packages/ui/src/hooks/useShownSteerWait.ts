import React from 'react';
import { afterDelay } from '@/lib/timing/afterDelay';

const STEER_WAIT_GRACE_MS = 1500;

const remainingGrace = (createdAt: number | null): number => {
    if (createdAt === null || createdAt <= 0) return STEER_WAIT_GRACE_MS;
    return Math.min(STEER_WAIT_GRACE_MS, Math.max(0, createdAt + STEER_WAIT_GRACE_MS - Date.now()));
};

export const useShownSteerWait = (waiting: boolean, createdAt: number | null): boolean => {
    const [firstCreatedAt] = React.useState(createdAt);
    const [shown, setShown] = React.useState(() => waiting && remainingGrace(firstCreatedAt) === 0);

    React.useEffect(() => {
        if (!waiting) {
            setShown(false);
            return;
        }
        const grace = remainingGrace(firstCreatedAt);
        if (grace === 0) {
            setShown(true);
            return;
        }
        return afterDelay(grace, () => setShown(true));
    }, [waiting, firstCreatedAt]);

    return waiting && shown;
};
