import React from 'react';

import { PendingWorkflowApprovals } from '../workflows/PendingWorkflowApprovals';
import { EMPTY_ROW_MESSAGE_IDS } from './emptyCollections';
import type { ChatMessageEntry } from '../lib/turns/types';
import type { RenderEntry } from './types';

/** The list footer with the session's pending workflow approvals above the caller's footer. */
export const useApprovalFooter = (
    sessionKey: string,
    directory: string | undefined,
    baseDisplayMessages: ChatMessageEntry[],
    trailingStreamingEntry: RenderEntry | undefined,
    listFooter: React.ReactNode,
) => {
    const approvalLiveMessageIds = React.useMemo(() => {
        if (!trailingStreamingEntry) return EMPTY_ROW_MESSAGE_IDS;
        return trailingStreamingEntry.kind === 'turn'
            ? trailingStreamingEntry.turn.assistantMessageIds
            : [trailingStreamingEntry.message.info.id];
    }, [trailingStreamingEntry]);
    const footerWithApprovals = React.useMemo(() => (
        <>
            <PendingWorkflowApprovals sessionId={sessionKey} messages={baseDisplayMessages}
                liveMessageIds={approvalLiveMessageIds} directory={directory} />
            {listFooter}
        </>
    ), [approvalLiveMessageIds, baseDisplayMessages, directory, listFooter, sessionKey]);

    return footerWithApprovals;
};
