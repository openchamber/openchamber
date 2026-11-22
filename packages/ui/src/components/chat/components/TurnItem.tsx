import React from 'react';

import { useDeviceInfo } from '@/lib/device';
import { useUIStore } from '@/stores/useUIStore';
import { cn } from '@/lib/utils';
import { turnHeaderCanStick } from '../lib/turns/stickyPrompt';
import type { ChatMessageEntry, Turn } from '../lib/turns/types';
import ModelChangeDivider from './ModelChangeDivider';

interface TurnItemProps {
    turn: Turn;
    renderMessage: (message: ChatMessageEntry) => React.ReactNode;
    gapBelow?: boolean;
    /** Set when this turn's real model differs from the one before it (round-robin, failover, or a manual switch). */
    modelChange?: { from: string; to: string };
}

const stickyHeaderBackground = (fadeRem: string): React.CSSProperties => ({
    backgroundImage:
        `linear-gradient(to bottom, var(--surface-background) calc(100% - ${fadeRem}), transparent)`,
});
const STICKY_HEADER_BACKGROUND_DESKTOP = stickyHeaderBackground('2.25rem');
const STICKY_HEADER_BACKGROUND_MOBILE = stickyHeaderBackground('0.75rem');

const TurnItem: React.FC<TurnItemProps> = ({ turn, renderMessage, modelChange, gapBelow = false }) => {
    const { isMobile } = useDeviceInfo();
    const stickyUserHeader = useUIStore((state) => state.stickyUserHeader);
    const headerSticks = React.useMemo(
        () => stickyUserHeader && turnHeaderCanStick(turn.userMessage),
        [stickyUserHeader, turn.userMessage]
    );

    const hasNotices = Boolean(turn.waitingNotices?.length);
    return (
        <section
            className={cn(
                'relative w-full',
                gapBelow && 'pb-2',
                headerSticks && isMobile && 'pointer-events-none [&>*]:pointer-events-auto',
                headerSticks && isMobile && !hasNotices && 'pb-4',
            )}
            id={`turn-${turn.turnId}`}
            data-turn-id={turn.turnId}
            data-scroll-spy-id={turn.turnId}
        >
            {modelChange ? (
                <ModelChangeDivider
                    from={modelChange.from}
                    to={modelChange.to}
                    assistantMessageId={turn.assistantMessages[0]?.info.id}
                />
            ) : null}
            {headerSticks ? (
                <div
                    className="sticky top-0 z-20 [overflow-anchor:none]"
                    data-turn-sticky-header=""
                    style={isMobile ? STICKY_HEADER_BACKGROUND_MOBILE : STICKY_HEADER_BACKGROUND_DESKTOP}
                >
                    <div className="relative z-10">
                        {renderMessage(turn.userMessage)}
                    </div>
                </div>
            ) : (
                renderMessage(turn.userMessage)
            )}

            {hasNotices ? (
                <div className={cn(headerSticks && isMobile && 'mt-4')}>
                    {turn.waitingNotices?.map((notice) => (
                        <React.Fragment key={notice.info.id}>{renderMessage(notice)}</React.Fragment>
                    ))}
                </div>
            ) : null}
        </section>
    );
};

export default React.memo(TurnItem);
