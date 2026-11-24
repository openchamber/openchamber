import { describe, expect, test } from 'bun:test';

import type { ChatMessageEntry } from './turns/types';
import type { Part, ToolInput, ToolPart } from '@/lib/opencode/model';
import {
    buildQuestionEntriesByTurnId,
    isAnsweredQuestionPart,
    isPromptSelectorTurn,
    parseQuestionAnswers,
    questionCardState,
    questionEntriesForPart,
    readQuestionInput,
    selectedOptionLabels,
} from './questionEntries';

const questionPart = (input: ToolInput, output?: string, id = 'call_1'): ToolPart => ({
    id,
    sessionID: 'ses_1',
    messageID: 'msg_assistant',
    type: 'tool',
    callID: id,
    tool: 'question',
    state: output === undefined
        ? { status: 'running', input, time: { start: 1 } }
        : { status: 'completed', input, output, metadata: {}, time: { start: 1, end: 2 } },
});

const userMessage = (id: string, text: string): ChatMessageEntry => ({
    info: { id, sessionID: 'ses_1', role: 'user', time: { created: 1 } },
    parts: [{ id: `${id}:text:0`, sessionID: 'ses_1', messageID: id, type: 'text', text }],
});

const assistantMessage = (id: string, parts: Part[]): ChatMessageEntry => ({
    info: {
        id,
        sessionID: 'ses_1',
        role: 'assistant',
        time: { created: 1 },
        agent: 'build',
        providerID: 'test',
        modelID: 'test',
    },
    parts,
});

const compactionMessage = (id: string): ChatMessageEntry => ({
    info: {
        id,
        sessionID: 'ses_1',
        role: 'compaction',
        time: { created: 2 },
        status: 'completed',
        reason: 'auto',
        summary: 'Earlier context was compacted.',
    },
    parts: [],
});

const answered = (pairs: Array<[string, string]>): string =>
    `User has answered your questions: ${pairs.map(([q, a]) => `"${q}"="${a}"`).join(', ')}. You can now continue with the user's answers in mind.`;

describe('readQuestionInput', () => {
    test('reads questions, headers, options and multi-select', () => {
        expect(readQuestionInput({
            questions: [
                {
                    header: 'Ship it',
                    question: 'Ship it?',
                    options: [{ label: 'Yes', description: 'Merge now' }, { label: 'No' }],
                    multiple: true,
                },
                { question: 'Why?', options: [] },
            ],
        })).toEqual([
            {
                header: 'Ship it',
                question: 'Ship it?',
                options: [{ label: 'Yes', description: 'Merge now' }, { label: 'No' }],
                multiple: true,
            },
            { header: undefined, question: 'Why?', options: [], multiple: false },
        ]);
    });

    test('skips malformed entries and an input without questions', () => {
        expect(readQuestionInput({ questions: [{ question: '   ' }, { options: [{ label: 'x' }] }, 'nope'] })).toEqual([]);
        expect(readQuestionInput({})).toEqual([]);
        expect(readQuestionInput(undefined)).toEqual([]);
    });
});

describe('parseQuestionAnswers', () => {
    test('reads each question and answer pair, escapes included', () => {
        expect(parseQuestionAnswers(answered(
            [['Ship it?', 'Yes'], ['Why \\"now\\"?', 'Because \\"it\\" is ready']],
        ))).toEqual([
            { question: 'Ship it?', answer: 'Yes' },
            { question: 'Why "now"?', answer: 'Because "it" is ready' },
        ]);
    });

    test('returns null when the reply is not an answer', () => {
        expect(parseQuestionAnswers('User dismissed your questions.')).toBeNull();
        expect(parseQuestionAnswers('')).toBeNull();
    });
});

describe('questionEntriesForPart', () => {
    test('matches answers to the questions that were asked', () => {
        const input = { questions: [{ header: 'Ship it', question: 'Ship it?', options: [{ label: 'Yes' }, { label: 'No' }] }] };
        const entries = questionEntriesForPart(questionPart(input, answered([['Ship it?', 'Yes']])), 'msg_assistant');
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({
            messageId: 'msg_assistant',
            header: 'Ship it',
            question: 'Ship it?',
            options: [{ label: 'Yes' }, { label: 'No' }],
            multiple: false,
            answer: 'Yes',
        });
    });

    test('gives each of two identically worded questions its own answer', () => {
        const input = {
            questions: [
                { question: 'Which branch?', options: [{ label: 'main' }, { label: 'dev' }] },
                { question: 'Which branch?', options: [{ label: 'main' }, { label: 'dev' }] },
            ],
        };
        const entries = questionEntriesForPart(
            questionPart(input, answered([['Which branch?', 'main'], ['Which branch?', 'dev']])),
            'msg_assistant',
        );
        expect(entries.map((entry) => entry.answer)).toEqual(['main', 'dev']);
    });

    test('leaves an unanswered question open and marks it pending while the call runs', () => {
        const input = { questions: [{ question: 'Ship it?', options: [{ label: 'Yes' }] }] };
        const [entry] = questionEntriesForPart(questionPart(input), 'msg_assistant');
        expect(entry.answer).toBeNull();
        expect(entry.pending).toBe(true);
        const [answeredEntry] = questionEntriesForPart(questionPart(input, answered([['Ship it?', 'Yes']])), 'msg_assistant');
        expect(answeredEntry.pending).toBe(false);
    });

    test('reads a reply whose input is gone', () => {
        const [entry] = questionEntriesForPart(
            questionPart({}, answered([['Ship it?', 'Yes']])),
            'msg_assistant',
        );
        expect(entry).toMatchObject({ question: 'Ship it?', answer: 'Yes', options: [] });
    });

    test('ignores other tools and unfinished calls', () => {
        const shellPart: Part = { ...questionPart({}), tool: 'shell' };
        expect(questionEntriesForPart(shellPart, 'msg_assistant')).toEqual([]);
        expect(isAnsweredQuestionPart(questionPart({ questions: [{ question: 'Q' }] }))).toBe(false);
        expect(isAnsweredQuestionPart(questionPart({ questions: [{ question: 'Q' }] }, answered([['Q', 'A']])))).toBe(true);
    });
});

describe('questionCardState', () => {
    const input = { questions: [{ question: 'Ship it?', options: [{ label: 'Yes' }] }] };
    const failedPart = (state: { error: string; errorType?: string; errorSource?: 'local' }): ToolPart => ({
        ...questionPart(input, 'unused'),
        state: { status: 'error', input, time: { start: 1, end: 2 }, ...state },
    });

    test('reads a waiting, answered and settled call', () => {
        expect(questionCardState(questionPart(input))).toBe('waiting');
        expect(questionCardState(questionPart(input, answered([['Ship it?', 'Yes']])))).toBe('answered');
        expect(questionCardState(questionPart(input, 'User dismissed your questions.'))).toBe('dismissed');
    });

    test('a failed call is a dismissal only when the classifier says so, not by its words', () => {
        // OpenCode reports a cancellation as an error type, whatever its text:
        // the reply can still name a dismissal while the reader aborted.
        expect(questionCardState(failedPart({ error: 'The question was cancelled', errorType: 'QuestionRejectedError' }))).toBe('dismissed');
        expect(questionCardState(failedPart({ error: 'The user dismissed this question', errorType: 'aborted' }))).toBe('stopped');
    });

    test('a call that died with the turn was not answered by the reader', () => {
        expect(questionCardState(failedPart({ error: 'Tool execution interrupted' }))).toBe('stopped');
        expect(questionCardState(failedPart({ error: 'Interrupted', errorSource: 'local' }))).toBe('stopped');
        expect(questionCardState(failedPart({ error: 'connection reset' }))).toBe('stopped');
    });
});

describe('isPromptSelectorTurn', () => {
    const previews = new Map<string, readonly unknown[]>([['msg_text', [{}]]]);
    const questions = new Map<string, readonly unknown[]>([['msg_question', [{}]]]);

    test('a turn is listed for its prompt text or for the question it asked', () => {
        expect(isPromptSelectorTurn('msg_text', previews, questions)).toBe(true);
        expect(isPromptSelectorTurn('msg_question', previews, questions)).toBe(true);
        expect(isPromptSelectorTurn('msg_other', previews, questions)).toBe(false);
    });
});

describe('selectedOptionLabels', () => {
    const options = [{ label: 'Yes' }, { label: 'No' }, { label: 'Later' }];

    test('matches a single answer and a joined multi-select answer whole', () => {
        expect([...selectedOptionLabels(options, 'Yes', false)]).toEqual(['Yes']);
        expect([...selectedOptionLabels(options, 'Yes, Later', true)]).toEqual(['Yes', 'Later']);
    });

    test('matches the option the question tool marked as recommended', () => {
        expect([...selectedOptionLabels(options, 'Yes (Recommended)', false)]).toEqual(['Yes']);
        expect([...selectedOptionLabels(options, 'Yes, Later (Recommended)', true)]).toEqual(['Yes', 'Later']);
    });

    test('marks a recommended pick in the middle of a multi-select reply', () => {
        expect([...selectedOptionLabels(options, 'Later (Recommended), Yes', true)]).toEqual(['Yes', 'Later']);
    });

    test('keeps a label that itself ends with the recommendation marker', () => {
        expect([...selectedOptionLabels([{ label: 'Yes (Recommended)' }], 'Yes (Recommended)', false)]).toEqual(['Yes (Recommended)']);
    });

    test('does not split a label that contains a comma when the answer is that label', () => {
        expect([...selectedOptionLabels([{ label: 'Yes, please' }, { label: 'No' }], 'Yes, please', true)]).toEqual(['Yes, please']);
    });

    test('parses a joined multi-select reply whose labels contain commas', () => {
        expect([...selectedOptionLabels([{ label: 'Yes, please' }, { label: 'No' }], 'Yes, please, No', true)])
            .toEqual(['Yes, please', 'No']);
    });

    test('a single-select answer names an option only when it is that label', () => {
        expect([...selectedOptionLabels(options, 'Yes, but later', false)]).toEqual([]);
    });

    test('matches nothing for a free-form answer', () => {
        expect([...selectedOptionLabels(options, 'Something else', false)]).toEqual([]);
        expect([...selectedOptionLabels(options, 'Something else', true)]).toEqual([]);
        expect([...selectedOptionLabels(options, null, false)]).toEqual([]);
    });
});

describe('question builders', () => {
    const turnPart = questionPart(
        { questions: [{ question: 'Ship it?', options: [{ label: 'Yes' }, { label: 'No' }] }] },
        answered([['Ship it?', 'Yes']]),
    );
    const openPart = questionPart(
        { questions: [{ question: 'Why?', options: [{ label: 'Because' }] }] },
        undefined,
        'call_2',
    );
    const messages: ChatMessageEntry[] = [
        userMessage('msg_user', 'Deploy the release'),
        assistantMessage('msg_assistant', [turnPart, openPart]),
    ];

    test('answered questions attach to the turn that asked them', () => {
        const byTurn = buildQuestionEntriesByTurnId(messages);
        expect([...byTurn.keys()]).toEqual(['msg_user']);
        expect(byTurn.get('msg_user')?.map((entry) => entry.answer)).toEqual(['Yes']);
        expect(byTurn.get('msg_user')?.[0]).toMatchObject({ question: 'Ship it?', answer: 'Yes' });
    });

    test('an unanswered question stays out of the selector and the timeline', () => {
        const byTurn = buildQuestionEntriesByTurnId(messages);
        expect(byTurn.get('msg_user')?.some((entry) => entry.question === 'Why?')).toBe(false);
    });

    test('a question keeps its turn when the prompt has no readable text', () => {
        const byTurn = buildQuestionEntriesByTurnId([
            userMessage('msg_empty', ''),
            assistantMessage('msg_assistant', [turnPart]),
        ]);
        expect(byTurn.get('msg_empty')?.map((entry) => entry.question)).toEqual(['Ship it?']);
    });

    test('a question asked after a mid-run compaction anchors to the compaction turn', () => {
        const byTurn = buildQuestionEntriesByTurnId([
            userMessage('msg_user', 'Deploy the release'),
            compactionMessage('msg_compact'),
            assistantMessage('msg_assistant', [turnPart]),
        ]);
        expect([...byTurn.keys()]).toEqual(['msg_compact']);
        expect(byTurn.get('msg_compact')?.[0]).toMatchObject({ question: 'Ship it?', answer: 'Yes' });
    });

    test('rebuilding unchanged messages keeps the same entry array', () => {
        const first = buildQuestionEntriesByTurnId(messages);
        const second = buildQuestionEntriesByTurnId(messages);
        expect(second.get('msg_user')).toBe(first.get('msg_user'));
    });
});
