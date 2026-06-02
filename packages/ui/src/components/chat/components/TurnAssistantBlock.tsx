import React from 'react';

import type { ChatMessageEntry } from '../lib/turns/types';
import { PermissionAuditRow } from '../PermissionAuditRow';
import type { PermissionAuditEntry } from '@/types/permissionAudit';

interface TurnAssistantBlockProps {
    assistantMessages: ChatMessageEntry[];
    renderMessage: (message: ChatMessageEntry, permissionAudits?: PermissionAuditEntry[]) => React.ReactNode;
    permissionAudits?: PermissionAuditEntry[];
}

const TurnAssistantBlock: React.FC<TurnAssistantBlockProps> = ({ assistantMessages, renderMessage, permissionAudits = [] }) => {
    const messageIdByToolCallId = React.useMemo(() => {
        const lookup = new Map<string, string>();
        for (const message of assistantMessages) {
            for (const part of message.parts) {
                if (part.type !== 'tool') {
                    continue;
                }
                const id = (part as { callID?: unknown; id?: unknown }).callID ?? (part as { id?: unknown }).id;
                if (typeof id === 'string' && id.length > 0) {
                    lookup.set(id, message.info.id);
                }
            }
        }
        return lookup;
    }, [assistantMessages]);

    const auditsByMessageId = React.useMemo(() => {
        const grouped = new Map<string, PermissionAuditEntry[]>();
        for (const entry of permissionAudits) {
            const messageID = entry.tool?.messageID ?? (entry.tool?.callID ? messageIdByToolCallId.get(entry.tool.callID) : undefined);
            if (!messageID) {
                continue;
            }
            const existing = grouped.get(messageID);
            if (existing) {
                existing.push(entry);
            } else {
                grouped.set(messageID, [entry]);
            }
        }
        return grouped;
    }, [messageIdByToolCallId, permissionAudits]);

    const trailingAudits = React.useMemo(() => {
        return permissionAudits.filter((entry) => {
            if (entry.tool?.messageID) {
                return false;
            }
            return !entry.tool?.callID || !messageIdByToolCallId.has(entry.tool.callID);
        });
    }, [messageIdByToolCallId, permissionAudits]);

    return (
        <div className="relative z-0">
            {assistantMessages.map((message) => (
                <React.Fragment key={message.info.id}>
                    {renderMessage(message, auditsByMessageId.get(message.info.id))}
                </React.Fragment>
            ))}
            {trailingAudits.map((entry) => (
                <PermissionAuditRow key={entry.requestID} entry={entry} collapsePreviousSpacing={assistantMessages.length > 0} />
            ))}
        </div>
    );
};

export default React.memo(TurnAssistantBlock);
