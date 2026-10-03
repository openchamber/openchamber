import React from 'react';

import { useDeviceInfo } from '@/lib/device';
import type { ChatMessageEntry, Turn } from '../lib/turns/types';
import TurnAssistantBlock from './TurnAssistantBlock';

interface TurnItemProps {
    turn: Turn;
    stickyUserHeader?: boolean;
    renderMessage: (message: ChatMessageEntry) => React.ReactNode;
    assistantContent?: React.ReactNode;
}

/**
 * The sticky user header paints the chat background so assistant content scrolling
 * underneath disappears behind it. The soft edge lives in the header's own background
 * instead of an overlay below it: the bottom strip of the header box fades the
 * background out, and that strip sits over the empty space the user bubble already
 * reserves below itself. At rest the strip reveals the identical page background
 * (`--background` is generated from the same `surface.background` token), so it is
 * invisible and can never wash over the assistant content that follows.
 *
 * The strip's height follows the reserve: on desktop the user row keeps the whole
 * 44px gap to the reply (it hosts the hover action row, see `ChatMessage`), so the
 * strip is 2.25rem and the solid background still ends 8px under the bubble; on
 * mobile the header ends with the always-visible actions row instead, and the
 * 0.75rem strip stays clear of it.
 */
const stickyHeaderBackground = (fadeRem: string): React.CSSProperties => ({
    backgroundImage:
        `linear-gradient(to bottom, var(--surface-background) calc(100% - ${fadeRem}), transparent)`,
});
const STICKY_HEADER_BACKGROUND_DESKTOP = stickyHeaderBackground('2.25rem');
const STICKY_HEADER_BACKGROUND_MOBILE = stickyHeaderBackground('0.75rem');

const TurnItem: React.FC<TurnItemProps> = ({ turn, stickyUserHeader = true, renderMessage, assistantContent }) => {
    const { isMobile } = useDeviceInfo();
    return (
        <section
            className="relative w-full"
            id={`turn-${turn.turnId}`}
            data-turn-id={turn.turnId}
            data-scroll-spy-id={turn.turnId}
        >
            {stickyUserHeader ? (
                <div
                    className="sticky top-0 z-20 [overflow-anchor:none]"
                    style={isMobile ? STICKY_HEADER_BACKGROUND_MOBILE : STICKY_HEADER_BACKGROUND_DESKTOP}
                >
                    <div className="relative z-10">
                        {renderMessage(turn.userMessage)}
                    </div>
                </div>
            ) : (
                renderMessage(turn.userMessage)
            )}

            {assistantContent ?? <TurnAssistantBlock turnId={turn.turnId} assistantMessages={turn.assistantMessages} renderMessage={renderMessage} />}
        </section>
    );
};

export default React.memo(TurnItem);
