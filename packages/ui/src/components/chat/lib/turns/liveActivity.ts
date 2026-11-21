import { isInvisibleText } from '@/lib/invisibleText';
import { getLastConversationRecord, type TextPart, type ToolPart } from '@/lib/opencode/model';
import { isShownInPlace, openChamberToolCall, renderedPage } from '@/lib/opencode/tools';
import { isSessionNoticePart } from '@/lib/opencode/session-notices';
import { isStandaloneTool } from '../../message/parts/toolRenderUtils';
import { fenceUiBlocks } from '../../uiBlocks/taggedBlocks';
import type { ChatMessageEntry, TurnRecord } from './types';

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
    const last = getLastConversationRecord(messages);
    return last?.info.role === 'assistant' && last.info.finish === 'stop'
        && last.parts.some((part) => part.type === 'text' && !isInvisibleText(part.text))
        ? last : undefined;
}

export function hasLiveActivity(turn: TurnRecord, showReasoning: boolean): boolean {
    return turn.activityParts.some((activity) => (
        (activity.part.type === 'tool' && !isStandaloneTool(activity.part.tool) && !isSessionNoticePart(activity.part))
        || (showReasoning && activity.kind === 'reasoning')
    ));
}

export type ShownPart = ToolPart | TextPart;

const UI_BLOCK_FENCE = /^ {0,3}(`{3,}|~{3,})openui-lang[ \t]*$/m;

export const isSettledAsk = (part: ToolPart): boolean => (
    part.state.status !== 'running' && part.state.status !== 'pending'
    && openChamberToolCall(part.tool, part.state.input)?.awaitsAnswer === true
);

const continuesShownText = (part: ToolPart, previous: ShownPart | undefined): boolean => (
    previous !== undefined && isSettledAsk(part) && renderedPage(part.tool, part.state) !== null
    && (previous.type === 'text' || isSettledAsk(previous))
);

export const hasUiBlock = (text: string): boolean => UI_BLOCK_FENCE.test(fenceUiBlocks(text));

export function getShownPages(messages: readonly ChatMessageEntry[], finalMessage?: ChatMessageEntry, keepText = false): ShownPart[] {
    const shown: ShownPart[] = [];
    for (const message of messages) {
        for (const part of message.parts) {
            if (part.type === 'tool') {
                const inView = isShownInPlace(part.tool, part.state) && !isSettledAsk(part);
                if (inView || continuesShownText(part, shown.at(-1))) shown.push(part);
            } else if (part.type === 'text' && message !== finalMessage && (keepText ? !isInvisibleText(part.text) : hasUiBlock(part.text))) {
                shown.push(part);
            }
        }
    }
    return shown;
}

export function uiPageMessageId(turn: TurnRecord | undefined, expanded: boolean, messageId: string, partId: string): string {
    const final = turn ? getLiveFinalMessage(turn.assistantMessages) : undefined;
    return !expanded && turn && final && getShownPages(turn.assistantMessages, final).some((part) => part.id === partId && part.messageID === messageId)
        ? final.info.id
        : messageId;
}
