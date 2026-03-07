import React from 'react';

import type { ChatMessageEntry, Turn } from '../lib/turns/types';
import TurnAssistantBlock from './TurnAssistantBlock';

interface TurnItemProps {
    turn: Turn;
    stickyUserHeader?: boolean;
    renderMessage: (message: ChatMessageEntry) => React.ReactNode;
}

const TurnItem: React.FC<TurnItemProps> = ({ turn, stickyUserHeader = true, renderMessage }) => {
    return (
        <section className="relative w-full" data-turn-id={turn.turnId}>
            {stickyUserHeader ? (
                <div className="sticky top-0 z-20 relative bg-[var(--surface-background)] [overflow-anchor:none]">
                    <div className="relative z-10">
                        {renderMessage(turn.userMessage)}
                    </div>
                    <div
                        aria-hidden="true"
                        className="pointer-events-none absolute inset-x-0 top-full z-0 h-4 bg-gradient-to-b from-[var(--surface-background)] to-transparent sm:h-8"
                    />
                </div>
            ) : (
                renderMessage(turn.userMessage)
            )}

            <TurnAssistantBlock assistantMessages={turn.assistantMessages} renderMessage={renderMessage} />
        </section>
    );
};

export default React.memo(TurnItem);
