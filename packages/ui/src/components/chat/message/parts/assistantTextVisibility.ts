import { commitStreamedText } from '../../lib/streamTextCommit';
import type { StreamPhase } from '../types';
import { collectOpenUIFences, normalizeOpenUISource } from '../../markdown/openuiFences';
import type { OpenUIAnalyzedSource } from '../../markdown/openuiMarkdownContext';

// A text part sealed with `time.end` can no longer receive tokens, so the
// block-commit hold — which exists to keep a growing paragraph from mutating
// in place — has nothing left to protect for that part. Gating on part
// finalization keeps the hold for genuinely streaming parts while releasing
// sealed ones: a message blocked on a pending question (or permission ask)
// never finishes, so its pre-question text would otherwise keep its last
// line hidden until the user answers (#3277).
export const resolveAssistantTextStreaming = (input: {
    streamPhase: StreamPhase;
    isFinalized: boolean;
}): boolean => {
    if (input.isFinalized) {
        return false;
    }
    return input.streamPhase === 'streaming' || input.streamPhase === 'cooldown';
};

type AssistantDisplayText = { content: string; openuiSource?: OpenUIAnalyzedSource };

export const resolveAssistantDisplayText = (input: {
    textContent: string;
    throttledTextContent: string;
    isStreaming: boolean;
    allowOpenUI?: boolean;
}): AssistantDisplayText => {
    // While streaming, reveal whole blocks only: rendering stops at the end of
    // the last finished block so a shown paragraph never mutates in place.
    // The held tail lands when its block ends (or with the finalize pass).
    if (!input.isStreaming) return { content: input.textContent };
    const displayed = input.allowOpenUI && input.throttledTextContent.includes('openui-lang')
        ? normalizeOpenUISource(input.throttledTextContent) : input.throttledTextContent;
    const committed = commitStreamedText(displayed);
    if (!input.allowOpenUI || !displayed.includes('openui-lang')) return { content: committed };
    const fences = collectOpenUIFences(displayed);
    const fence = [...fences].reverse().find((item) => !item.literal && !item.meta);
    const content = fence && fence.end > committed.length ? displayed.slice(0, fence.end) : committed;
    const openuiSource: OpenUIAnalyzedSource = { source: content, fences: fences.filter((item) => item.end <= content.length) };
    return { content, openuiSource };
};
