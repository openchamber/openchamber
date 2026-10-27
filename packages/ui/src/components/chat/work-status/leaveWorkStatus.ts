import React from 'react';

/**
 * Provided by the phone's Status tab, which covers the chat: closes it once a
 * row has opened something that shows elsewhere (a subagent's session, a
 * pinned message in the transcript, the issues and PRs board). The desktop
 * card sits beside the chat and provides nothing.
 */
export const LeaveWorkStatusContext = React.createContext<(() => void) | null>(null);

export const useLeaveWorkStatus = (): (() => void) | null => React.useContext(LeaveWorkStatusContext);
