import React from 'react';

import { useDeviceInfo } from '@/lib/device';
import { useUIStore } from '@/stores/useUIStore';
import { cn } from '@/lib/utils';
import { isHiddenUserMessage } from '../message/hiddenUserMessage';
import type { ChatMessageEntry, Turn } from '../lib/turns/types';
import TurnAssistantBlock from './TurnAssistantBlock';

interface TurnItemProps {
    turn: Turn;
    renderMessage: (message: ChatMessageEntry) => React.ReactNode;
    assistantContent?: React.ReactNode;
}

/**
 * The sticky user header paints the chat background so assistant content scrolling
 * underneath disappears behind it. The soft edge lives in the header's own background
 * instead of an overlay below it: the bottom strip of the header box fades the
 * background out, and that strip sits over the empty space the user row already
 * reserves below the bubble. At rest the strip reveals the identical page background
 * (`--background` is generated from the same `surface.background` token), so it is
 * invisible and can never wash over the assistant content that follows.
 *
 * The strip's height follows the reserve: on desktop the user row keeps a 44px gap
 * to the reply (the hover action row plus `ChatMessage`'s sticky padding), so the
 * strip is 2.25rem and the solid background still ends 8px under the bubble; on
 * mobile the header ends with the always-visible actions row instead, and the
 * 0.75rem strip stays clear of it.
 *
 * The user row restyles itself inside the header through `in-data-[turn-sticky-header]`
 * variants, so the setting re-renders turns only, never every message row.
 */
const stickyHeaderBackground = (fadeRem: string): React.CSSProperties => ({
    backgroundImage:
        `linear-gradient(to bottom, var(--surface-background) calc(100% - ${fadeRem}), transparent)`,
});
const STICKY_HEADER_BACKGROUND_DESKTOP = stickyHeaderBackground('2.25rem');
const STICKY_HEADER_BACKGROUND_MOBILE = stickyHeaderBackground('0.75rem');

const TurnItem: React.FC<TurnItemProps> = ({ turn, renderMessage, assistantContent }) => {
    const { isMobile } = useDeviceInfo();
    const stickyUserHeader = useUIStore((state) => state.stickyUserHeader);
    // A hidden prompt has nothing to pin, and a turn opened by anything but
    // a prompt (a background report, a compaction, a notice after an answer)
    // opens as a notice row, which never sticks.
    const headerSticks = React.useMemo(
        () => stickyUserHeader
            && turn.userMessage.info.role === 'user'
            && !isHiddenUserMessage(turn.userMessage),
        [stickyUserHeader, turn.userMessage]
    );

    return (
        <section
            // On mobile the header ends right at its actions row, so the reply
            // keeps its distance below it and scrolls away with the reply.
            className={cn('relative w-full', headerSticks && isMobile && '[&>[data-turn-sticky-header]+*]:mt-4')}
            id={`turn-${turn.turnId}`}
            data-turn-id={turn.turnId}
            data-scroll-spy-id={turn.turnId}
        >
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

            {turn.waitingNotices?.map((notice) => (
                <React.Fragment key={notice.info.id}>{renderMessage(notice)}</React.Fragment>
            ))}
            {assistantContent ?? <TurnAssistantBlock turnId={turn.turnId} assistantMessages={turn.assistantMessages} renderMessage={renderMessage} />}
        </section>
    );
};

export default React.memo(TurnItem);
