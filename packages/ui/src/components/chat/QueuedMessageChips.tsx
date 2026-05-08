import React, { memo } from 'react';
import { RiCloseLine, RiMessage2Line } from '@remixicon/react';
import { useMessageQueueStore, type QueuedMessage } from '@/stores/messageQueueStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useInputStore } from '@/sync/input-store';
import { useI18n } from '@/lib/i18n';

interface QueuedMessageChipProps {
    message: QueuedMessage;
    sessionId: string;
    onEdit: (message: QueuedMessage) => void;
}

const QueuedMessageChip = memo(({ message, sessionId, onEdit }: QueuedMessageChipProps) => {
    const { t } = useI18n();
    const removeFromQueue = useMessageQueueStore((state) => state.removeFromQueue);

    // Get first line of message, truncated
    const firstLine = React.useMemo(() => {
        const lines = message.content.split('\n');
        const first = lines[0] || '';
        const maxLength = 100;
        if (first.length > maxLength) {
            return first.substring(0, maxLength) + '...';
        }
        return first + (lines.length > 1 ? '...' : '');
    }, [message.content]);

    const attachmentCount = message.attachments?.length ?? 0;

    return (
        <div className="flex w-full items-center gap-1.5 text-sm h-5 px-1">
            <button
                type="button"
                onClick={() => onEdit(message)}
                className="flex min-w-0 flex-1 items-center gap-1.5 text-left hover:opacity-80 transition-opacity"
            >
                <RiMessage2Line
                    className="h-4 w-4 flex-shrink-0 text-muted-foreground"
                />
                <span className="text-muted-foreground flex-shrink-0">
                    Queued
                    {attachmentCount > 0 && (
                        <span className="ml-1">{t('chat.queuedMessage.attachments', { count: attachmentCount })}</span>
                    )}
                </span>
                <span className="text-foreground truncate">
                    {firstLine || t('chat.queuedMessage.empty')}
                </span>
            </button>
            <button
                type="button"
                onClick={() => removeFromQueue(sessionId, message.id)}
                className="flex items-center justify-center h-6 w-6 flex-shrink-0 hover:bg-[var(--interactive-hover)] rounded-full transition-colors"
                aria-label={t('chat.queuedMessage.removeAria')}
            >
                <RiCloseLine className="h-4 w-4 text-muted-foreground" />
            </button>
        </div>
    );
});

QueuedMessageChip.displayName = 'QueuedMessageChip';

interface QueuedMessageChipsProps {
    onEditMessage: (content: string, attachments?: QueuedMessage['attachments']) => void;
}

const EMPTY_QUEUE: QueuedMessage[] = [];

export const QueuedMessageChips = memo(({ onEditMessage }: QueuedMessageChipsProps) => {
    const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
    const queuedMessages = useMessageQueueStore(
        React.useCallback(
            (state) => {
                if (!currentSessionId) return EMPTY_QUEUE;
                return state.queuedMessages[currentSessionId] ?? EMPTY_QUEUE;
            },
            [currentSessionId]
        )
    );
    const popToInput = useMessageQueueStore((state) => state.popToInput);

    const handleEdit = React.useCallback((message: QueuedMessage) => {
        if (!currentSessionId) return;
        
        const popped = popToInput(currentSessionId, message.id);
        if (popped) {
            if (popped.attachments && popped.attachments.length > 0) {
                const currentAttachments = useInputStore.getState().attachedFiles;
                useInputStore.setState({ 
                    attachedFiles: [...currentAttachments, ...popped.attachments] 
                });
            }
            onEditMessage(popped.content, popped.attachments);
        }
    }, [currentSessionId, popToInput, onEditMessage]);

    if (queuedMessages.length === 0 || !currentSessionId) {
        return null;
    }

    return (
        <div className="pb-2 w-full px-1 space-y-1">
            {queuedMessages.map((message) => (
                <QueuedMessageChip
                    key={message.id}
                    message={message}
                    sessionId={currentSessionId}
                    onEdit={handleEdit}
                />
            ))}
        </div>
    );
});

QueuedMessageChips.displayName = 'QueuedMessageChips';
