import { describe, expect, test } from 'bun:test';
import type { AssistantMessage, Part, TextPart, ToolPart } from '@/lib/opencode/model';
import { answerChunkCuts } from './answerChunks';
import { projectTurnRecords } from './projectTurnRecords';
import { buildTimelineRows, type TimelineRowsOptions } from './timelineRows';
import type { TimelineEntry } from './timelineEntries';
import type { ChatMessageEntry } from './types';

const paragraph = (index: number) => `Paragraph ${index} explains one more step of the call sequence in plain words, long enough to wrap.\n\n`;
const longAnswer = Array.from({ length: 60 }, (_, index) => paragraph(index)).join('');

const textPart = (id: string, text: string, ended = true): Part => {
    const part: TextPart = { type: 'text', id, text, sessionID: 'session', messageID: 'message' };
    if (ended) part.time = { start: 1, end: 2 };
    return part;
};
const readPart: ToolPart = {
    type: 'tool', tool: 'read', id: 'read', callID: 'read', sessionID: 'session', messageID: 'step',
    state: { status: 'completed', input: { filePath: '/project/a.ts' }, output: 'code', metadata: {}, time: { start: 1, end: 2 } },
};

const assistant = (id: string, parts: Part[], finish?: AssistantMessage['finish']): ChatMessageEntry => {
    const info: AssistantMessage = {
        id, sessionID: 'session', role: 'assistant', time: { created: 2, completed: finish ? 3 : undefined },
        modelID: 'model', providerID: 'provider', agent: 'build',
        cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, finish,
    };
    return { info, parts };
};

const turnEntry = (messages: ChatMessageEntry[]): TimelineEntry => {
    const turn = projectTurnRecords([
        { info: { id: 'user', sessionID: 'session', role: 'user', time: { created: 1 } }, parts: [textPart('prompt', 'Explain')] },
        ...messages,
    ]).turns[0]!;
    return { kind: 'turn', key: `turn:${turn.turnId}`, turn, isLastTurn: true };
};

const summary: TimelineRowsOptions = { collapsedActivity: false, keepActivityText: false, expandedTurns: new Map(), showReasoningTraces: true , questionsInChat: false};
const collapsed: TimelineRowsOptions = { collapsedActivity: true, keepActivityText: false, expandedTurns: new Map(), showReasoningTraces: true , questionsInChat: false};

describe('answerChunkCuts', () => {
    test('leaves a short text whole', () => {
        expect(answerChunkCuts(paragraph(1).repeat(10))).toEqual([]);
    });

    test('cuts a long text only where a paragraph starts, into pieces that join back', () => {
        const cuts = answerChunkCuts(longAnswer);
        expect(cuts.length).toBeGreaterThan(1);
        for (const cut of cuts) expect(longAnswer.slice(cut).startsWith('Paragraph ')).toBe(true);
        const pieces = [0, ...cuts].map((start, index) => longAnswer.slice(start, cuts[index]));
        expect(pieces.join('')).toBe(longAnswer);
    });

    test('never starts a piece at a list, a code block or a table', () => {
        const text = Array.from({ length: 40 }, (_, index) => `${paragraph(index)}- item ${index}\n- next\n\n\`\`\`ts\nconst a = ${index};\n\`\`\`\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n`).join('');
        const cuts = answerChunkCuts(text);
        expect(cuts.length).toBeGreaterThan(0);
        for (const cut of cuts) expect(text.slice(cut).startsWith('Paragraph ')).toBe(true);
    });

    test('leaves a text with footnotes or link definitions whole', () => {
        expect(answerChunkCuts(`${longAnswer}[^1]: The note.\n`)).toEqual([]);
        expect(answerChunkCuts(`${longAnswer}[docs]: https://example.com\n`)).toEqual([]);
    });

    test('never cuts inside a display equation that spans a blank line', () => {
        const text = `${'Lorem ipsum dolor sit amet. '.repeat(75)}\n\n\\[\nx\n\ny\n\\]\n\n${'Tail words here. '.repeat(75)}`;
        const cuts = answerChunkCuts(text);
        expect(cuts.length).toBeGreaterThan(0);
        for (const cut of cuts) expect(text.slice(cut).startsWith('Tail ')).toBe(true);
    });
});

describe('buildTimelineRows', () => {
    test('draws a turn as its prompt row and a row per step', () => {
        const rows = buildTimelineRows([turnEntry([
            assistant('step', [readPart, textPart('note', 'Reading')], 'tool-calls'),
            assistant('answer', [textPart('final', 'Done')], 'stop'),
        ])], summary, []);
        expect(rows.map((row) => row.key)).toEqual(['turn:user', 'step:step', 'step:answer']);
        expect(rows.map((row) => row.kind !== 'ungrouped' && row.gapBelow)).toEqual([false, false, true]);
    });

    test('cuts a finished long answer into rows that name their slice', () => {
        const rows = buildTimelineRows([turnEntry([assistant('answer', [textPart('final', longAnswer)], 'stop')])], summary, []);
        const cuts = answerChunkCuts(longAnswer);
        expect(rows.map((row) => row.key)).toEqual([
            'turn:user', 'step:answer', ...cuts.map((cut) => `step:answer:final:${cut}`),
        ]);
        const slices = rows.flatMap((row) => (row.kind === 'turn-message' ? [row.slice] : []));
        expect(slices[0]).toEqual({ to: { partId: 'final', offset: cuts[0] }, index: 0, count: cuts.length + 1 });
        expect(slices.at(-1)).toEqual({ from: { partId: 'final', offset: cuts.at(-1)! }, index: cuts.length, count: cuts.length + 1 });
    });

    test('cuts a step that ran dozens of calls into rows of parts, while it still runs', () => {
        const calls: Part[] = Array.from({ length: 30 }, (_, index) => ({ ...readPart, id: `read-${index}`, callID: `read-${index}` }));
        const rows = buildTimelineRows([turnEntry([assistant('step', calls)])], summary, []);
        expect(rows.map((row) => row.key)).toEqual(['turn:user', 'step:step', 'step:step:read-24:0']);
        expect(rows[1]?.kind === 'turn-message' && rows[1].slice).toEqual({ to: { partId: 'read-24', offset: 0 }, index: 0, count: 2 });
    });

    test('keeps an answer still being written in one row', () => {
        const rows = buildTimelineRows([turnEntry([assistant('answer', [textPart('final', longAnswer, false)])])], summary, []);
        expect(rows.map((row) => row.key)).toEqual(['turn:user', 'step:answer']);
    });

    test('under a closed fold, the steps are the fold row and the answer follows it', () => {
        const entry = turnEntry([
            assistant('step', [readPart], 'tool-calls'),
            assistant('answer', [textPart('final', 'Done')], 'stop'),
        ]);
        const rows = buildTimelineRows([entry], collapsed, []);
        expect(rows.map((row) => row.key)).toEqual(['turn:user', 'fold:user', 'step:answer']);
        expect(rows.every((row) => row.kind === 'ungrouped' || row.underFold)).toBe(true);
        // The fold leaves out the answer these rows name, not one it finds on its own.
        expect(rows.every((row) => row.kind === 'ungrouped' || row.finalMessageId === 'answer')).toBe(true);
        expect(rows.at(-1)?.kind === 'turn-message' && rows.at(-1)).toMatchObject({ final: true });

        const opened = buildTimelineRows([entry], { ...collapsed, expandedTurns: new Map([['user', true]]) }, []);
        expect(opened.map((row) => row.key)).toEqual(['turn:user', 'fold:user', 'step:step', 'step:answer']);
    });

    test('Show notes marks a closed fold\'s rows and leaves an opened fold as the steps ran', () => {
        const entry = turnEntry([
            assistant('step', [textPart('note', 'Reading first'), readPart], 'tool-calls'),
            assistant('answer', [textPart('final', 'Done')], 'stop'),
        ]);
        const withText = { ...collapsed, keepActivityText: true };
        const closed = buildTimelineRows([entry], withText, []);
        expect(closed.every((row) => row.kind === 'ungrouped' || row.keepText)).toBe(true);
        const opened = buildTimelineRows([entry], { ...withText, expandedTurns: new Map([['user', true]]) }, closed);
        expect(opened.some((row) => row.kind !== 'ungrouped' && row.keepText)).toBe(false);
        expect(opened.map((row) => row.key)).toEqual(['turn:user', 'fold:user', 'step:step', 'step:answer']);
        const expandedOnly = buildTimelineRows([turnEntry([assistant('answer', [textPart('final', 'Done')], 'stop')])], withText, []);
        expect(expandedOnly.some((row) => row.kind !== 'ungrouped' && row.keepText)).toBe(false);
    });

    test('keeps the row objects that did not change', () => {
        const entry = turnEntry([assistant('answer', [textPart('final', 'Done')], 'stop')]);
        const first = buildTimelineRows([entry], summary, []);
        expect(buildTimelineRows([entry], summary, first)).toBe(first);
        const opened = buildTimelineRows([entry], { ...summary, collapsedActivity: true }, first);
        expect(opened[0]).toBe(first[0]);
    });
});

describe('answered questions as rows of their own', () => {
    const question = (id: string, answer: string | null): ToolPart => ({
        type: 'tool', tool: 'question', id, callID: id, sessionID: 'session', messageID: 'step',
        state: answer === null
            ? { status: 'running', input: { questions: [{ question: 'Ship it?', header: 'Ship', options: [{ label: 'Yes' }, { label: 'No' }] }] }, time: { start: 1 } }
            : {
                status: 'completed',
                input: { questions: [{ question: 'Ship it?', header: 'Ship', options: [{ label: 'Yes' }, { label: 'No' }] }] },
                output: `User has answered your questions: "Ship it?"="${answer}". You can now continue with the user's answers in mind.`,
                metadata: {}, time: { start: 1, end: 2 },
            },
    });
    const messageRows = (rows: ReturnType<typeof buildTimelineRows>) => rows.filter((row) => row.kind === 'turn-message');

    test('an answered question is cut out between the parts around it', () => {
        const rows = buildTimelineRows([turnEntry([
            assistant('step', [textPart('before', 'Looking first.'), question('ask', 'Yes'), readPart], 'stop'),
        ])], summary, []);
        const steps = messageRows(rows);
        expect(steps).toHaveLength(3);
        expect(steps.map((row) => row.kind === 'turn-message' && row.questionPartId)).toEqual([undefined, 'ask', undefined]);
    });

    test('a message that is only an answered question is one question row', () => {
        const rows = buildTimelineRows([turnEntry([assistant('step', [question('ask', 'No')], 'stop')])], summary, []);
        const steps = messageRows(rows);
        expect(steps).toHaveLength(1);
        expect(steps[0]!.kind === 'turn-message' && steps[0]!.questionPartId).toBe('ask');
    });

    test('a question still waiting is a card row of its own that does not stick', () => {
        const pending = [textPart('before', 'Looking first.'), question('ask', null)];
        const steps = messageRows(buildTimelineRows([turnEntry([assistant('step', pending)])], summary, []));
        expect(steps).toHaveLength(2);
        const card = steps[1]!;
        expect(card.kind === 'turn-message' && [card.questionPartId, card.questionSticks]).toEqual(['ask', false]);
    });

    test('with the question in the chat, a waiting one is no row at all and its call draws nothing', () => {
        const pending = [textPart('before', 'Looking first.'), question('ask', null), readPart];
        const inChat: TimelineRowsOptions = { ...summary, questionsInChat: true };
        const steps = messageRows(buildTimelineRows([turnEntry([assistant('step', pending)])], inChat, []));
        // The message keeps one row of its own, so it keeps its anchor and the
        // row is not an empty card.
        expect(steps).toHaveLength(1);
        expect(steps[0]!.kind === 'turn-message' && steps[0]!.questionPartId).toBeUndefined();
        // Answered ones are untouched by the setting.
        const answered = messageRows(buildTimelineRows([turnEntry([assistant('step', [question('ask', 'Yes')])])], inChat, []));
        expect(answered[0]!.kind === 'turn-message' && answered[0]!.questionPartId).toBe('ask');
    });
});

describe('sticky rows', () => {
    const answered: ToolPart = {
        type: 'tool', tool: 'question', id: 'ask', callID: 'ask', sessionID: 'session', messageID: 'step',
        state: {
            status: 'completed',
            input: { questions: [{ question: 'Ship it?', header: 'Ship', options: [{ label: 'Yes' }, { label: 'No' }] }] },
            output: 'User has answered your questions: "Ship it?"="Yes". You can now continue with the user\'s answers in mind.',
            metadata: {}, time: { start: 1, end: 2 },
        },
    };

    test('the prompt and an answered question stick; the question ends the prompt\'s span', async () => {
        const { endsStickySpan, stickyRowIndicesOf } = await import('./stickyPrompt');
        const rows = buildTimelineRows([turnEntry([
            assistant('step', [textPart('before', 'Looking first.'), answered, readPart], 'stop'),
        ])], summary, []);
        const indices = stickyRowIndicesOf(rows)!;
        expect(indices.map((index) => rows[index]!.kind === 'turn-message' ? 'question' : rows[index]!.kind)).toEqual(['turn-head', 'question']);
        expect(rows.filter(endsStickySpan)).toHaveLength(2);
    });

    test('an unanswered question gets a card but neither sticks nor ends the prompt\'s span', async () => {
        const { endsStickySpan, stickyRowIndicesOf } = await import('./stickyPrompt');
        const dismissed: ToolPart = {
            ...answered,
            state: {
                status: 'error', input: answered.state.input, error: 'The user dismissed this question', errorType: 'QuestionRejectedError',
                time: { start: 1, end: 2 },
            } as ToolPart['state'],
        };
        const rows = buildTimelineRows([turnEntry([
            assistant('step', [textPart('before', 'Looking first.'), dismissed, readPart], 'stop'),
        ])], summary, []);
        expect(rows.some((row) => row.kind === 'turn-message' && row.questionPartId === 'ask')).toBe(true);
        expect(stickyRowIndicesOf(rows)!.map((index) => rows[index]!.kind)).toEqual(['turn-head']);
        expect(rows.filter(endsStickySpan)).toHaveLength(1);
    });
});

describe('answered questions under a closed fold', () => {
    const answeredIn = (messageID: string): ToolPart => ({
        type: 'tool', tool: 'question', id: 'ask', callID: 'ask', sessionID: 'session', messageID,
        state: {
            status: 'completed',
            input: { questions: [{ question: 'Ship it?', header: 'Ship', options: [{ label: 'Yes' }, { label: 'No' }] }] },
            output: 'User has answered your questions: "Ship it?"="Yes". You can now continue with the user\'s answers in mind.',
            metadata: {}, time: { start: 1, end: 2 },
        },
    });

    test('a finished turn lifts the answered card out of the closed fold, without the message anchor', () => {
        const rows = buildTimelineRows([turnEntry([
            assistant('step', [answeredIn('step'), readPart], 'tool-calls'),
            assistant('answer', [textPart('final', 'Done.')], 'stop'),
        ])], collapsed, []);
        const lifted = rows.filter((row) => row.key.startsWith('lifted-question:'));
        expect(lifted).toHaveLength(1);
        expect(rows.findIndex((row) => row.kind === 'turn-fold')).toBeLessThan(rows.indexOf(lifted[0]!));
        const card = lifted[0]!;
        expect(card.kind === 'turn-message' && card.questionSticks).toBe(true);
    });

    test('an opened fold draws the card among its steps instead, once', () => {
        const entry = turnEntry([
            assistant('step', [answeredIn('step'), readPart], 'tool-calls'),
            assistant('answer', [textPart('final', 'Done.')], 'stop'),
        ]);
        const turnId = entry.kind === 'turn' ? entry.turn.turnId : '';
        const rows = buildTimelineRows([entry], { ...collapsed, expandedTurns: new Map([[turnId, true]]) }, []);
        const cards = rows.filter((row) => row.kind === 'turn-message' && row.questionPartId === 'ask');
        expect(cards).toHaveLength(1);
        expect(cards[0]!.key.startsWith('lifted-question:')).toBe(false);
    });

    test('a turn still working lifts nothing', () => {
        const rows = buildTimelineRows([turnEntry([assistant('step', [answeredIn('step'), readPart])])], collapsed, []);
        expect(rows.some((row) => row.key.startsWith('lifted-question:'))).toBe(false);
    });
});
