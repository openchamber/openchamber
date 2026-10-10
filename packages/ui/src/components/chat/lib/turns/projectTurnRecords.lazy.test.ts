import { describe, expect, test } from 'bun:test';
import type { AssistantMessage, Part, ToolPart, UserMessage } from '@/lib/opencode/model';
import { projectTurnRecords } from './projectTurnRecords';
import type { ChatMessageEntry } from './types';

// Counts reads of each part's `type`, the first field the summary, activity
// and changed-files projections inspect.
const countPartReads = (part: Part, counter: { reads: number }): Part => {
    const counted = { ...part };
    Object.defineProperty(counted, 'type', {
        enumerable: true,
        get: () => {
            counter.reads += 1;
            return part.type;
        },
    });
    return counted;
};

const userEntry = (id: string, created: number): ChatMessageEntry => {
    const info: UserMessage = { id, sessionID: 's', role: 'user', time: { created } };
    return { info, parts: [{ id: `${id}_text`, sessionID: 's', messageID: id, type: 'text', text: 'Fix it' }] };
};

const assistantEntry = (id: string, created: number, counter: { reads: number }): ChatMessageEntry => {
    const info: AssistantMessage = {
        id,
        sessionID: 's',
        role: 'assistant',
        time: { created, completed: created + 1 },
        agent: 'build',
        providerID: 'p',
        modelID: 'm',
        finish: 'stop',
    };
    const tool: ToolPart = {
        id: `${id}_tool`,
        sessionID: 's',
        messageID: id,
        type: 'tool',
        callID: `${id}_call`,
        tool: 'edit',
        state: {
            status: 'completed',
            input: { filePath: `/repo/${id}.ts` },
            output: 'ok',
            metadata: {},
            time: { start: created, end: created + 1 },
        },
    };
    const parts: Part[] = [
        { id: `${id}_reasoning`, sessionID: 's', messageID: id, type: 'reasoning', text: 'thinking', time: { start: created, end: created } },
        tool,
        { id: `${id}_text`, sessionID: 's', messageID: id, type: 'text', text: 'Done.' },
    ];
    return { info, parts: parts.map((part) => countPartReads(part, counter)) };
};

const buildSession = (turnCount: number, counter: { reads: number }): ChatMessageEntry[] => (
    Array.from({ length: turnCount }, (_, index) => [
        userEntry(`u${index}`, index * 10),
        assistantEntry(`a${index}`, index * 10 + 1, counter),
    ]).flat()
);

describe('projectTurnRecords lazy derived fields', () => {
    test('opening a 100-turn session reads no assistant parts until a turn is rendered', () => {
        const counter = { reads: 0 };
        const messages = buildSession(100, counter);

        const projection = projectTurnRecords(messages, { showTurnChangedFiles: true, mergeHiddenUserTurns: true });

        expect(projection.turns).toHaveLength(100);
        // Hydrating summary, activity and changed files for every turn up
        // front read each assistant part several times (recorded: 2700 reads
        // for 300 parts). Only rendered turns pay for them now.
        expect(counter.reads).toBe(0);

        const rendered = projection.turns.slice(-3);
        for (const turn of rendered) {
            void turn.activitySegments;
            void turn.changedFiles;
            void turn.summaryText;
        }
        const readsForThreeTurns = counter.reads;
        expect(readsForThreeTurns).toBeGreaterThan(0);

        // Reading again is free: each turn derives its fields once.
        for (const turn of rendered) {
            void turn.activityParts;
            void turn.hasTools;
            void turn.diffStats;
        }
        expect(counter.reads).toBe(readsForThreeTurns);
    });

    test('derives the same fields lazily as an eager read would', () => {
        const counter = { reads: 0 };
        const [turn] = projectTurnRecords(buildSession(1, counter), { showTurnChangedFiles: true }).turns;

        expect(turn?.summaryText).toBe('Done.');
        expect(turn?.hasTools).toBe(true);
        expect(turn?.hasReasoning).toBe(true);
        expect(turn?.changedFiles?.map((file) => file.file)).toEqual(['/repo/a0.ts']);
        expect(turn?.diffStats?.files).toBe(1);
        expect(turn?.activityParts.map((activity) => activity.kind)).toEqual(['reasoning', 'tool']);
    });

    test('hides changed files but keeps diff stats when the setting is off', () => {
        const counter = { reads: 0 };
        const [turn] = projectTurnRecords(buildSession(1, counter), { showTurnChangedFiles: false }).turns;

        expect(turn?.changedFiles).toBeUndefined();
        expect(turn?.diffStats?.files).toBe(1);
    });

    test('a spread copy carries the derived values', () => {
        const counter = { reads: 0 };
        const [turn] = projectTurnRecords(buildSession(1, counter), { showTurnChangedFiles: true }).turns;
        if (!turn) throw new Error('expected a turn');

        const copy = { ...turn, assistantMessages: [] };

        expect(copy.summaryText).toBe('Done.');
        expect(copy.activityParts).toBe(turn.activityParts);
    });
});
