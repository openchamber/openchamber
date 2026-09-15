import React from 'react';

import type { ChatMessageEntry } from '../lib/turns/types';

interface TurnAssistantBlockProps {
    assistantMessages: ChatMessageEntry[];
    renderMessage: (message: ChatMessageEntry) => React.ReactNode;
}

const TurnAssistantBlock: React.FC<TurnAssistantBlockProps> = ({ assistantMessages, renderMessage }) => {
    const visibleAssistantMessages = assistantMessages.filter((message) => message.info.summary !== true);

    return (
        <div className="relative z-0">
            {visibleAssistantMessages.map((message) => renderMessage(message))}
        </div>
    );
};

export default React.memo(TurnAssistantBlock);
