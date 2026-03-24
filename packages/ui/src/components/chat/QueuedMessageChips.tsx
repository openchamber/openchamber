import React, { memo } from 'react';
import { RiCloseLine, RiMessage2Line } from '@remixicon/react';
import { useMessageQueueStore, type QueuedMessage } from '@/stores/messageQueueStore';
import { useSessionStore } from '@/stores/useSessionStore';
import { useFileStore } from '@/stores/fileStore';
import { useLanguage } from '@/hooks/useLanguage';

interface QueuedMessageChipProps {
    message: QueuedMessage;
    sessionId: string;
    onEdit: (message: QueuedMessage) => void;
}

const QueuedMessageChip = memo(({ message, sessionId, onEdit }: QueuedMessageChipProps) => {
    const { t } = useLanguage();
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
        <button
            type="button"
            onClick={() => onEdit(message)}
            className="flex w-full items-center gap-1.5 text-sm hover:opacity-80 transition-opacity text-left h-5 px-1"
        >
            <RiMessage2Line 
                className="h-4 w-4 flex-shrink-0 text-muted-foreground" 
            />
            <span className="text-muted-foreground flex-shrink-0">
                {t('queuedMessageChips.queued')}
                {attachmentCount > 0 && (
                    <span className="ml-1">{t('queuedMessageChips.attachmentsCount', { count: attachmentCount })}</span>
                )}
            </span>
            <span className="text-foreground truncate">
                {firstLine || '(empty)'}
            </span>
            <span
                onClick={(e) => {
                    e.stopPropagation();
                    removeFromQueue(sessionId, message.id);
                }}
                className="flex items-center justify-center h-6 w-6 flex-shrink-0 hover:bg-[var(--interactive-hover)] rounded-full transition-colors cursor-pointer"
                aria-label={t('queuedMessageChips.removeFromQueue')}
            >
                <RiCloseLine className="h-4 w-4 text-muted-foreground" />
            </span>
        </button>
    );
});

QueuedMessageChip.displayName = 'QueuedMessageChip';

interface QueuedMessageChipsProps {
    onEditMessage: (content: string, attachments?: QueuedMessage['attachments']) => void;
}

const EMPTY_QUEUE: QueuedMessage[] = [];

export const QueuedMessageChips = memo(({ onEditMessage }: QueuedMessageChipsProps) => {
    const currentSessionId = useSessionStore((state) => state.currentSessionId);
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
            // Restore attachments to file store if any
            if (popped.attachments && popped.attachments.length > 0) {
                const currentAttachments = useFileStore.getState().attachedFiles;
                useFileStore.setState({ 
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
