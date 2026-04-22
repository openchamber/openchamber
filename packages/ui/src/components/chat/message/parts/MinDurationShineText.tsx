import React from 'react';
import { cn } from '@/lib/utils';

const MAX_BUSY_DURATION_MS = 5 * 60 * 1000; // 5 minutes cap

interface MinDurationShineTextProps {
    active: boolean;
    minDurationMs?: number;
    className?: string;
    children: React.ReactNode;
    style?: React.CSSProperties;
    title?: string;
}

export const MinDurationShineText: React.FC<MinDurationShineTextProps> = ({
    active,
    minDurationMs = 300,
    className,
    children,
    style,
    title,
}) => {
    const busyStartRef = React.useRef<number | null>(active ? Date.now() : null);
    const [isBusy, setIsBusy] = React.useState(active);
    const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

    if (active && busyStartRef.current === null) {
        busyStartRef.current = Date.now();
    }

    React.useEffect(() => {
        if (active) {
            if (timerRef.current !== null) {
                clearTimeout(timerRef.current);
                timerRef.current = null;
            }
            if (busyStartRef.current === null) {
                busyStartRef.current = Date.now();
            }

            const elapsed = Date.now() - busyStartRef.current;
            if (elapsed >= MAX_BUSY_DURATION_MS) {
                setIsBusy(false);
                busyStartRef.current = null;
                return;
            }

            setIsBusy(true);
            return;
        }

        if (!isBusy) {
            busyStartRef.current = null;
            return;
        }

        const startedAt = busyStartRef.current ?? Date.now();
        const elapsed = Date.now() - startedAt;

        if (elapsed >= MAX_BUSY_DURATION_MS) {
            setIsBusy(false);
            busyStartRef.current = null;
            return;
        }

        const remaining = Math.max(0, minDurationMs - elapsed);

        timerRef.current = setTimeout(() => {
            setIsBusy(false);
            busyStartRef.current = null;
            timerRef.current = null;
        }, remaining);

        return () => {
            if (timerRef.current !== null) {
                clearTimeout(timerRef.current);
                timerRef.current = null;
            }
        };
    }, [active, minDurationMs, isBusy]);

    return (
        <span
            className={cn('transition-opacity duration-200', isBusy && 'opacity-70', className)}
            style={style}
            title={title}
        >
            {children}
        </span>
    );
};
