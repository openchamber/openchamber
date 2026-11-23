import type { QueuedMessage, QueuedMessageInput } from '@/stores/messageQueueStore';
import type { useComposerQueueActions } from './useComposerQueueActions';

type CapturedComposerMessage = NonNullable<Awaited<ReturnType<ReturnType<typeof useComposerQueueActions>['captureComposerMessage']>>>;

export const goalWriterHeldMessage = (
    captured: Pick<CapturedComposerMessage, 'messageToQueue' | 'textToQueue' | 'agentMention' | 'skillNames' | 'attachmentsToQueue' | 'context'>,
): QueuedMessageInput & Pick<QueuedMessage, 'content'> => ({
    content: captured.messageToQueue,
    text: captured.textToQueue,
    agentMention: captured.agentMention,
    skills: captured.skillNames.length > 0 ? captured.skillNames : undefined,
    attachments: captured.attachmentsToQueue,
    context: [...captured.context],
});
