import { z } from 'zod';
import type { AttachedFile } from './types/sessionTypes';
import { PATH_NOTE_MEDIA_TYPE } from '@/sync/attachment-files';

export const serverAttachmentSchema = z.object({
    id: z.string(),
    filename: z.string(),
    mimeType: z.string(),
    size: z.number(),
    source: z.enum(['local', 'server', 'vscode']),
    serverPath: z.string().optional(),
    agentPath: z.string().optional(),
    dataUrl: z.string().optional(),
    original: z.object({ mimeType: z.string(), dataUrl: z.string(), saveOnSend: z.boolean().optional() }).optional(),
});

type ServerQueueAttachment = z.infer<typeof serverAttachmentSchema>;

export type ServerQueueAttachmentInput = Omit<ServerQueueAttachment, 'dataUrl'> & { dataUrl: string };

const decodeDataUrl = (dataUrl: string): ArrayBuffer | null => {
    const commaIndex = dataUrl.indexOf(',');
    if (!dataUrl.startsWith('data:') || commaIndex === -1) return null;
    const meta = dataUrl.slice(5, commaIndex);
    const payload = dataUrl.slice(commaIndex + 1);
    try {
        if (meta.endsWith(';base64')) {
            const binary = atob(payload);
            const buffer = new ArrayBuffer(binary.length);
            const bytes = new Uint8Array(buffer);
            for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
            return buffer;
        }
        const encoded = new TextEncoder().encode(decodeURIComponent(payload));
        const buffer = new ArrayBuffer(encoded.byteLength);
        new Uint8Array(buffer).set(encoded);
        return buffer;
    } catch {
        return null;
    }
};

const LEGACY_PATH_NOTE_PREFIX = 'data:text/plain;base64,';

const isStoredPathReference = (attachment: ServerQueueAttachment): boolean => (
    attachment.source === 'local'
    && attachment.mimeType === 'text/plain'
    && Boolean(attachment.agentPath)
    && attachment.serverPath === attachment.agentPath
);

const storedDataUrl = (attachment: ServerQueueAttachment): string => {
    const dataUrl = attachment.dataUrl ?? '';
    if (!dataUrl.startsWith(LEGACY_PATH_NOTE_PREFIX) || !isStoredPathReference(attachment)) return dataUrl;
    return `data:${PATH_NOTE_MEDIA_TYPE};base64,${dataUrl.slice(LEGACY_PATH_NOTE_PREFIX.length)}`;
};

export const toAttachedFile = (attachment: ServerQueueAttachment): AttachedFile => {
    const dataUrl = storedDataUrl(attachment);
    const bytes = dataUrl ? decodeDataUrl(dataUrl) : null;
    const file: AttachedFile = {
        id: attachment.id,
        file: new File(bytes ? [bytes] : [], attachment.filename, { type: attachment.mimeType }),
        dataUrl,
        mimeType: attachment.mimeType,
        filename: attachment.filename,
        size: attachment.size,
        source: attachment.source,
    };
    if (attachment.serverPath) file.serverPath = attachment.serverPath;
    if (attachment.agentPath) file.agentPath = attachment.agentPath;
    if (attachment.original) file.original = attachment.original;
    return file;
};

export const withOriginalAttachment = (attachment: AttachedFile): AttachedFile => {
    const { original, ...rest } = attachment;
    if (!original) return attachment;
    const bytes = decodeDataUrl(original.dataUrl);
    const restored: AttachedFile = {
        ...rest,
        file: new File(bytes ? [bytes] : [], attachment.filename, { type: original.mimeType }),
        mimeType: original.mimeType,
        dataUrl: original.dataUrl,
    };
    if (!original.saveOnSend) return restored;
    const { agentPath: _agentPath, serverPath: _serverPath, ...held } = restored;
    return { ...held, saveOnSend: true };
};

export const toServerAttachment = (attachment: AttachedFile): ServerQueueAttachmentInput => {
    const input: ServerQueueAttachmentInput = {
        id: attachment.id,
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        size: attachment.size,
        source: attachment.source,
        dataUrl: attachment.dataUrl,
    };
    if (attachment.serverPath) input.serverPath = attachment.serverPath;
    if (attachment.agentPath) input.agentPath = attachment.agentPath;
    if (attachment.original) input.original = attachment.original;
    return input;
};
