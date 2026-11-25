
import type { Metadata, ToolInput } from '@/lib/opencode/model';
import { recordedQuestionAnswers } from '@/lib/opencode/questionAnswers';

export const parseQuestionOutput = (output: string): Array<{ question: string; answer: string }> | null => {
    const match = output.match(/^User has answered your questions:\s*(.+?)\.\s*You can now/s);
    if (!match) return null;

    const pairs: Array<{ question: string; answer: string }> = [];
    const content = match[1];

    const pairRegex = /"([^"]+)"="([^"]*(?:[^"\\]|\\.)*)"/g;
    let pairMatch;
    while ((pairMatch = pairRegex.exec(content)) !== null) {
        pairs.push({
            question: pairMatch[1],
            answer: pairMatch[2],
        });
    }

    return pairs.length > 0 ? pairs : null;
};

export const questionSentence = (question: string): string => {
    const text = question.replace(/\s+/g, ' ').trim();
    const sentences = text.split(/(?<=[.?!][)\]"'”’]*)\s+/);
    for (let index = sentences.length - 1; index >= 0; index -= 1) {
        if (sentences[index].endsWith('?')) return sentences[index];
    }
    return text;
};

export const questionAnswersForCall = (
    metadata: Metadata | undefined,
    input: ToolInput | undefined,
    output: string,
    unansweredLabel: string,
): Array<{ question: string; answer: string }> | null => {
    const recorded = recordedQuestionAnswers(input, metadata);
    if (recorded) {
        return recorded.map(({ question, picks }) => ({ question, answer: picks.length > 0 ? picks.join(', ') : unansweredLabel }));
    }
    return parseQuestionOutput(output);
};
