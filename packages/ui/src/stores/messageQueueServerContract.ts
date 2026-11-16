import { z } from 'zod';
import { contextPartMetadataSchema } from '@/lib/messages/contextParts';
import { getQueuedMessagePreview } from '@/lib/messages/queuedMessagePreview';
import { runtimeFetch, type RuntimeFetchOptions } from '@/lib/runtime-fetch';
import type { AttachedFile } from './types/sessionTypes';
import type { QueuedContextPart, QueuedMessage, QueuedMessageGoal, QueuedMessageInput, QueuedMessageSendConfig } from './messageQueueStore';

const serverSendConfigSchema = z.object({
    providerID: z.string().min(1), modelID: z.string().min(1),
    agent: z.string().optional(), variant: z.string().optional(),
});
const serverGoalSchema = z.object({ objective: z.string().min(1).optional(), tokenBudget: z.number().int().positive().nullable() });
const serverAttachmentSchema = z.object({
    id: z.string(), filename: z.string(), mimeType: z.string(), size: z.number(),
    source: z.enum(['local', 'server', 'vscode']), serverPath: z.string().optional(),
    agentPath: z.string().optional(), dataUrl: z.string().optional(),
});
const serverContextPartSchema = z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('context'), text: z.string(), metadata: contextPartMetadataSchema, instructions: z.string().optional() }),
    z.object({ kind: z.literal('instruction'), text: z.string() }),
    z.object({ kind: z.literal('synthetic'), text: z.string() }),
]);
const serverItemBaseSchema = z.object({
    id: z.string().min(1), clientRequestId: z.string().optional(), createdAt: z.number(),
    content: z.string(), text: z.string(), agentMention: z.string().optional(),
    attachments: z.array(serverAttachmentSchema), context: z.array(serverContextPartSchema).optional(),
    contextPreview: z.string().optional(), sendConfig: serverSendConfigSchema, goal: serverGoalSchema.optional(),
});
export const scheduledTaskSchema = z.object({ projectId: z.string().min(1), taskId: z.string().min(1) });
const serverItemSchema = z.union([
    serverItemBaseSchema.extend({ scheduledTask: scheduledTaskSchema, sendConfig: serverSendConfigSchema.partial() }),
    serverItemBaseSchema,
]);
export const serverSessionSchema = z.object({
    sessionId: z.string().min(1), directory: z.string(), items: z.array(serverItemSchema), sendingId: z.string().nullable(),
});
export const serverSnapshotSchema = z.object({ revision: z.number(), sessions: z.array(serverSessionSchema) });
export const serverSessionResponseSchema = z.object({ revision: z.number(), session: serverSessionSchema });
export const serverEnqueueResponseSchema = serverSessionResponseSchema.extend({ itemId: z.string().min(1) });
export const serverTakeResponseSchema = serverSessionResponseSchema.extend({ item: serverItemSchema });
export const serverTakeAllResponseSchema = serverSessionResponseSchema.extend({ items: z.array(serverItemSchema) });
export type ServerQueueSession = z.infer<typeof serverSessionSchema>;
type ServerQueueItem = z.infer<typeof serverItemSchema>;
type ServerQueueAttachment = z.infer<typeof serverAttachmentSchema>;

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

const toAttachedFile = (attachment: ServerQueueAttachment): AttachedFile => {
    const dataUrl = attachment.dataUrl ?? '';
    const bytes = dataUrl ? decodeDataUrl(dataUrl) : null;
    const file: AttachedFile = {
        id: attachment.id, file: new File(bytes ? [bytes] : [], attachment.filename, { type: attachment.mimeType }),
        dataUrl, mimeType: attachment.mimeType, filename: attachment.filename, size: attachment.size, source: attachment.source,
    };
    if (attachment.serverPath) file.serverPath = attachment.serverPath;
    if (attachment.agentPath) file.agentPath = attachment.agentPath;
    return file;
};

export const toQueuedMessage = (item: ServerQueueItem): QueuedMessage => {
    const message: QueuedMessage = { id: item.id, content: item.content, text: item.text, createdAt: item.createdAt };
    const selection = serverSendConfigSchema.safeParse(item.sendConfig);
    if (selection.success) message.sendConfig = selection.data;
    if (item.goal) message.goal = item.goal;
    if ('scheduledTask' in item) message.scheduledTask = item.scheduledTask;
    if (item.agentMention) message.agentMention = item.agentMention;
    if (item.attachments.length > 0) message.attachments = item.attachments.map(toAttachedFile);
    if (item.context) message.context = item.context;
    if (item.contextPreview) message.contextPreview = item.contextPreview;
    return message;
};

type ServerQueueAttachmentInput = Omit<ServerQueueAttachment, 'dataUrl'> & { dataUrl: string };
type ServerQueueItemInput = {
    clientRequestId?: string; content: string; text: string; agentMention?: string;
    attachments: ServerQueueAttachmentInput[]; context: QueuedContextPart[]; contextPreview?: string;
    sendConfig: QueuedMessageSendConfig; goal?: QueuedMessageGoal;
};
type ServerQueueRequestBody = { directory: string; item: ServerQueueItemInput } | { itemIds: string[] };
const toServerAttachment = (attachment: AttachedFile): ServerQueueAttachmentInput => {
    const input: ServerQueueAttachmentInput = {
        id: attachment.id, filename: attachment.filename, mimeType: attachment.mimeType,
        size: attachment.size, source: attachment.source, dataUrl: attachment.dataUrl,
    };
    if (attachment.serverPath) input.serverPath = attachment.serverPath;
    if (attachment.agentPath) input.agentPath = attachment.agentPath;
    return input;
};
export const toServerItemInput = (message: QueuedMessageInput, sendConfig: QueuedMessageSendConfig): ServerQueueItemInput => {
    const item: ServerQueueItemInput = {
        content: message.content, text: message.text ?? message.content,
        attachments: (message.attachments ?? []).filter((file) => Boolean(file.dataUrl)).map(toServerAttachment),
        context: message.context ?? [], sendConfig,
    };
    if (message.agentMention) item.agentMention = message.agentMention;
    if (message.goal) item.goal = message.goal;
    const contextPreview = getQueuedMessagePreview({ content: '', context: message.context });
    if (contextPreview) item.contextPreview = contextPreview;
    return item;
};
export const requestJson = async <T,>(schema: z.ZodType<T>, path: string, init?: RuntimeFetchOptions): Promise<T> => {
    const response = await runtimeFetch(path, init);
    if (!response.ok) {
        const body = await response.json().catch(() => null);
        const reason = z.object({ error: z.string() }).safeParse(body);
        const error: Error & { status?: number; reason?: string } = new Error(`Message queue request failed (${response.status})`);
        error.status = response.status;
        if (reason.success) error.reason = reason.data.error;
        throw error;
    }
    const parsed = schema.safeParse(await response.json());
    if (!parsed.success) throw new Error('Invalid message queue response');
    return parsed.data;
};
export const jsonInit = (method: string, body?: ServerQueueRequestBody): RequestInit => {
    if (body === undefined) return { method };
    return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
};
export const sessionPath = (sessionId: string) => `/api/message-queue/sessions/${encodeURIComponent(sessionId)}`;
