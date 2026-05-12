import type { Message, Part } from '@opencode-ai/sdk/v2';
import type { HarnessMessageRecord, HarnessToolActivity } from '@openchamber/harness-contracts';
import { getToolCategory } from '@/lib/toolHelpers';

export type RenderablePart = Part;
export type RenderableToolStatus = 'pending' | 'running' | 'completed' | 'error' | 'aborted' | 'failed' | 'timeout' | 'cancelled' | string;
export interface RenderableToolState {
    status?: RenderableToolStatus;
    title?: string;
    metadata?: Record<string, unknown>;
    input?: Record<string, unknown>;
    output?: string;
    error?: string;
    time?: { start: number; end?: number };
}
export type RenderableToolPart = RenderablePart & {
    type: 'tool';
    id: string;
    tool: string;
    state?: RenderableToolState;
    metadata?: unknown;
};

export type RenderableMessage = Message & {
    sessionId?: string;
    attribution?: {
        providerId?: string;
        modelId?: string;
        modelLabel?: string;
        modeId?: string;
        modeLabel?: string;
        effortId?: string;
        effortLabel?: string;
    };
};

export interface RenderableMessageRecord {
    info: RenderableMessage;
    parts: RenderablePart[];
}

export interface RenderableHeaderAttribution {
    agentName?: string;
    providerId?: string;
    modelId?: string;
    modelName?: string;
    variant?: string;
}

const isObject = (value: unknown): value is Record<string, unknown> => {
    return typeof value === 'object' && value !== null;
};

export const getRenderableMessageProp = (info: unknown, key: string): unknown => {
    if (isObject(info)) {
        return info[key];
    }
    return undefined;
};

export const getRenderableMessageModelProp = (info: unknown, key: 'providerID' | 'modelID'): unknown => {
    const direct = getRenderableMessageProp(info, key);
    if (direct !== undefined && direct !== null) {
        return direct;
    }

    const model = getRenderableMessageProp(info, 'model');
    if (isObject(model)) {
        return model[key];
    }

    const attribution = getRenderableMessageProp(info, 'attribution');
    if (!isObject(attribution)) {
        return undefined;
    }

    return key === 'providerID' ? attribution.providerId : attribution.modelId;
};

export const toRenderableMessageRecord = (record: RenderableMessageRecord | HarnessMessageRecord): RenderableMessageRecord => {
    const info = record.info as RenderableMessage & { sessionId?: string; sessionID?: string };
    if (typeof info.sessionID === 'string') {
        return record as RenderableMessageRecord;
    }

    return {
        info: {
            ...info,
            sessionID: info.sessionId ?? '',
            role: info.role,
            time: info.time,
        } as RenderableMessage,
        parts: record.parts.map((part) => {
            const partRecord = isObject(part) ? part as Record<string, unknown> : undefined;
            const raw = partRecord?.raw;
            if (isObject(raw) && typeof raw.type === 'string') {
                return raw as RenderablePart;
            }
            if (isObject(part) && typeof part.type === 'string') {
                return part as RenderablePart;
            }
            if (isObject(part) && part.kind === 'text') {
                return { ...part, sessionID: part.sessionId, messageID: part.messageId, type: 'text', text: typeof part.text === 'string' ? part.text : '' } as unknown as RenderablePart;
            }
            if (isObject(part) && part.kind === 'reasoning') {
                return { ...part, sessionID: part.sessionId, messageID: part.messageId, type: 'reasoning', text: typeof part.text === 'string' ? part.text : '', time: {} } as unknown as RenderablePart;
            }
            return part as unknown as RenderablePart;
        }),
    };
};

export const resolveUserHeaderAttribution = (message: RenderableMessage): RenderableHeaderAttribution | null => {
    const mode = getRenderableMessageProp(message, 'mode');
    const agent = getRenderableMessageProp(message, 'agent');
    const providerID = getRenderableMessageModelProp(message, 'providerID');
    const modelID = getRenderableMessageModelProp(message, 'modelID');
    const model = getRenderableMessageProp(message, 'model');
    const variant = getRenderableMessageProp(message, 'variant') ?? (isObject(model) ? model.variant : undefined);
    const attribution = isObject(message.attribution) ? message.attribution : undefined;
    const resolvedAgent = typeof mode === 'string' && mode.trim().length > 0
        ? mode
        : (typeof agent === 'string' && agent.trim().length > 0 ? agent : attribution?.modeId);
    const resolvedProvider = typeof providerID === 'string' && providerID.trim().length > 0 ? providerID : attribution?.providerId;
    const resolvedModel = typeof modelID === 'string' && modelID.trim().length > 0 ? modelID : attribution?.modelId;
    const resolvedVariant = typeof variant === 'string' && variant.trim().length > 0 ? variant : attribution?.effortId;

    if (!resolvedAgent && !resolvedProvider && !resolvedModel && !resolvedVariant) {
        return null;
    }

    return {
        agentName: resolvedAgent,
        providerId: resolvedProvider,
        modelId: resolvedModel,
        modelName: attribution?.modelLabel,
        variant: attribution?.effortLabel ?? resolvedVariant,
    };
};

export const resolveMessageAttribution = (message: RenderableMessage): RenderableHeaderAttribution => {
    const attribution = isObject(message.attribution) ? message.attribution : undefined;
    const mode = getRenderableMessageProp(message, 'mode');
    const agent = getRenderableMessageProp(message, 'agent');
    const providerID = getRenderableMessageModelProp(message, 'providerID');
    const modelID = getRenderableMessageModelProp(message, 'modelID');
    return {
        agentName: typeof mode === 'string' && mode.trim().length > 0
            ? mode
            : (typeof agent === 'string' && agent.trim().length > 0 ? agent : attribution?.modeId),
        providerId: typeof providerID === 'string' && providerID.trim().length > 0 ? providerID : attribution?.providerId,
        modelId: typeof modelID === 'string' && modelID.trim().length > 0 ? modelID : attribution?.modelId,
        modelName: attribution?.modelLabel,
        variant: attribution?.effortLabel ?? attribution?.effortId,
    };
};

const normalizeToolStatus = (status: unknown): HarnessToolActivity['status'] => {
    if (status === 'completed') return 'completed';
    if (status === 'error' || status === 'failed' || status === 'timeout') return 'failed';
    if (status === 'aborted' || status === 'cancelled') return 'cancelled';
    if (status === 'running' || status === 'started') return 'running';
    return 'pending';
};

export const toRenderableToolActivity = (part: RenderableToolPart): HarnessToolActivity => {
    const state = part.state ?? {};
    const rawMetadata = state.metadata;
    const metadata = typeof rawMetadata === 'object' && rawMetadata !== null ? rawMetadata as Record<string, unknown> : undefined;
    const files = Array.isArray(metadata?.files)
        ? metadata.files
            .map((file) => {
                if (!isObject(file)) return null;
                const path = typeof file.relativePath === 'string'
                    ? file.relativePath
                    : (typeof file.filePath === 'string' ? file.filePath : undefined);
                if (!path) return null;
                return {
                    path,
                    additions: typeof file.additions === 'number' ? file.additions : undefined,
                    deletions: typeof file.deletions === 'number' ? file.deletions : undefined,
                };
            })
            .filter((file): file is NonNullable<typeof file> => Boolean(file))
        : undefined;
    const linkedSessionId = typeof metadata?.linkedSessionId === 'string'
        ? metadata.linkedSessionId
        : (typeof metadata?.taskSessionID === 'string'
            ? metadata.taskSessionID
            : (typeof metadata?.taskSessionId === 'string'
                ? metadata.taskSessionId
                : (typeof metadata?.sessionId === 'string' ? metadata.sessionId : undefined)));

    return {
        id: part.id,
        name: part.tool,
        category: getToolCategory(part.tool),
        status: normalizeToolStatus(state.status),
        input: state.input,
        output: state.output,
        error: state.error,
        files,
        diff: typeof metadata?.diff === 'string'
            ? metadata.diff
            : (typeof metadata?.patch === 'string' ? metadata.patch : undefined),
        linkedSessionId,
        startedAt: state.time?.start,
        endedAt: state.time?.end,
        raw: part,
    };
};
