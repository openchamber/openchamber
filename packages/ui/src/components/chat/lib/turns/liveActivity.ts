import { getLastConversationRecord, type ToolPart } from '@/lib/opencode/model';
import { renderedPage } from '@/lib/opencode/tools';
import { isStandaloneTool } from '../../message/parts/toolRenderUtils';
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
    // Do not use projectTurnSummary's intermediate-text fallback. Compaction,
    // synthetic prompts, skill and shell records are their own message roles
    // in v2 and can trail the final answer, so the lookup skips them instead
    // of reading the last record.
    const last = getLastConversationRecord(messages);
    return last?.info.role === 'assistant' && last.info.finish === 'stop'
        && last.parts.some((part) => part.type === 'text' && part.text.trim().length > 0)
        ? last : undefined;
}

/** Subagent calls do not count: a turn that only ran subagents gets no fold, so their rows stay in view. */
export function hasLiveActivity(turn: TurnRecord, showReasoning: boolean): boolean {
    return turn.activityParts.some((activity) => (
        (activity.part.type === 'tool' && !isStandaloneTool(activity.part.tool))
        || (showReasoning && activity.kind === 'reasoning')
    ));
}

/** The pages a turn's `openchamber_render` calls showed, waiting ones included, in the order they ran. */
export function getShownPages(messages: readonly ChatMessageEntry[]): ToolPart[] {
    return messages.flatMap((message) => message.parts.filter((part): part is ToolPart => (
        part.type === 'tool' && renderedPage(part.tool, part.state) !== null
    )));
}
