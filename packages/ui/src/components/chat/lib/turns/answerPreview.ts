import { isInvisibleText } from '@/lib/invisibleText';
import { getLiveFinalMessage } from './liveActivity';
import type { TurnRecord } from './types';

const firstLine = (markdown: string): string => {
    for (const raw of markdown.split('\n')) {
        const line = raw
            .replace(/^\s*(?:#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/, '')
            .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
            .replace(/\*\*|__|~~|`/g, '')
            .trim();
        if (line && !/^(?:`{3,}|-{3,}|\|)/.test(raw.trim())) return line;
    }
    return '';
};

interface AnswerPreview {
    text: string;
    failed: boolean;
    at: number | undefined;
}

export const answerPreview = (turn: TurnRecord): AnswerPreview => {
    const info = turn.assistantMessages.at(-1)?.info;
    const at = info?.role === 'assistant' ? info.time.completed ?? info.time.created : turn.userMessage.info.time.created;
    const answer = getLiveFinalMessage(turn.assistantMessages);
    const text = answer?.parts.find((part) => part.type === 'text' && !isInvisibleText(part.text));
    if (text?.type === 'text') return { text: firstLine(text.text), failed: false, at };
    const error = info?.role === 'assistant' ? info.error : undefined;
    return { text: error ? firstLine(error.message ?? '') : '', failed: error !== undefined, at };
};
