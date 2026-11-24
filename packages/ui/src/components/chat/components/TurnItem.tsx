import React from 'react';

import { useDeviceInfo } from '@/lib/device';
import { useUIStore } from '@/stores/useUIStore';
import { cn } from '@/lib/utils';
import { turnHeaderCanStick } from '../lib/turns/stickyPrompt';
import { stickyHeaderBackground } from './stickyHeaderBackground';
import type { ChatMessageEntry, Turn } from '../lib/turns/types';

interface TurnItemProps {
    turn: Turn;
    renderMessage: (message: ChatMessageEntry) => React.ReactNode;
    gapBelow?: boolean;
}

/**
 * A turn's first list row: its prompt, and the notices that came before its
 * first step. The turn's work and answer are the rows after it
 * (`timelineRows.ts`); this row alone names the turn in the DOM, and it is the
 * one the list keeps on top while the turn scrolls under it.
 *
 * The user row restyles itself inside the header through `in-data-[turn-sticky-header]`
 * variants, so the setting re-renders turns only, never every message row.
 */
const TurnItem: React.FC<TurnItemProps> = ({ turn, renderMessage, gapBelow = false }) => {
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
            {headerSticks ? (
                <div
                    className="sticky top-0 z-20 [overflow-anchor:none]"
                    data-turn-sticky-header=""
                    style={stickyHeaderBackground(isMobile)}
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
