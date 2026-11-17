import type { FormField } from '@opencode/client';
import { questionAnswerOf, type QuestionAnswer, type QuestionPrompt } from '@/lib/opencode/question';
import { type FormValues, buildFormAnswer, initialFormValues, isAnswerableField, valueOf } from './formCardState';

/**
 * Answers to an agent's `question` call that outlive the call: the dock
 * records them as the user picks, so a question dismissed, stopped or failed
 * can be answered again from its transcript row starting where the user was.
 * The row records what the user keeps or sends from it after the call ended.
 * Keyed by `questionCallKey`; memory only, like the dock's own drafts.
 */
type KeptAnswers = { answers: QuestionAnswer[]; afterEnd: boolean };
const rememberedAnswers = new Map<string, KeptAnswers>();
const MAX_REMEMBERED_ANSWERS = 50;

const keepAnswers = (callKey: string, kept: KeptAnswers): void => {
    rememberedAnswers.delete(callKey);
    rememberedAnswers.set(callKey, kept);
    if (rememberedAnswers.size > MAX_REMEMBERED_ANSWERS) {
        const oldest = rememberedAnswers.keys().next().value;
        if (oldest !== undefined) rememberedAnswers.delete(oldest);
    }
};

/** What the user picks in the question dock or the inline form card while the call waits. */
export const rememberPendingQuestionAnswers = (callKey: string, answers: QuestionAnswer[]): void => {
    keepAnswers(callKey, { answers, afterEnd: false });
};

/** What the user keeps (Cancel) or sends from the call's row after the call ended. */
export const rememberQuestionAnswers = (callKey: string, answers: QuestionAnswer[]): void => {
    keepAnswers(callKey, { answers, afterEnd: true });
};

/**
 * The answers a form opened from the call's row starts from: what the user
 * kept or sent from the row, else the answers the call returned, else the
 * picks made while it waited. Those picks never win over returned answers:
 * the dock records its starting values before anyone picks, and the call may
 * have been answered in another window.
 */
export const startingQuestionAnswers = (callKey: string, returned: QuestionAnswer[] | null): QuestionAnswer[] | null => {
    const kept = rememberedAnswers.get(callKey);
    if (kept?.afterEnd) return kept.answers;
    return returned ?? kept?.answers ?? null;
};

/** Each question's answer as OpenCode's tool would report it, from the form's current values. */
export function answersFromFormValues(fields: readonly FormField[], values: FormValues): QuestionAnswer[] {
    const reply = buildFormAnswer(fields, values);
    return fields.map((field) => questionAnswerOf(reply[field.key]));
}

/**
 * Form values that show these answers: a chosen option is selected again,
 * and text that names no option goes back into the field's own-answer box.
 */
export function formValuesFromAnswers(fields: readonly FormField[], answers: readonly QuestionAnswer[]): FormValues {
    const values = initialFormValues(fields);
    fields.forEach((field, index) => {
        const answer = answers[index];
        if (!answer || answer.length === 0 || !isAnswerableField(field)) return;
        if (field.type !== 'string' && field.type !== 'multiselect') return;
        const optionValues = new Set((field.options ?? []).map((option) => option.value));
        const chosen = answer.filter((entry) => optionValues.has(entry));
        const typed = answer.find((entry) => !optionValues.has(entry)) ?? '';
        const value = valueOf(values, field.key);
        if (field.type === 'multiselect') {
            values[field.key] = { ...value, selected: chosen, text: typed, custom: typed.length > 0 };
            return;
        }
        values[field.key] = typed.length > 0
            ? { ...value, selected: [], text: typed, custom: true }
            : { ...value, selected: chosen.slice(0, 1), text: '', custom: false };
    });
    return values;
}

export type QuestionAnswerMessageLabels = {
    /** The line that opens the message, in the user's language. */
    intro: string;
    /** Stands in for a question left without an answer. */
    unanswered: string;
};

/**
 * The message that carries answers given after the call ended, in the
 * `"question"="answer"` shape OpenCode's tool result uses, so the agent reads
 * them the way it reads an answer to its call.
 */
export function formatQuestionAnswers(
    prompts: readonly QuestionPrompt[],
    answers: readonly QuestionAnswer[],
    labels: QuestionAnswerMessageLabels,
): string {
    const lines = prompts.map((prompt, index) => {
        const answer = answers[index];
        const text = answer && answer.length > 0 ? answer.join(', ') : labels.unanswered;
        return `- "${prompt.question}"="${text}"`;
    });
    return [labels.intro, ...lines].join('\n');
}
