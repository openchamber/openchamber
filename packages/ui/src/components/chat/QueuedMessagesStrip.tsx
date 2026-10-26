import React, { memo } from 'react';
import {
    DndContext,
    MouseSensor,
    TouchSensor,
    useSensor,
    useSensors,
    closestCenter,
    type DragEndEvent,
} from '@dnd-kit/core';
import {
    SortableContext,
    useSortable,
    verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { getMessageQueueKey, useMessageQueueStore, type MessageQueueTarget, type QueuedMessage } from '@/stores/messageQueueStore';
import { useUIStore } from '@/stores/useUIStore';
import { useConfigStore } from '@/stores/useConfigStore';
import { useAgentColors } from '@/hooks/useAgentColors';
import { agentLabel } from '@/lib/agentLabel';
import { useI18n } from '@/lib/i18n';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { getQueuedMessagePreview } from '@/lib/messages/queuedMessagePreview';
import { withAttachmentChips } from './message/parts/attachmentCitationChips';

const ROW_ACTION_CLASS = 'shrink-0 text-muted-foreground hover:bg-transparent hover:text-foreground';

/** The agent a queued message was captured with, in the composer agent control's colors. */
const QueuedMessageAgentBadge: React.FC<{ agentName: string }> = ({ agentName }) => {
    const { t } = useI18n();
    const getAgentColor = useAgentColors();
    const knownAgent = useConfigStore((state) => state.agents.find((agent) => agent.name === agentName));
    const label = agentLabel(knownAgent ?? { name: agentName, displayName: '' });
    const { color } = getAgentColor(agentName);

    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <span className="flex min-w-0 max-w-[40%] shrink items-center gap-1.5 typography-ui-label font-medium" style={{ color }}>
                    <Icon name="ai-agent" className="size-3.5 shrink-0" aria-hidden="true" />
                    <span className="truncate">{label}</span>
                </span>
            </TooltipTrigger>
            <TooltipContent side="top" sideOffset={6}>
                {t('chat.queuedMessage.sendsAsAgent', { agent: label })}
            </TooltipContent>
        </Tooltip>
    );
};

interface QueuedMessageRowProps {
    message: QueuedMessage;
    target: MessageQueueTarget;
    /** The agent the composer would send as now; a message captured with another one says so. */
    composerAgentName: string | null | undefined;
    onEdit: (message: QueuedMessage) => void;
    onSend: (message: QueuedMessage) => void;
    /** The leading slot: the queue icon for a lone message, a drag handle in the list. */
    lead: React.ReactNode;
}

const QueuedMessageRow: React.FC<QueuedMessageRowProps> = ({ message, target, composerAgentName, onEdit, onSend, lead }) => {
    const { t } = useI18n();
    const removeFromQueue = useMessageQueueStore((state) => state.removeFromQueue);
    const firstLine = getQueuedMessagePreview(message);
    const capturedAgentName = message.sendConfig?.agent;
    const attachmentCount = message.attachments?.length ?? 0;
    // `[image-1.png]` citations of the message's own files read as file chips.
    const attachmentFilenames = React.useMemo(
        () => (message.attachments ?? []).map((file) => file.filename),
        [message.attachments],
    );

    return (
        <>
            {lead}
            {message.goal ? (
                // Same lit target as the composer's armed goal button.
                <span
                    role="img"
                    className="flex shrink-0 text-[var(--status-info)]"
                    title={t('chat.queuedMessage.goal')}
                    aria-label={t('chat.queuedMessage.goal')}
                >
                    <Icon name="target-fill" className="size-3.5" aria-hidden="true" />
                </span>
            ) : null}
            <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                {firstLine ? withAttachmentChips(firstLine, attachmentFilenames, `queued-${message.id}`) : t('chat.queuedMessage.empty')}
                {attachmentCount > 0 && (
                    <span className="ms-1 text-muted-foreground">{t('chat.queuedMessage.attachments', { count: attachmentCount })}</span>
                )}
            </span>
            {capturedAgentName && capturedAgentName !== composerAgentName ? (
                <QueuedMessageAgentBadge agentName={capturedAgentName} />
            ) : null}
            {!message.scheduledTask ? (
                <>
                    <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => onEdit(message)}
                        onMouseDown={(event) => event.preventDefault()}
                        className={ROW_ACTION_CLASS}
                    >
                        <Icon name="edit" className="size-3.5" aria-hidden="true" />
                        {t('chat.queuedMessage.edit')}
                    </Button>
                    <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => onSend(message)}
                        onMouseDown={(event) => event.preventDefault()}
                        className={ROW_ACTION_CLASS}
                    >
                        <Icon name="send-plane" className="size-3.5" aria-hidden="true" />
                        {t('chat.queuedMessage.send')}
                    </Button>
                </>
            ) : null}
            <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => removeFromQueue(target, message.id)}
                onMouseDown={(event) => event.preventDefault()}
                title={t('chat.queuedMessage.removeAria')}
                aria-label={t('chat.queuedMessage.removeAria')}
                className={ROW_ACTION_CLASS}
            >
                <Icon name="close" className="size-4" aria-hidden="true" />
            </Button>
        </>
    );
};

const ROW_CLASS = 'flex oc-composer-row min-w-0 items-center gap-2 ps-3 pe-1.5';

const SortableQueuedMessageRow = memo((props: Omit<QueuedMessageRowProps, 'lead'>) => {
    const { t } = useI18n();
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: props.message.id });

    return (
        <div
            ref={setNodeRef}
            // Translate only (no scaleX/scaleY) so the lifted row keeps its size.
            style={{ transform: CSS.Translate.toString(transform), transition }}
            className={cn(ROW_CLASS, isDragging && 'relative z-10 opacity-60')}
        >
            <QueuedMessageRow
                {...props}
                lead={(
                    <button
                        type="button"
                        {...attributes}
                        {...listeners}
                        className="flex size-3.5 flex-shrink-0 cursor-grab touch-none select-none items-center justify-center text-muted-foreground hover:text-foreground active:cursor-grabbing"
                        aria-label={t('chat.queuedMessage.reorderAria')}
                    >
                        <Icon name="draggable" className="size-3.5" aria-hidden="true" />
                    </button>
                )}
            />
        </div>
    );
});

SortableQueuedMessageRow.displayName = 'SortableQueuedMessageRow';

interface QueuedMessagesStripProps {
    target: MessageQueueTarget | null;
    composerAgentName: string | null | undefined;
    /** The composer takes the message out of the queue and restores it. */
    onEditMessage: (messageId: string) => void;
    onSendMessage: (messageId: string) => void;
}

const EMPTY_QUEUE: QueuedMessage[] = [];

/**
 * Messages waiting for the running turn, as a top row of the composer next to
 * the background commands. One message is its own row; several collapse into
 * a count that expands in place into a reorderable list.
 */
export const QueuedMessagesStrip = memo(({ target, composerAgentName, onEditMessage, onSendMessage }: QueuedMessagesStripProps) => {
    const { t } = useI18n();
    // One shared preference, so the list stays open (or closed) across
    // session switches instead of resetting with the queue key.
    const expanded = useUIStore((state) => state.messageQueueExpanded);
    const setMessageQueueExpanded = useUIStore((state) => state.setMessageQueueExpanded);
    const listId = React.useId();
    const queueKey = target ? getMessageQueueKey(target) : null;
    const queuedMessages = useMessageQueueStore(
        React.useCallback(
            (state) => {
                if (!queueKey) return EMPTY_QUEUE;
                return state.queuedMessages[queueKey] ?? EMPTY_QUEUE;
            },
            [queueKey]
        )
    );
    const reorderQueue = useMessageQueueStore((state) => state.reorderQueue);

    const sensors = useSensors(
        // Desktop: drag after a small move so other clicks still register.
        useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
        // Touch: long-press to drag (tap still hits buttons, swipe scrolls).
        useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 6 } }),
    );

    const handleDragEnd = React.useCallback((event: DragEndEvent) => {
        const { active, over } = event;
        if (!over || active.id === over.id || !target) return;
        reorderQueue(target, String(active.id), String(over.id));
    }, [target, reorderQueue]);

    const handleEdit = React.useCallback((message: QueuedMessage) => {
        onEditMessage(message.id);
    }, [onEditMessage]);

    const handleSend = React.useCallback((message: QueuedMessage) => {
        onSendMessage(message.id);
    }, [onSendMessage]);

    if (!target || queuedMessages.length === 0) return null;

    if (queuedMessages.length === 1) {
        return (
            <div role="group" className={cn(ROW_CLASS, 'border-b border-border/60')} aria-label={t('chat.queuedMessage.title')}>
                <QueuedMessageRow
                    message={queuedMessages[0]}
                    target={target}
                    composerAgentName={composerAgentName}
                    onEdit={handleEdit}
                    onSend={handleSend}
                    lead={<Icon name="time" className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />}
                />
            </div>
        );
    }

    // The whole header toggles the list, as the background commands header does.
    return (
        <div role="group" className="border-b border-border/60" aria-label={t('chat.queuedMessage.title')}>
            <div className="flex oc-composer-row items-center ps-3 pe-3">
                <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setMessageQueueExpanded(!expanded)}
                    onMouseDown={(event) => event.preventDefault()}
                    aria-expanded={expanded}
                    aria-controls={expanded ? listId : undefined}
                    className="min-w-0 flex-1 shrink justify-start gap-2 px-0 text-sm font-normal normal-case text-muted-foreground hover:!bg-transparent hover:text-foreground has-[>svg]:px-0"
                >
                    <Icon name="time" className="size-3.5 shrink-0" aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate text-start">
                        {t('chat.queuedMessage.title')} {queuedMessages.length}
                    </span>
                    <Icon name={expanded ? 'arrow-up-s' : 'arrow-down-s'} className="size-4 shrink-0" aria-hidden="true" />
                </Button>
            </div>
            {expanded ? (
                <DndContext
                    sensors={sensors}
                    collisionDetection={closestCenter}
                    onDragEnd={handleDragEnd}
                >
                    <SortableContext
                        items={queuedMessages.map((m) => m.id)}
                        strategy={verticalListSortingStrategy}
                    >
                        {/* Four rows, then the list scrolls, so a long queue
                            cannot push the editor off a short screen. */}
                        <div id={listId} className="max-h-40 overflow-y-auto overscroll-contain">
                            {queuedMessages.map((message) => (
                                <SortableQueuedMessageRow
                                    key={message.id}
                                    message={message}
                                    target={target}
                                    composerAgentName={composerAgentName}
                                    onEdit={handleEdit}
                                    onSend={handleSend}
                                />
                            ))}
                        </div>
                    </SortableContext>
                </DndContext>
            ) : null}
        </div>
    );
});

QueuedMessagesStrip.displayName = 'QueuedMessagesStrip';
