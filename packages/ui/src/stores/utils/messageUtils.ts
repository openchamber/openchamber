import type { Part } from "@opencode-ai/sdk/v2";
import { isFinalToolStatus } from "@/lib/toolStatus";

const isRecord = (value: unknown): value is Record<string, unknown> => {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
};

const readTimestamp = (value: unknown): number | undefined => {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
};

const mergeTimeRange = (existing: unknown, incoming: unknown): Record<string, number> | undefined => {
    const existingTime = isRecord(existing) ? existing : undefined;
    const incomingTime = isRecord(incoming) ? incoming : undefined;

    const startCandidates = [
        readTimestamp(existingTime?.start),
        readTimestamp(incomingTime?.start),
    ].filter((value): value is number => typeof value === 'number');
    const endCandidates = [
        readTimestamp(existingTime?.end),
        readTimestamp(incomingTime?.end),
    ].filter((value): value is number => typeof value === 'number');

    if (startCandidates.length === 0 && endCandidates.length === 0) {
        return undefined;
    }

    const merged: Record<string, number> = {};
    if (startCandidates.length > 0) {
        merged.start = Math.min(...startCandidates);
    }
    if (endCandidates.length > 0) {
        merged.end = Math.max(...endCandidates);
    }
    return merged;
};

const mergeToolState = (existing: unknown, incoming: unknown): Record<string, unknown> | undefined => {
    const existingState = isRecord(existing) ? existing : undefined;
    const incomingState = isRecord(incoming) ? incoming : undefined;

    if (!existingState && !incomingState) {
        return undefined;
    }

    // Never downgrade a terminal status. Once a tool reaches completed/error/etc,
    // a late-arriving "running" SSE must not overwrite it.
    const existingStatus = existingState?.status;
    const incomingStatus = incomingState?.status;
    const existingIsTerminal = typeof existingStatus === 'string' && isFinalToolStatus(existingStatus);
    const incomingIsTerminal = typeof incomingStatus === 'string' && isFinalToolStatus(incomingStatus);

    const merged: Record<string, unknown> = {
        ...(existingState ?? {}),
        ...(incomingState ?? {}),
    };

    // If existing was terminal but incoming is not, keep the terminal status.
    if (existingIsTerminal && !incomingIsTerminal && typeof incomingStatus === 'string') {
        merged.status = existingStatus;
    }

    const mergedTime = mergeTimeRange(existingState?.time, incomingState?.time);
    if (mergedTime) {
        merged.time = mergedTime;
    }

    if (isRecord(existingState?.metadata) || isRecord(incomingState?.metadata)) {
        merged.metadata = {
            ...(isRecord(existingState?.metadata) ? existingState.metadata : {}),
            ...(isRecord(incomingState?.metadata) ? incomingState.metadata : {}),
        };
    }

    if (isRecord(existingState?.input) || isRecord(incomingState?.input)) {
        merged.input = {
            ...(isRecord(existingState?.input) ? existingState.input : {}),
            ...(isRecord(incomingState?.input) ? incomingState.input : {}),
        };
    }

    return merged;
};

const extractTextFromDelta = (delta: unknown): string => {
    if (!delta) return '';
    if (typeof delta === 'string') return delta;
    if (Array.isArray(delta)) {
        return delta.map((item) => extractTextFromDelta(item)).join('');
    }
    if (typeof delta === 'object') {
        if (typeof (delta as { text?: unknown }).text === 'string') {
            return (delta as { text: string }).text;
        }
        if (Array.isArray((delta as { content?: unknown[] }).content)) {
            return (delta as { content: unknown[] }).content.map((item: unknown) => extractTextFromDelta(item)).join('');
        }
    }
    return '';
};

export const extractTextFromPart = (part: unknown): string => {
    if (!part) return '';
    const typedPart = part as { text?: string | unknown[]; content?: string | unknown[]; value?: string | unknown[]; delta?: unknown };

    const toText = (value: unknown): string => {
        if (typeof value === 'string') {
            return value;
        }
        if (Array.isArray(value)) {
            return value
                .map((item: unknown) => {
                    if (typeof item === 'string') return item;
                    if (item && typeof item === 'object') {
                        const typedItem = item as { text?: unknown; content?: unknown; value?: unknown; delta?: unknown };
                        return toText(typedItem.text) || toText(typedItem.content) || toText(typedItem.value) || extractTextFromDelta(typedItem.delta);
                    }
                    return '';
                })
                .join('');
        }
        return '';
    };

    const candidates = [
        toText(typedPart.text),
        toText(typedPart.content),
        toText(typedPart.value),
        extractTextFromDelta(typedPart.delta),
    ];

    let best = '';
    for (const candidate of candidates) {
        if (candidate.length > best.length) {
            best = candidate;
        }
    }

    return best;
};

export const normalizeStreamingPart = (incoming: Part, existing?: Part): Part => {
    const normalized: { type?: string; text?: string; content?: string; value?: string; delta?: unknown; [key: string]: unknown } = {
        ...(existing as Record<string, unknown> | undefined),
        ...incoming,
    } as { type?: string; text?: string; content?: string; value?: string; delta?: unknown; [key: string]: unknown };
    const existingType = typeof (existing as { type?: unknown } | undefined)?.type === 'string'
        ? (existing as { type: string }).type
        : undefined;
    normalized.type = normalized.type || existingType || 'text';

    const isStreamingTextLikePart = normalized.type === 'text' || normalized.type === 'reasoning';

    if (isStreamingTextLikePart) {
        const existingRecord = (existing ?? {}) as { text?: unknown; content?: unknown; value?: unknown };
        const existingText = extractTextFromPart(existing);
        const directText = extractTextFromPart(incoming);
        const deltaText = extractTextFromDelta((incoming as { delta?: unknown }).delta);
        let mergedText = '';

        const incomingField =
            typeof normalized.text === 'string'
                ? 'text'
                : typeof normalized.content === 'string'
                    ? 'content'
                    : typeof normalized.value === 'string'
                        ? 'value'
                        : null;

        const targetField = incomingField ?? (
            typeof existingRecord.text === 'string'
                ? 'text'
                : typeof existingRecord.content === 'string'
                    ? 'content'
                    : typeof existingRecord.value === 'string'
                        ? 'value'
                        : 'text'
        );

        if (deltaText) {
            mergedText = existingText ? `${existingText}${deltaText}` : deltaText;
        } else if (directText) {
            mergedText = directText;
        } else {
            mergedText = existingText;
        }

        normalized[targetField] = mergedText;
        if (targetField !== 'text') {
            normalized.text = mergedText;
        }

        delete normalized.delta;
    }

    const mergedTime = mergeTimeRange(
        (existing as { time?: unknown } | undefined)?.time,
        (incoming as { time?: unknown } | undefined)?.time,
    );
    if (mergedTime) {
        normalized.time = mergedTime;
    }

    if (normalized.type === 'tool') {
        const mergedState = mergeToolState(
            (existing as { state?: unknown } | undefined)?.state,
            (incoming as { state?: unknown } | undefined)?.state,
        );
        if (mergedState) {
            normalized.state = mergedState;
        }
    }

    return normalized as Part;
};
