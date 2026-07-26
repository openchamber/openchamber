import type { Message, Part } from '@opencode-ai/sdk/v2';

import { deriveMessageRole } from './messageRole';
import { filterVisibleParts, normalizeParts } from './partUtils';
import { normalizeUserDisplayParts } from './normalizeUserDisplayParts';

/**
 * A user message is hidden when none of its parts survive display
 * normalization (e.g. synthetic subagent-completion nudges). Turns separated
 * only by such messages should render as one continuous flow.
 */
// Streaming recomputes turn projections often; cache by parts reference so
// unchanged messages resolve without re-running display normalization.
const hiddenByPartsPlanMode = new WeakMap<Part[], boolean>();
const hiddenByPartsNoPlanMode = new WeakMap<Part[], boolean>();

export const isHiddenUserMessage = (
    entry: { info: Message; parts: Part[] } | null | undefined,
    options: { planModeEnabled: boolean }
): boolean => {
    if (!entry) return false;
    if (!deriveMessageRole(entry.info).isUser) return false;

    const cache = options.planModeEnabled ? hiddenByPartsPlanMode : hiddenByPartsNoPlanMode;
    const cached = cache.get(entry.parts);
    if (cached !== undefined) {
        return cached;
    }

    const parts = normalizeUserDisplayParts(normalizeParts(entry.parts), { planModeEnabled: options.planModeEnabled });
    const hidden = filterVisibleParts(parts, { includeReasoning: true }).length === 0;
    cache.set(entry.parts, hidden);
    return hidden;
};
