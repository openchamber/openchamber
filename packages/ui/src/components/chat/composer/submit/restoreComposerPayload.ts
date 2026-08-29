import type { AttachedFile } from '@/stores/types/sessionTypes';
import type { InlineCommentDraftTarget } from '@/stores/useInlineCommentDraftStore';
import type { ContextPart } from '@/lib/messages/contextParts';

export type RestoredComposerPayload = {
    content: string;
    attachments?: AttachedFile[];
    contextParts?: ContextPart[];
};

type RestoreComposerPayloadActions = {
    clearInlineDrafts: (target: InlineCommentDraftTarget) => void;
    setMessage: (content: string) => void;
    setAttachedFiles: (attachments: AttachedFile[]) => void;
    setPendingSyntheticParts: (parts: ContextPart[] | null) => void;
};

/** Replace the whole composer payload recovered from an uncertain queue item. */
export const restoreComposerPayload = (
    target: InlineCommentDraftTarget,
    payload: RestoredComposerPayload,
    actions: RestoreComposerPayloadActions,
): void => {
    // The queued context is already serialized in contextParts. Any drafts
    // created after queueing belong to the newer composer payload and must not
    // survive this replacement.
    actions.clearInlineDrafts(target);
    actions.setMessage(payload.content);
    actions.setAttachedFiles(payload.attachments ?? []);
    actions.setPendingSyntheticParts(payload.contextParts ?? null);
};
