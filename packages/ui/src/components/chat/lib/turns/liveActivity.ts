import { isInvisibleText } from '@/lib/invisibleText';
import { getLastConversationRecord, type TextPart, type ToolPart } from '@/lib/opencode/model';
import { isShownInPlace, openChamberToolCall } from '@/lib/opencode/tools';
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

/** Something the turn showed the user that a collapsed Activity never folds away. */
export type ShownPart = ToolPart | TextPart;

// An opening `openui-lang` fence; `openui-lang literal` is a code sample and stays text.
const UI_BLOCK_FENCE = /^ {0,3}(`{3,}|~{3,})openui-lang[ \t]*$/m;

/**
 * A form or secret card that asked the user and no longer waits: answered,
 * answered in the chat instead, or stopped. Like the question tool's card it
 * is a step from then on, so a collapsed Activity folds it.
 */
const isSettledAsk = (part: ToolPart): boolean => (
    part.state.status !== 'running' && part.state.status !== 'pending'
    && openChamberToolCall(part.tool, part.state.input)?.awaitsAnswer === true
);

/**
 * What a turn showed the user, in the order it happened: the pages of
 * `openchamber_render` calls, and forms only while they wait, the workflow
 * runs `workflow.run` calls proposed, and text with a UI block that the agent
 * wrote before a later step. The final answer's own text is the answer, so
 * it is never hoisted.
 */
export function getShownPages(messages: readonly ChatMessageEntry[], finalMessage?: ChatMessageEntry): ShownPart[] {
    return messages.flatMap((message) => message.parts.filter((part): part is ShownPart => (
        (part.type === 'tool' && isShownInPlace(part.tool, part.state) && !isSettledAsk(part))
        || (part.type === 'text' && message !== finalMessage && UI_BLOCK_FENCE.test(part.text))
    )));
}
