import React from 'react';

import type { ChatMessageEntry } from '../lib/turns/types';
import { TurnMessageWindow } from './TurnMessageWindow';

interface TurnAssistantBlockProps {
    turnId: string;
    assistantMessages: ChatMessageEntry[];
    renderMessage: (message: ChatMessageEntry) => React.ReactNode;
}

const TurnAssistantBlock: React.FC<TurnAssistantBlockProps> = ({ turnId, assistantMessages, renderMessage }) => {
    return (
        <div className="relative z-0">
            <TurnMessageWindow turnId={turnId} messages={assistantMessages} renderMessage={renderMessage} />
        </div>
    );
};

export default React.memo(TurnAssistantBlock);
