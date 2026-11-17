import React from 'react';
import {
    ChatColumnActionsContext,
    ChatColumnSessionContext,
    type ChatColumnActions,
    type ChatColumnSession,
} from '../chatColumnSession';
import { MobileCommentComposerContext, type useMobileCommentComposerOwner } from '../composer/comment/MobileCommentComposerContext';
import { ChatQuoteHighlightContext, type useChatQuoteHighlightStore } from '../hooks/chatQuoteHighlightStore';

export const ChatColumnProviders: React.FC<{
    session: ChatColumnSession;
    actions: ChatColumnActions;
    mobileCommentComposer: ReturnType<typeof useMobileCommentComposerOwner>;
    quoteHighlights: ReturnType<typeof useChatQuoteHighlightStore>;
    children: React.ReactNode;
}> = ({ session, actions, mobileCommentComposer, quoteHighlights, children }) => (
    <ChatColumnSessionContext.Provider value={session}>
        <ChatColumnActionsContext.Provider value={actions}>
            <MobileCommentComposerContext.Provider value={mobileCommentComposer}>
                <ChatQuoteHighlightContext.Provider value={quoteHighlights}>
                    {children}
                </ChatQuoteHighlightContext.Provider>
            </MobileCommentComposerContext.Provider>
        </ChatColumnActionsContext.Provider>
    </ChatColumnSessionContext.Provider>
);
