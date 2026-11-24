import { expect, test } from 'bun:test';
import type { AssistantMessage, Metadata, Part, ReasoningPart, TextPart, ToolPart } from '@/lib/opencode/model';
import { projectTurnRecords } from './projectTurnRecords';
import { estimateTimelineRowSize, type RowSizeMetrics } from './rowSizeEstimate';
import { buildTimelineRows, type TimelineRow } from './timelineRows';
import { writeQuestionOpen } from '../questionExpandedState';
import type { TimelineEntry } from './timelineEntries';
import type { ChatMessageEntry } from './types';

const metrics: RowSizeMetrics = { columnWidth: 360, lineHeight: 36, showReasoningTraces: true, collapsibleThinkingBlocks: true, autoExpandAnsweredQuestions: false, questionsInChat: false };

const text = (id: string, value: string): TextPart => ({ type: 'text', id, text: value, sessionID: 'session', messageID: 'message', time: { start: 1, end: 2 } });
const reasoning = (id: string, value: string): ReasoningPart => ({ type: 'reasoning', id, text: value, sessionID: 'session', messageID: 'message', time: { start: 1, end: 2 } });
const tool = (id: string, name: string, metadata: Metadata = {}): ToolPart => ({
    type: 'tool', tool: name, id, callID: id, sessionID: 'session', messageID: 'message',
    state: { status: 'completed', input: {}, output: '', metadata, time: { start: 1, end: 2 } },
});

const questionTool = (id: string): ToolPart => ({
    type: 'tool', tool: 'question', id, callID: id, sessionID: 'session', messageID: 'message',
    state: {
        status: 'completed',
        input: { questions: [{ question: 'Ship it?', options: [{ label: 'Yes', description: 'Merge now' }, { label: 'No' }] }] },
        output: 'User has answered your questions: "Ship it?"="Yes". You can now continue with the user\'s answers in mind.',
        metadata: {},
        time: { start: 1, end: 2 },
    },
});

const waitingQuestion = (id: string): ToolPart => ({
    type: 'tool', tool: 'question', id, callID: id, sessionID: 'session', messageID: 'message',
    state: {
        status: 'running',
        input: { questions: [{ question: 'Ship it?', options: [{ label: 'Yes' }, { label: 'No' }] }] },
        time: { start: 1 },
    },
});

const assistant = (id: string, parts: Part[]): ChatMessageEntry => {
    const info: AssistantMessage = {
        id, sessionID: 'session', role: 'assistant', time: { created: 2, completed: 3 },
        modelID: 'model', providerID: 'provider', agent: 'build',
        cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, finish: 'stop',
    };
    return { info, parts };
};

const rowsOf = (messages: ChatMessageEntry[], prompt = 'Explain', questionsInChat = false): TimelineRow[] => {
    const turn = projectTurnRecords([
        { info: { id: 'user', sessionID: 'session', role: 'user', time: { created: 1 } }, parts: prompt ? [text('prompt', prompt)] : [] },
        ...messages,
    ]).turns[0]!;
    const entry: TimelineEntry = { kind: 'turn', key: `turn:${turn.turnId}`, turn, isLastTurn: true };
    return buildTimelineRows([entry], { collapsedActivity: false, keepActivityText: false, expandedTurns: new Map(), showReasoningTraces: true, questionsInChat }, []);
};

const messageRow = (rows: TimelineRow[], messageId: string) => rows.find((row) => row.kind === 'turn-message' && row.messageId === messageId)!;

test('a tool step is one line, and reasoning the model kept to itself adds nothing', () => {
    const rows = rowsOf([
        assistant('step', [reasoning('hidden', ''), tool('shell', 'shell')]),
        assistant('answer', [text('done', 'Done.')]),
    ]);
    expect(estimateTimelineRowSize(messageRow(rows, 'step'), metrics)).toBe(36);
});

test('reasoning shown and each tool add a line', () => {
    const rows = rowsOf([
        assistant('step', [reasoning('thought', 'Looking at the file first.'), tool('read', 'read'), tool('grep', 'grep')]),
        assistant('answer', [text('done', 'Done.')]),
    ]);
    expect(estimateTimelineRowSize(messageRow(rows, 'step'), metrics)).toBe(108);
});

test('a patch across many files grows with the rows of files it lists', () => {
    const files = (count: number) => ({ files: Array.from({ length: count }, (_, index) => ({ filePath: `/f${index}.ts` })) });
    const rows = rowsOf([
        assistant('one', [tool('p1', 'patch', files(1))]),
        assistant('many', [tool('p15', 'patch', files(15))]),
        assistant('answer', [text('done', 'Done.')]),
    ]);
    const one = estimateTimelineRowSize(messageRow(rows, 'one'), metrics)!;
    const many = estimateTimelineRowSize(messageRow(rows, 'many'), metrics)!;
    expect(one).toBeLessThan(60);
    expect(many).toBeGreaterThan(one + 80);
});

test('text grows with its length at the column width', () => {
    const short = estimateTimelineRowSize(messageRow(rowsOf([assistant('a', [tool('t', 'shell')]), assistant('b', [text('x', 'Short.')])]), 'b'), metrics)!;
    const long = estimateTimelineRowSize(messageRow(rowsOf([assistant('a', [tool('t', 'shell')]), assistant('b', [text('x', 'Word '.repeat(400))])]), 'b'), metrics)!;
    // 2000 characters at about 45 a line are some 45 lines of 26 px.
    expect(long - short).toBeGreaterThan(1000);
    expect(long - short).toBeLessThan(1400);
});

test('a prompt with nothing of its own is a thin row', () => {
    const rows = rowsOf([assistant('answer', [text('done', 'Done.')])], '');
    expect(estimateTimelineRowSize(rows[0]!, metrics)).toBe(40);
});

test('nothing is estimated before the column has a width', () => {
    const rows = rowsOf([assistant('answer', [text('done', 'Done.')])]);
    expect(estimateTimelineRowSize(rows[0]!, { ...metrics, columnWidth: 0 })).toBeUndefined();
});

test('reasoning drawn as text when thinking blocks do not fold', () => {
    const rows = rowsOf([
        assistant('step', [reasoning('thought', 'Thinking it through. '.repeat(40)), tool('shell', 'shell')]),
        assistant('answer', [text('done', 'Done.')]),
    ]);
    const folded = estimateTimelineRowSize(messageRow(rows, 'step'), metrics)!;
    const open = estimateTimelineRowSize(messageRow(rows, 'step'), { ...metrics, collapsibleThinkingBlocks: false })!;
    expect(folded).toBe(72);
    expect(open).toBeGreaterThan(400);
});

test('Show notes adds the kept lines to the answer row, or to the fold row of a turn without an answer', () => {
    const line = 'A line the agent wrote between its steps.';
    const build = (messages: ChatMessageEntry[], keepActivityText: boolean): TimelineRow[] => {
        const turn = projectTurnRecords([
            { info: { id: 'user', sessionID: 'session', role: 'user', time: { created: 1 } }, parts: [text('prompt', 'Explain')] },
            ...messages,
        ]).turns[0]!;
        const entry: TimelineEntry = { kind: 'turn', key: `turn:${turn.turnId}`, turn, isLastTurn: true, hasLaterAssistant: true };
        return buildTimelineRows([entry], { collapsedActivity: true, keepActivityText, expandedTurns: new Map(), showReasoningTraces: true, questionsInChat: false }, []);
    };
    const size = (rows: TimelineRow[], kind: TimelineRow['kind']) => estimateTimelineRowSize(rows.find((row) => row.kind === kind)!, metrics) ?? 0;
    const step = { ...assistant('step', [text('note', line), tool('read', 'read')]), info: { ...assistant('step', []).info, finish: 'tool-calls' as const } };
    const answered = [step, assistant('answer', [text('done', 'Done.')])];
    expect(size(build(answered, true), 'turn-message')).toBeGreaterThan(size(build(answered, false), 'turn-message'));
    expect(size(build(answered, true), 'turn-fold')).toBe(size(build(answered, false), 'turn-fold'));
    expect(size(build([step], true), 'turn-fold')).toBeGreaterThan(size(build([step], false), 'turn-fold'));
});

test('a question card is sized from its own shape: the closed summary, then its options once open', () => {
    const card = (rows: TimelineRow[], partId: string) => rows.find((row) => row.kind === 'turn-message' && row.questionPartId === partId)!;
    const rows = rowsOf([assistant('question', [questionTool('q_size')]), assistant('answer', [text('done', 'Done.')])]);
    // Row and card chrome, one question line, the answer: 70 + 18 + 2 + 19.
    const closed = estimateTimelineRowSize(card(rows, 'q_size'), metrics)!;
    expect(closed).toBe(109);
    // The setting only decides the default; it lists the options and their
    // descriptions under the question: a label and gap each, one description.
    const open = estimateTimelineRowSize(card(rows, 'q_size'), { ...metrics, autoExpandAnsweredQuestions: true })!;
    expect(open).toBe(closed + 51);
});

test('with the question in the chat, a waiting call is not sized as a card it does not draw', () => {
    const rows = rowsOf([assistant('question', [waitingQuestion('q_wait')])], 'Explain', true);
    // No card row at all, so the estimate is the message's own row and the gap
    // under the turn instead of an empty card's height.
    const row = messageRow(rows, 'question');
    expect(row.kind === 'turn-message' && row.questionPartId).toBeUndefined();
    expect(estimateTimelineRowSize(row, { ...metrics, questionsInChat: true })).toBe(8);
    const inDock = rowsOf([assistant('question', [waitingQuestion('q_wait')])]).find((candidate) => candidate.kind === 'turn-message' && candidate.questionPartId === 'q_wait')!;
    expect(estimateTimelineRowSize(inDock, metrics)).toBeGreaterThan(100);
});

test('a question card the reader closed stays closed at its closed height while the setting is on', () => {
    writeQuestionOpen('q_closed', false);
    const rows = rowsOf([assistant('question', [questionTool('q_closed')]), assistant('answer', [text('done', 'Done.')])]);
    const row = rows.find((candidate) => candidate.kind === 'turn-message' && candidate.questionPartId === 'q_closed')!;
    expect(estimateTimelineRowSize(row, { ...metrics, autoExpandAnsweredQuestions: true })).toBe(109);
});
