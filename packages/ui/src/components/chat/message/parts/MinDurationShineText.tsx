import React from 'react';
import { Text } from '@/components/ui/text';

const MAX_SHINE_DURATION_MS = 5 * 60 * 1000; // 5 minutes cap

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
    // Once active, we latch shine on and only turn it off after active becomes
    // false AND minDurationMs has elapsed since we first started shining.
    // All bookkeeping lives in refs so intermediate re-renders (children
    // changing, props updating) can never cause a flicker.
    const shineStartRef = React.useRef<number | null>(active ? Date.now() : null);
    const [isShining, setIsShining] = React.useState(active);
    const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

    // Latch on: if active becomes true, start shining immediately.
    if (active && shineStartRef.current === null) {
        shineStartRef.current = Date.now();
    }
    if (active && !isShining) {
        // Synchronous state set during render is fine for a latch-on — React
        // will coalesce it with the current render pass.
        // But we can't call setState during render, so we use an effect below.
    }

    React.useEffect(() => {
        if (active) {
            // Cancel any pending off-timer.
            if (timerRef.current !== null) {
                clearTimeout(timerRef.current);
                timerRef.current = null;
            }
            if (shineStartRef.current === null) {
                shineStartRef.current = Date.now();
            }
            
            // Cap shine duration at 5 minutes max to prevent infinite shine on stuck tools
            const elapsed = Date.now() - shineStartRef.current;
            if (elapsed >= MAX_SHINE_DURATION_MS) {
                setIsShining(false);
                shineStartRef.current = null;
                return;
            }
            
            setIsShining(true);
            return;
        }

        if (!isShining) {
            shineStartRef.current = null;
            return;
        }

        // active went false — schedule turn-off respecting minDurationMs.
        const startedAt = shineStartRef.current ?? Date.now();
        const elapsed = Date.now() - startedAt;
        
        // Cap shine duration at 5 minutes max to prevent infinite shine on stuck tools
        if (elapsed >= MAX_SHINE_DURATION_MS) {
            setIsShining(false);
            shineStartRef.current = null;
            return;
        }
        
        const remaining = Math.max(0, minDurationMs - elapsed);

        timerRef.current = setTimeout(() => {
            setIsShining(false);
            shineStartRef.current = null;
            timerRef.current = null;
        }, remaining);

        return () => {
            if (timerRef.current !== null) {
                clearTimeout(timerRef.current);
                timerRef.current = null;
            }
        };
    }, [active, minDurationMs, isShining]);

    if (isShining) {
        return (
            <Text variant="shine" className={className} title={title}>
                {children}
            </Text>
        );
    }

    return (
        <span className={className} style={style} title={title}>
            {children}
        </span>
    );
};
