import type { AttachedFile } from '@/stores/types/sessionTypes';

/** Select consumed original inputs; restored text rebuilds its derived files on retry. */
export function getAttachmentsToRestore(
    originalAttachments: readonly AttachedFile[],
    sendableAttachments: readonly AttachedFile[],
    additionalAttachments: readonly AttachedFile[],
    sanitizeAttachments: (files: readonly AttachedFile[]) => AttachedFile[],
): AttachedFile[] {
    const sendableIds = new Set(sendableAttachments.map((attachment) => attachment.id));
    return [
        ...sanitizeAttachments(originalAttachments.filter((attachment) => sendableIds.has(attachment.id))),
        ...additionalAttachments,
    ];
}
