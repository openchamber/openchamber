import React from 'react';

/**
 * The session the chat column is showing — the deferred selection the
 * timeline renders, not the live store value. The composer and everything
 * stacked with the timeline read it so the column changes as one: a session
 * click publishes the live selection first, and a composer that followed it
 * would change height (changed-files row, todos, queued chips) while the
 * outgoing timeline is still on screen, shoving that timeline before the swap.
 */
export type ChatColumnSession = {
  sessionId: string | null;
  directory: string | null;
};

export const ChatColumnSessionContext = React.createContext<ChatColumnSession | null>(null);

export const useChatColumnSession = (): ChatColumnSession | null => React.useContext(ChatColumnSessionContext);
