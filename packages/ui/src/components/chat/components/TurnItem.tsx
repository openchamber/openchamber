import React from 'react';

import type { ChatMessageEntry, Turn } from '../lib/turns/types';
import TurnAssistantBlock from './TurnAssistantBlock';
import type { PermissionAuditEntry } from '@/types/permissionAudit';

interface TurnItemProps {
    turn: Turn;
    stickyUserHeader?: boolean;
    renderMessage: (message: ChatMessageEntry, permissionAudits?: PermissionAuditEntry[]) => React.ReactNode;
    permissionAudits?: PermissionAuditEntry[];
}

const TurnItem: React.FC<TurnItemProps> = ({ turn, stickyUserHeader = true, renderMessage, permissionAudits = [] }) => {
    return (
        <section
            className="relative w-full"
            id={`turn-${turn.turnId}`}
            data-turn-id={turn.turnId}
            data-scroll-spy-id={turn.turnId}
        >
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
            <TurnAssistantBlock assistantMessages={turn.assistantMessages} renderMessage={renderMessage} permissionAudits={permissionAudits} />
        </section>
    );
};

export default React.memo(TurnItem);
