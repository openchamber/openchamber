import { isInvisibleText } from '@/lib/invisibleText';
import { getLastConversationRecord, type ToolPart } from '@/lib/opencode/model';
import { isShownInPlace } from '@/lib/opencode/tools';
import { isSessionNoticePart } from '@/lib/opencode/session-notices';
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
        && last.parts.some((part) => part.type === 'text' && !isInvisibleText(part.text))
        ? last : undefined;
}

/**
 * Subagent calls do not count: a turn that only ran subagents gets no fold, so
 * their rows stay in view. Nor do session notices: a turn whose only row is a
 * notice shows it above the answer.
 */
export function hasLiveActivity(turn: TurnRecord, showReasoning: boolean): boolean {
    return turn.activityParts.some((activity) => (
        (activity.part.type === 'tool' && !isStandaloneTool(activity.part.tool) && !isSessionNoticePart(activity.part))
        || (showReasoning && activity.kind === 'reasoning')
    ));
}

/**
 * What a turn's calls showed the user, in the order they ran: the pages of
 * `openchamber_render` calls, waiting ones included, and the workflow runs
 * `workflow.run` calls proposed.
 */
export function getShownPages(messages: readonly ChatMessageEntry[]): ToolPart[] {
    return messages.flatMap((message) => message.parts.filter((part): part is ToolPart => (
        part.type === 'tool' && isShownInPlace(part.tool, part.state)
    )));
}
