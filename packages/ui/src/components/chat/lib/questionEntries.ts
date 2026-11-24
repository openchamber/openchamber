/**
 * The questions an assistant turn asked and the answers the user gave.
 *
 * The question tool keeps its options in the call input and the user's reply in
 * the call output, so both survive a message page. These readers turn that pair
 * into the entries the transcript, the prompt selector and the timeline draw.
 */

import { z } from 'zod';

import { classifyQuestionToolError } from '@/sync/recoverable-questions';
import type { ChatMessageEntry } from './turns/types';
import { buildTurnWindowModel, type TurnWindowModel } from './turns/windowTurns';
import { isQuestionTool } from '@/lib/opencode/tools';
import type { Part, ToolInput } from '@/lib/opencode/model';

export interface QuestionOption {
    label: string;
    description?: string;
}

interface QuestionAsked {
    header?: string;
    question: string;
    options: QuestionOption[];
    multiple: boolean;
}

export interface QuestionAnswerEntry {
    partId: string;
    messageId: string;
    header?: string;
    question: string;
    options: QuestionOption[];
    multiple: boolean;
    /** The reply the user gave, or null when the question was not answered. */
    answer: string | null;
    /** True while the call still waits for the reply. */
    pending: boolean;
}

interface QuestionAnswerPair {
    question: string;
    answer: string;
}

const questionOptionSchema = z.object({
    label: z.string().trim().min(1),
    description: z.string().trim().optional(),
});

const questionAskedSchema = z.object({
    header: z.string().trim().optional(),
    question: z.string().trim().min(1),
    options: z.array(questionOptionSchema).optional(),
    multiple: z.boolean().optional(),
});

const questionInputSchema = z.object({
    questions: z.array(questionAskedSchema),
});

/** The questions a question call asked, in the order the call stored them. */
export const readQuestionInput = (input: ToolInput | undefined): QuestionAsked[] => {
    const parsed = questionInputSchema.safeParse(input);
    if (!parsed.success) return [];
    return parsed.data.questions.map((question) => ({
        header: question.header || undefined,
        question: question.question,
        options: (question.options ?? []).map((option) => (
            option.description ? { label: option.label, description: option.description } : { label: option.label }
        )),
        multiple: question.multiple === true,
    }));
};

const unescapeQuoted = (value: string): string => value.replace(/\\(["\\])/g, '$1');

/**
 * The question tool appends this marker to the option it recommends, so the
 * recorded answer carries it even though the option's label does not. Matching
 * the label needs the marker gone.
 */
const RECOMMENDATION_SUFFIX = ' (Recommended)';
export const withoutRecommendation = (value: string): string => (
    value.endsWith(RECOMMENDATION_SUFFIX)
        ? value.slice(0, -RECOMMENDATION_SUFFIX.length)
        : value
);

/**
 * A reply with the marker gone from every pick it names. A multi-select answer
 * joins its labels with `, `, so the marker can sit on any of them; stripping
 * only the end of the string leaves the others in place and the reply then
 * matches no option.
 */
export const withoutRecommendationPicks = (value: string): string => (
    value.split(/\s*,\s*/).map(withoutRecommendation).join(', ')
);

/**
 * Parses the question tool's reply:
 * `User has answered your questions: "Q1"="A1", "Q2"="A2". You can now…`
 */
export const parseQuestionAnswers = (output: string): QuestionAnswerPair[] | null => {
    const match = output.match(/^User has answered your questions:\s*(.+?)\.\s*You can now/s);
    if (!match) return null;

    const pairs: QuestionAnswerPair[] = [];
    // A quoted string with backslash escapes on both sides; an answer may carry
    // a quote the user typed.
    const pairRegex = /"((?:[^"\\]|\\.)*)"="((?:[^"\\]|\\.)*)"/g;
    let pairMatch: RegExpExecArray | null;
    while ((pairMatch = pairRegex.exec(match[1])) !== null) {
        pairs.push({
            question: unescapeQuoted(pairMatch[1]),
            answer: unescapeQuoted(pairMatch[2]),
        });
    }
    return pairs.length > 0 ? pairs : null;
};

const answerForQuestion = (
    question: string,
    index: number,
    answers: QuestionAnswerPair[],
): string | null => {
    // The tool writes the answers in the order it asked the questions, so the
    // pair at this index is this question's answer. Matching by text first
    // would hand the first answer to every entry when a call asks the same
    // question text twice.
    const indexed = answers[index];
    if (indexed && indexed.question === question) return indexed.answer;
    const exact = answers.find((pair) => pair.question === question);
    if (exact) return exact.answer;
    return indexed?.answer ?? null;
};

/** One question call's entries, with its answers matched back to its questions. */
export const questionEntriesForPart = (part: Part, messageId: string): QuestionAnswerEntry[] => {
    if (part.type !== 'tool' || !isQuestionTool(part.tool)) return [];

    const state = part.state;
    const asked = readQuestionInput(state.input);
    const output = state.status === 'completed' ? state.output : '';
    const answers = output ? parseQuestionAnswers(output) ?? [] : [];
    const pending = state.status === 'pending' || state.status === 'running';

    if (asked.length === 0) {
        return answers.map((pair, index) => ({
            partId: `${part.id}:${index}`,
            messageId,
            question: pair.question,
            options: [],
            multiple: false,
            answer: pair.answer,
            pending: false,
        }));
    }

    return asked.map((question, index) => ({
        partId: `${part.id}:${index}`,
        messageId,
        header: question.header,
        question: question.question,
        options: question.options,
        multiple: question.multiple,
        answer: answerForQuestion(question.question, index, answers),
        pending,
    }));
};

/**
 * Where a question call stands, as its transcript card shows it: answered,
 * still waiting at the composer, dismissed without an answer, or stopped
 * (the run ended or failed before an answer came).
 */
export type QuestionCardState = 'answered' | 'waiting' | 'dismissed' | 'stopped';

export const questionCardState = (part: Part): QuestionCardState | null => {
    if (part.type !== 'tool' || !isQuestionTool(part.tool)) return null;
    const state = part.state;
    if (state.status === 'pending' || state.status === 'running') return 'waiting';
    if (state.status === 'completed') return (parseQuestionAnswers(state.output)?.length ?? 0) > 0 ? 'answered' : 'dismissed';
    const error = 'error' in state ? state.error : undefined;
    const message = typeof error === 'string' ? error : (error as { message?: string } | undefined)?.message ?? '';
    // The app's own classifier: a call OpenCode aborted, or one that died with
    // the turn, was not dismissed by the reader whatever its error text says.
    const outcome = classifyQuestionToolError(message, state.errorType, state.errorSource === 'local');
    return outcome === 'dismissed' ? 'dismissed' : 'stopped';
};

/** Whether a question call finished with at least one answer. */
export const isAnsweredQuestionPart = (part: Part): boolean => {
    if (part.type !== 'tool' || !isQuestionTool(part.tool)) return false;
    if (part.state.status !== 'completed') return false;
    return (parseQuestionAnswers(part.state.output)?.length ?? 0) > 0;
};

/**
 * Whether a waiting question draws nothing at its call: with questions in the
 * chat the form at the transcript's end takes the answer, and the card appears
 * there. Every other state, and every call without that setting, draws.
 */
export const questionPartSuppressed = (part: Part, questionsInChat: boolean): boolean => {
    if (!questionsInChat) return false;
    return questionCardState(part) === 'waiting';
};

/**
 * Where one question of a call stands, which is not always where the call
 * does: a call that got an answer for one of its questions is answered, and
 * that says nothing about the question it left blank.
 */
export const questionEntryState = (
    entry: QuestionAnswerEntry,
    callState: QuestionCardState | null,
): QuestionCardState => {
    if (entry.answer) return 'answered';
    if (entry.pending) return 'waiting';
    return callState === 'stopped' ? 'stopped' : 'dismissed';
};

/** The text a card shows in place of a question's answer. */
type QuestionStateKey =
    | 'chat.toolPart.awaitingResponse'
    | 'chat.questionCard.notAnswered'
    | 'chat.questionCard.stoppedBeforeAnswer';

export const questionStateKey = (state: QuestionCardState): QuestionStateKey => (
    state === 'waiting'
        ? 'chat.toolPart.awaitingResponse'
        : state === 'dismissed'
            ? 'chat.questionCard.notAnswered'
            : 'chat.questionCard.stoppedBeforeAnswer'
);

/**
 * Splits a multi-select reply into the labels it names. The reply is the
 * chosen labels joined with `, `, and a label may itself contain a comma, so
 * the longest label wins at each step; a reply that does not decompose into
 * labels is not a set of picks.
 */
const parseJoinedLabels = (reply: string, labels: readonly string[]): string[] | null => {
    const candidates = [...new Set(labels)].sort((a, b) => b.length - a.length);
    const walk = (rest: string): string[] | null => {
        if (rest.length === 0) return [];
        for (const label of candidates) {
            if (!rest.startsWith(label)) continue;
            const after = rest.slice(label.length);
            if (after.length === 0) return [label];
            if (!after.startsWith(', ')) continue;
            const tail = walk(after.slice(2));
            if (tail) return [label, ...tail];
        }
        return null;
    };
    return walk(reply);
};

/**
 * The labels among `options` that the answer names. A single-select answer
 * names an option only when it is that label exactly; a multi-select reply is
 * the chosen labels joined, so it is parsed as a sequence of whole labels.
 */
export const selectedOptionLabels = (
    options: readonly QuestionOption[],
    answer: string | null,
    multiple: boolean,
): Set<string> => {
    const selected = new Set<string>();
    if (!answer) return selected;
    const trimmed = answer.trim();
    if (!trimmed) return selected;

    const labels = options.map((option) => option.label);
    // The tool marks its recommended option in the recorded answer, so the
    // label match has to ignore that marker.
    const bare = withoutRecommendation(trimmed);
    const exact = labels.find((label) => label === trimmed || label === bare);
    if (exact) {
        selected.add(exact);
        return selected;
    }
    if (!multiple) return selected;

    const parsed = parseJoinedLabels(bare, labels) ?? parseJoinedLabels(trimmed, labels);
    if (parsed) {
        for (const label of parsed) selected.add(label);
        return selected;
    }

    // A reply that is not exactly the joined labels (free text alongside picks)
    // still marks the labels it names as whole comma segments. The tool's
    // recommendation marker can sit on any pick, not only the last one.
    const segments = trimmed.split(/\s*,\s*/).map((segment) => segment.trim());
    const bareSegments = segments.map(withoutRecommendation);
    for (const label of labels) {
        if (segments.includes(label) || bareSegments.includes(label)) selected.add(label);
    }
    return selected;
};

/**
 * The turn whose opening is the latest at or before `index`. The turn model's
 * ordered openings place a step after a mid-run compaction in the compaction's
 * turn; v2 assistant messages carry no parent id, so the position is what
 * anchors them.
 */
const turnIdForMessageIndex = (model: TurnWindowModel, index: number): string | null => {
    let turnId: string | null = null;
    for (let position = 0; position < model.turnMessageStartIndexes.length; position += 1) {
        if (model.turnMessageStartIndexes[position] > index) break;
        turnId = model.turnIds[position] ?? turnId;
    }
    return turnId;
};

/**
 * The answered entries a turn's question parts carry. Cached by the parts
 * sequence, so a rebuild over unchanged messages hands the caller the same
 * array and a memoized consumer can keep its previous map.
 */
const turnQuestionEntriesCache = new WeakMap<Part, { parts: readonly Part[]; entries: QuestionAnswerEntry[] }>();

const entriesForQuestionParts = (parts: readonly Part[]): QuestionAnswerEntry[] => {
    const first = parts[0];
    if (!first) return [];
    const cached = turnQuestionEntriesCache.get(first);
    if (cached && cached.parts.length === parts.length && cached.parts.every((part, index) => part === parts[index])) {
        return cached.entries;
    }
    const entries: QuestionAnswerEntry[] = [];
    for (const part of parts) {
        entries.push(...questionEntriesForPart(part, part.messageID).filter((entry) => entry.answer !== null));
    }
    turnQuestionEntriesCache.set(first, { parts: [...parts], entries });
    return entries;
};

/**
 * Answered questions keyed by the turn they were asked in, for the prompt
 * selector and the timeline. The turn comes from the same fold/turn model the
 * transcript uses (`buildTurnWindowModel`), so a question keeps its row when
 * its prompt has no readable text, and a question asked after a mid-run
 * compaction belongs to the turn the compaction opened.
 */
export const buildQuestionEntriesByTurnId = (
    messages: readonly ChatMessageEntry[],
): Map<string, QuestionAnswerEntry[]> => {
    const model = buildTurnWindowModel([...messages]);
    const partsByTurn = new Map<string, Part[]>();
    messages.forEach((message, index) => {
        if (message.info.role !== 'assistant') return;
        const turnId = turnIdForMessageIndex(model, index);
        if (!turnId) return;
        for (const part of message.parts) {
            if (part.type !== 'tool' || !isQuestionTool(part.tool)) continue;
            const parts = partsByTurn.get(turnId) ?? [];
            parts.push(part);
            partsByTurn.set(turnId, parts);
        }
    });
    const byTurn = new Map<string, QuestionAnswerEntry[]>();
    for (const [turnId, parts] of partsByTurn) {
        const entries = entriesForQuestionParts(parts);
        if (entries.length > 0) byTurn.set(turnId, entries);
    }
    return byTurn;
};

/**
 * Whether the prompt selector lists a turn: its prompt has readable text, or
 * it asked a question. The selector's membership and its current-prompt marker
 * both read this, so a turn admitted only for its question is never skipped.
 */
export const isPromptSelectorTurn = (
    turnId: string,
    previewsByTurnId: ReadonlyMap<string, readonly unknown[]>,
    questionsByTurnId: ReadonlyMap<string, readonly unknown[]>,
): boolean =>
    previewsByTurnId.has(turnId) || (questionsByTurnId.get(turnId)?.length ?? 0) > 0;

/**
 * The sentence that asks: models often lead with background, so the last
 * sentence ending in "?" is the question; without one, the whole text.
 */
export const questionSentence = (question: string): string => {
    const text = question.replace(/\s+/g, ' ').trim();
    // A sentence ends at . ? or ! plus any closing bracket or quote.
    const sentences = text.split(/(?<=[.?!][)\]"'”’]*)\s+/);
    for (let index = sentences.length - 1; index >= 0; index -= 1) {
        if (sentences[index].endsWith('?')) return sentences[index];
    }
    return text;
};
