import type { ChatMessageEntry, TurnRecord } from './types';

/** A queued user message alone does not retire the previous turn. */
export function getTurnsWithLaterAssistant(turns: readonly TurnRecord[]): Set<string> {
    const retired = new Set<string>();
    let hasLaterAssistant = false;
    for (let index = turns.length - 1; index >= 0; index--) {
        const turn = turns[index];
        if (hasLaterAssistant) retired.add(turn.turnId);
        hasLaterAssistant ||= turn.assistantMessages.length > 0;
    }
    return retired;
}

export function getLiveFinalMessage(messages: readonly ChatMessageEntry[]): ChatMessageEntry | undefined {
    const last = messages.at(-1);
    // Do not use projectTurnSummary's intermediate-text fallback. Compaction
    // summaries are not user-facing final answers either.
    return last?.info.role === 'assistant' && last.info.finish === 'stop' && !last.info.summary
        && last.parts.some((part) => part.type === 'text' && part.text.trim().length > 0)
        ? last : undefined;
}

export function hasLiveActivity(turn: TurnRecord, showReasoning: boolean): boolean {
    return turn.activitySegments.some((segment) => segment.parts.some((activity) => (
        activity.kind === 'tool' || (showReasoning && activity.kind === 'reasoning')
    )));
}
