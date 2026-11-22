import React from 'react';
import {
    ChatColumnActionsContext,
    ChatColumnSessionContext,
    ChatColumnTakesPromptsContext,
    type ChatColumnActions,
    type ChatColumnSession,
} from '../chatColumnSession';
import { MobileCommentComposerContext, type useMobileCommentComposerOwner } from '../composer/comment/MobileCommentComposerContext';
import { ChatQuoteHighlightContext, type useChatQuoteHighlightStore } from '../hooks/chatQuoteHighlightStore';
import { ContinueWithModelContext } from '../continueWithModelContext';

export const ChatColumnProviders: React.FC<{
    session: ChatColumnSession;
    actions: ChatColumnActions;
    mobileCommentComposer: ReturnType<typeof useMobileCommentComposerOwner>;
    quoteHighlights: ReturnType<typeof useChatQuoteHighlightStore>;
    takesPrompts: boolean;
    openContinueWithModel: (() => void) | null;
    children: React.ReactNode;
}> = ({ session, actions, mobileCommentComposer, quoteHighlights, takesPrompts, openContinueWithModel, children }) => (
    <ChatColumnSessionContext.Provider value={session}>
        <ChatColumnActionsContext.Provider value={actions}>
            <ChatColumnTakesPromptsContext.Provider value={takesPrompts}>
                <MobileCommentComposerContext.Provider value={mobileCommentComposer}>
                    <ChatQuoteHighlightContext.Provider value={quoteHighlights}>
                        <ContinueWithModelContext.Provider value={openContinueWithModel}>
                            {children}
                        </ContinueWithModelContext.Provider>
                    </ChatQuoteHighlightContext.Provider>
                </MobileCommentComposerContext.Provider>
            </ChatColumnTakesPromptsContext.Provider>
        </ChatColumnActionsContext.Provider>
    </ChatColumnSessionContext.Provider>
);
