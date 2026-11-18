import type { Message, Part } from '@/lib/opencode/model';

import { deriveMessageRole } from './messageRole';
import { filterVisibleParts, normalizeParts } from './partUtils';
import { normalizeUserDisplayParts } from './normalizeUserDisplayParts';
import { readSourceControlProvider } from '@/lib/source-control/providers/registry';

const hiddenByParts = new WeakMap<Part[], boolean>();

export const isHiddenUserMessage = (
    entry: { info: Message; parts: Part[] } | null | undefined,
): boolean => {
    if (!entry) return false;
    if (!deriveMessageRole(entry.info).isUser) return false;

    const cached = hiddenByParts.get(entry.parts);
    if (cached !== undefined) {
        return cached;
    }

    const parts = normalizeUserDisplayParts(normalizeParts(entry.parts), readSourceControlProvider);
    const hidden = filterVisibleParts(parts, { includeReasoning: true }).length === 0;
    hiddenByParts.set(entry.parts, hidden);
    return hidden;
};
