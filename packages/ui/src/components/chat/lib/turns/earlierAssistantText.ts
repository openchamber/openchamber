import { assistantTextSegments } from '@/lib/messages/messageText';
import type { Part } from '@/lib/opencode/model';
import type { ChatMessageEntry } from './types';

const segmentsByParts = new WeakMap<Part[], string[]>();

const segmentsOf = (parts: Part[]): string[] => {
    const cached = segmentsByParts.get(parts);
    if (cached) return cached;
    const segments = assistantTextSegments(parts);
    segmentsByParts.set(parts, segments);
    return segments;
};

export const earlierAssistantText = (assistantMessages: readonly ChatMessageEntry[]): string[] => (
    assistantMessages.slice(0, -1).flatMap((message) => segmentsOf(message.parts))
);
