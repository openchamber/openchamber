import React from 'react';
import { Checkbox } from '@/components/ui/checkbox';
import { useI18n } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { useConversationItemSelected, useConversationSelectionActive, useConversationSelectionStore } from './selectionContext';

export const ConversationSelectionItem: React.FC<{
    selectionKey: string;
    role: 'user' | 'assistant';
    eligible: boolean;
    children: React.ReactNode;
}> = ({ selectionKey, role, eligible, children }) => {
    const { t } = useI18n();
    const store = useConversationSelectionStore();
    const active = useConversationSelectionActive();
    const selected = useConversationItemSelected(selectionKey);
    const descriptionId = React.useId();
    const selecting = active && eligible;
    return (
        <div
            data-conversation-selection-item={selecting ? selectionKey : undefined}
            data-selected={selecting ? selected : undefined}
            className={cn('relative min-w-0', selecting && 'cursor-pointer select-none', selecting && selected && 'bg-interactive-selection')}
            onClick={selecting ? (event) => {
                // Portaled action menus can enter selection during this very click.
                if (event.nativeEvent.composedPath().includes(event.currentTarget)) store?.getState().toggle(selectionKey);
            } : undefined}
        >
            {selecting ? (
                <div className="chat-message-column pointer-events-none absolute inset-x-0 top-2 z-30">
                    <div className="pointer-events-auto absolute inset-s-0 top-0 flex size-11 items-center justify-center" aria-describedby={descriptionId}>
                        <Checkbox
                            className="h-6 w-6 min-h-6 min-w-6"
                            iconClassName="[&_svg]:h-4 [&_svg]:w-4 [&_svg]:min-h-4 [&_svg]:min-w-4"
                            checked={selected}
                            onChange={() => store?.getState().toggle(selectionKey)}
                            ariaLabel={t(role === 'user' ? 'chat.export.selectUser' : 'chat.export.selectAssistant')}
                        />
                    </div>
                </div>
            ) : null}
            <div
                id={descriptionId}
                inert={active || undefined}
                className={cn('relative', active && 'pointer-events-none select-none [&_[data-message-actions=true]]:invisible [&_[data-message-action-group=true]]:invisible', selecting && '[&_.chat-message-column]:ps-12')}
            >
                {children}
            </div>
        </div>
    );
};
