
import { z } from 'zod';

import type { Metadata, ToolInput } from '@/lib/opencode/model';

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

const recordedAnswersSchema = z.object({ answers: z.array(z.array(z.string())) });

const askedQuestionsSchema = z.object({ questions: z.array(z.object({ question: z.string() })) });

const recordedAnswers = (metadata: Metadata | undefined): string[][] | null => {
    const parsed = recordedAnswersSchema.safeParse(metadata);
    return parsed.success ? parsed.data.answers : null;
};

const askedQuestionTexts = (input: ToolInput | undefined): string[] => {
    const parsed = askedQuestionsSchema.safeParse(input);
    return parsed.success ? parsed.data.questions.map((question) => question.question) : [];
};

const answerText = (answer: readonly string[], unansweredLabel: string): string => {
    const picked = answer.filter((value) => value.length > 0);
    return picked.length > 0 ? picked.join(', ') : unansweredLabel;
};

export const questionAnswersForCall = (
    metadata: Metadata | undefined,
    input: ToolInput | undefined,
    output: string,
    unansweredLabel: string,
): Array<{ question: string; answer: string }> | null => {
    const recorded = recordedAnswers(metadata);
    const questions = askedQuestionTexts(input);
    if (recorded && questions.length > 0 && recorded.length === questions.length) {
        return questions.map((question, index) => ({ question, answer: answerText(recorded[index], unansweredLabel) }));
    }
    return parseQuestionOutput(output);
};
