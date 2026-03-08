import React from 'react';
import { Text } from '@/components/ui/text';

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
    const [isShining, setIsShining] = React.useState(active);
    const shineStartedAtRef = React.useRef<number | null>(active ? Date.now() : null);

    React.useEffect(() => {
        if (active) {
            if (shineStartedAtRef.current === null) {
                shineStartedAtRef.current = Date.now();
            }
            if (!isShining) {
                setIsShining(true);
            }
            return;
        }

        if (!isShining) {
            shineStartedAtRef.current = null;
            return;
        }

        const startedAt = shineStartedAtRef.current ?? Date.now();
        const elapsed = Date.now() - startedAt;
        const remaining = Math.max(0, minDurationMs - elapsed);

        if (remaining === 0) {
            setIsShining(false);
            shineStartedAtRef.current = null;
            return;
        }

        const timer = window.setTimeout(() => {
            setIsShining(false);
            shineStartedAtRef.current = null;
        }, remaining);

        return () => {
            window.clearTimeout(timer);
        };
    }, [active, isShining, minDurationMs]);

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
