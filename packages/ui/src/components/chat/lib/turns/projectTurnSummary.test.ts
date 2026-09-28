import { describe, expect, test } from 'bun:test';
import type { AssistantMessage, Part, ToolPart } from '@/lib/opencode/model';
import { projectTurnChangedFiles } from './projectTurnSummary';
import { projectTurnRecords } from './projectTurnRecords';
import type { ChatMessageEntry } from './types';

const diff = '@@ -1,1 +1,2 @@\n-before\n+after\n+added';

function user(): ChatMessageEntry {
    return {
        info: { id: 'user', sessionID: 'session', role: 'user', time: { created: 1 } },
        parts: [{ type: 'text', id: 'request', messageID: 'user', sessionID: 'session', text: 'Request' }],
    };
}

function assistant(id: string, parts: Part[], finish?: AssistantMessage['finish']): ChatMessageEntry {
    return {
        info: {
            id, sessionID: 'session', role: 'assistant', finish,
            time: { created: 2, completed: finish ? 3 : undefined },
            modelID: 'model', providerID: 'provider', agent: 'build', cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
        parts,
    };
}

function edit(id: string, filePath: string, patch = diff): ToolPart {
    return {
        id, callID: id, type: 'tool', tool: 'edit', messageID: 'assistant', sessionID: 'session',
        state: { status: 'completed', input: { filePath }, metadata: { diff: patch }, output: '', time: { start: 1, end: 2 } },
    };
}

describe('projectTurnChangedFiles', () => {
    test('lists the files the turn edited, with the counts from each call patch', () => {
        expect(projectTurnChangedFiles([
            assistant('a', [edit('one', '/project/src/a.ts'), edit('two', '/project/src/b.ts')], 'stop'),
        ])).toEqual([
            { file: '/project/src/a.ts', additions: 2, deletions: 1, inTurnDiff: true },
            { file: '/project/src/b.ts', additions: 2, deletions: 1, inTurnDiff: true },
        ]);
    });

    test('keeps a file the tool touched even when its counts are unknown', () => {
        const write: ToolPart = {
            id: 'write', callID: 'write', type: 'tool', tool: 'write', messageID: 'assistant', sessionID: 'session',
            state: { status: 'completed', input: { filePath: '/project/src/c.ts', content: 'x' }, metadata: {}, output: '', time: { start: 1, end: 2 } },
        };
        expect(projectTurnChangedFiles([assistant('a', [write], 'stop')]))
            .toEqual([{ file: '/project/src/c.ts', inTurnDiff: true }]);
    });

    test('a turn that edited nothing yields no files', () => {
        expect(projectTurnChangedFiles([assistant('a', [], 'stop')])).toBeUndefined();
    });

    test('v2 has no working-tree snapshot, so a subagent turn lists nothing of its own', () => {
        const task: ToolPart = {
            id: 'child', callID: 'child', type: 'tool', tool: 'task', messageID: 'assistant', sessionID: 'session',
            state: { status: 'completed', input: {}, metadata: { sessionId: 'child-session' }, output: '', time: { start: 1, end: 2 } },
        };
        expect(projectTurnChangedFiles([assistant('a', [task], 'stop')])).toBeUndefined();
    });
});

describe('projectTurnRecords changed files', () => {
    const options = { showTextJustificationActivity: false, showTurnChangedFiles: true };

    test('projects files once the turn has a final answer and not before', () => {
        const parts = [edit('one', '/project/src/a.ts')];
        const streaming = projectTurnRecords([user(), assistant('a', parts)], options);
        expect(streaming.turns[0]?.changedFiles).toBeUndefined();

        const finished = projectTurnRecords([user(), assistant('a', parts, 'stop')], options);
        expect(finished.turns[0]?.changedFiles).toEqual([{ file: '/project/src/a.ts', additions: 2, deletions: 1, inTurnDiff: true }]);
    });

    test('leaves files out while the setting is off', () => {
        const projection = projectTurnRecords(
            [user(), assistant('a', [edit('one', '/project/src/a.ts')], 'stop')],
            { ...options, showTurnChangedFiles: false },
        );
        expect(projection.turns[0]?.changedFiles).toBeUndefined();
    });
});
