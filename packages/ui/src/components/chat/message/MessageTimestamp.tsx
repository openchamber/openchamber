import React from 'react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { useRelativeTick } from '@/lib/useRelativeTick';
import { formatRelativeMessageTime } from '@/lib/timeFormat';
import { formatTimestampForDisplay } from '@/components/chat/message/timeFormat';
import { useUIStore } from '@/stores/useUIStore';
import type { MessageTimestampFormatPreference, TimeFormatPreference } from '@/stores/useUIStore';

interface MessageTimestampProps {
    completedAt: number | null;
    createdAt: number | null;
    className?: string;
}

const MINUTE_MS = 60_000;

const isUsableTimestamp = (value: unknown): value is number => {
    return typeof value === 'number' && Number.isFinite(value) && value > 0;
};

interface AbsoluteTimestampProps {
    timestamp: number;
    timeFormatPreference: TimeFormatPreference;
    className?: string;
}

const AbsoluteTimestamp: React.FC<AbsoluteTimestampProps> = React.memo(({ timestamp, timeFormatPreference, className }) => {
    const { locale } = useI18n();
    const visible = React.useMemo(() => {
        void locale;
        return formatTimestampForDisplay(timestamp, timeFormatPreference);
    }, [timestamp, timeFormatPreference, locale]);

    if (!visible) return null;

    const iso = new Date(timestamp).toISOString();

    return (
        <time
            dateTime={iso}
            title={visible}
            aria-label={visible}
            className={cn('text-muted-foreground/60 tabular-nums', className)}
        >
            {visible}
        </time>
    );
});

interface RelativeTimestampProps {
    timestamp: number;
    format: Extract<MessageTimestampFormatPreference, 'relative' | 'hybrid'>;
    thresholdMinutes: number;
    timeFormatPreference: TimeFormatPreference;
    className?: string;
}

const RelativeTimestamp: React.FC<RelativeTimestampProps> = React.memo(({ timestamp, format, thresholdMinutes, timeFormatPreference, className }) => {
    const { locale } = useI18n();
    const now = useRelativeTick();

    const { visible, ariaLabel, useAbsolute } = React.useMemo(() => {
        void locale;
        const absoluteLabel = formatTimestampForDisplay(timestamp, timeFormatPreference);
        const age = now - timestamp;
        const thresholdMs = thresholdMinutes * MINUTE_MS;
        const shouldUseAbsolute = format === 'hybrid' && age >= thresholdMs;
        const relativeVisible = formatRelativeMessageTime(timestamp, now);
        return {
            visible: shouldUseAbsolute ? absoluteLabel : relativeVisible,
            ariaLabel: absoluteLabel,
            useAbsolute: shouldUseAbsolute,
        };
    }, [timestamp, now, format, thresholdMinutes, timeFormatPreference, locale]);

    if (!visible) return null;

    const iso = new Date(timestamp).toISOString();

    return (
        <time
            dateTime={iso}
            title={ariaLabel}
            aria-label={ariaLabel}
            className={cn('text-muted-foreground/60 tabular-nums', className)}
            data-use-absolute={useAbsolute ? 'true' : undefined}
        >
            {visible}
        </time>
    );
});

export const MessageTimestamp: React.FC<MessageTimestampProps> = ({ completedAt, createdAt, className }) => {
    const format = useUIStore((state) => state.messageTimestampFormat);
    const thresholdMinutes = useUIStore((state) => state.messageTimestampHybridThresholdMinutes);
    const timeFormatPreference = useUIStore((state) => state.timeFormatPreference);

    const timestamp = isUsableTimestamp(completedAt) ? completedAt : (isUsableTimestamp(createdAt) ? createdAt : null);

    if (timestamp === null) return null;
    if (format === 'hidden') return null;

    if (format === 'absolute') {
        return <AbsoluteTimestamp timestamp={timestamp} timeFormatPreference={timeFormatPreference} className={className} />;
    }

    return (
        <RelativeTimestamp
            timestamp={timestamp}
            format={format}
            thresholdMinutes={thresholdMinutes}
            timeFormatPreference={timeFormatPreference}
            className={className}
        />
    );
};

export default React.memo(MessageTimestamp);
