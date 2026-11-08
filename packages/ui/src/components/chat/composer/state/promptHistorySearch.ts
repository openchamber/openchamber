import { matchesRankQuery } from '../../../../lib/search/fuzzySearch';

import type { MessageHistoryValue } from './useMessageHistory';

export type PromptHistoryCandidate<TAttachment> = {
    index: number;
    value: MessageHistoryValue<TAttachment>;
};

export function preparePromptHistory<TAttachment>(
    history: readonly MessageHistoryValue<TAttachment>[],
): PromptHistoryCandidate<TAttachment>[] {
    const newestByText = new Set<string>();
    const candidates: PromptHistoryCandidate<TAttachment>[] = [];

    for (let index = history.length - 1; index >= 0; index -= 1) {
        const value = history[index]!;
        if (!value.text.trim() || newestByText.has(value.text)) continue;
        newestByText.add(value.text);
        candidates.push({ index, value });
    }

    return candidates.reverse();
}

export function filterPromptHistory<TAttachment>(
    candidates: readonly PromptHistoryCandidate<TAttachment>[],
    query: string,
): PromptHistoryCandidate<TAttachment>[] {
    return candidates.filter((candidate) => matchesRankQuery([candidate.value.text], query));
}
