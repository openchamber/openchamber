import { assistantTextSegments } from '@/lib/messages/messageText';
import type { Part } from '@/lib/opencode/model';
import type { ChatMessageEntry } from './types';

// A settled step keeps its parts array, so its text is read once instead of
// on every update of the step that is still streaming.
const segmentsByParts = new WeakMap<Part[], string[]>();

const segmentsOf = (parts: Part[]): string[] => {
    const cached = segmentsByParts.get(parts);
    if (cached) return cached;
    const segments = assistantTextSegments(parts);
    segmentsByParts.set(parts, segments);
    return segments;
};

/** The text parts of every assistant message of a turn except the last, in order. */
export const earlierAssistantText = (assistantMessages: readonly ChatMessageEntry[]): string[] => (
    assistantMessages.slice(0, -1).flatMap((message) => segmentsOf(message.parts))
);
