import React from 'react';

import type { ChatMessageEntry, Turn } from '../lib/turns/types';
import TurnAssistantBlock from './TurnAssistantBlock';

interface TurnItemProps {
    turn: Turn;
    stickyUserHeader?: boolean;
    renderMessage: (message: ChatMessageEntry) => React.ReactNode;
}

/**
 * The sticky user header paints the chat background so assistant content scrolling
 * underneath disappears behind it. The soft edge lives in the header's own background
 * instead of an overlay below it: the bottom 0.75rem of the header box fades the
 * background out, and that strip sits over the empty space the user bubble already
 * reserves below itself. At rest the strip reveals the identical page background
 * (`--background` is generated from the same `surface.background` token), so it is
 * invisible and can never wash over the assistant content that follows.
 */
const STICKY_HEADER_BACKGROUND: React.CSSProperties = {
    backgroundImage:
        'linear-gradient(to bottom, var(--surface-background) calc(100% - 0.75rem), transparent)',
};

const TurnItem: React.FC<TurnItemProps> = ({ turn, stickyUserHeader = true, renderMessage }) => {
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
                    style={STICKY_HEADER_BACKGROUND}
                >
                    <div className="relative z-10">
                        {renderMessage(turn.userMessage)}
                    </div>
                </div>
            ) : (
                renderMessage(turn.userMessage)
            )}

            <TurnAssistantBlock assistantMessages={turn.assistantMessages} renderMessage={renderMessage} />
        </section>
    );
};

export default React.memo(TurnItem);
