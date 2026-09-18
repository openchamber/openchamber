import { describe, expect, test } from 'bun:test';
import type { AssistantMessage, Part, ToolPart, UserMessage } from '@opencode-ai/sdk/v2';
import { projectTurnChangedFiles } from './projectTurnSummary';
import { projectTurnRecords } from './projectTurnRecords';
import type { ChatMessageEntry } from './types';

const diff = '@@ -1,1 +1,2 @@\n-before\n+after\n+added';

function user(diffs?: NonNullable<UserMessage['summary']>['diffs']): ChatMessageEntry {
    const info: UserMessage = {
        id: 'user', sessionID: 'session', role: 'user', time: { created: 1 }, agent: 'build',
        model: { providerID: 'provider', modelID: 'model' },
    };
    if (diffs) info.summary = { diffs };
    return {
        info,
        parts: [{ type: 'text', id: 'request', messageID: 'user', sessionID: 'session', text: 'Request' }],
    };
}

function assistant(id: string, parts: Part[], finish?: AssistantMessage['finish']): ChatMessageEntry {
    return {
        info: {
            id, sessionID: 'session', role: 'assistant', parentID: 'user', finish,
            time: { created: 2, completed: finish ? 3 : undefined }, modelID: 'model', providerID: 'provider', mode: 'build', agent: 'build',
            path: { cwd: '/project', root: '/project' }, cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
        parts,
    };
}

function edit(id: string, filePath: string, patch = diff): ToolPart {
    return {
        id, callID: id, type: 'tool', tool: 'edit', messageID: 'assistant', sessionID: 'session',
        state: { status: 'completed', input: { filePath }, metadata: { diff: patch }, output: '', title: 'edit', time: { start: 1, end: 2 } },
    };
}

function task(id: string, sessionId: string): ToolPart {
    return {
        id, callID: id, type: 'tool', tool: 'task', messageID: 'assistant', sessionID: 'session',
        state: { status: 'completed', input: {}, metadata: { sessionId }, output: '', title: 'task', time: { start: 1, end: 2 } },
    };
}

describe('projectTurnChangedFiles', () => {
    test('lists only files the turn edited, even when the snapshot diff has more', () => {
        // Another session (or the user) changed extra.ts in the same
        // directory while this turn ran; the snapshot cannot tell them apart.
        const files = projectTurnChangedFiles(
            [assistant('a', [edit('one', '/project/src/a.ts'), edit('two', '/project/src/b.ts')], 'stop')],
            user([
                { file: 'src/extra.ts', additions: 9, deletions: 9 },
                { file: 'src/b.ts', additions: 5, deletions: 4 },
            ]),
        );
        expect(files).toEqual([
            { file: 'src/a.ts', additions: 2, deletions: 1, inTurnDiff: false },
            { file: 'src/b.ts', additions: 5, deletions: 4, inTurnDiff: true },
        ]);
    });

    test('keeps a file the tool touched even when its counts are unknown', () => {
        const write: ToolPart = {
            id: 'write', callID: 'write', type: 'tool', tool: 'write', messageID: 'assistant', sessionID: 'session',
            state: { status: 'completed', input: { filePath: '/project/src/c.ts', content: 'x' }, metadata: {}, output: '', title: 'write', time: { start: 1, end: 2 } },
        };
        expect(projectTurnChangedFiles([assistant('a', [write], 'stop')], user())).toEqual([{ file: 'src/c.ts', inTurnDiff: false }]);
    });

    test('a snapshot entry without line changes shows the name alone', () => {
        expect(projectTurnChangedFiles(
            [assistant('a', [edit('one', '/project/logo.png')], 'stop')],
            user([{ file: 'logo.png', additions: 0, deletions: 0 }]),
        )).toEqual([{ file: 'logo.png', inTurnDiff: true }]);
    });

    test('appends snapshot files the turn delegated to subagents, after its own', () => {
        // The child session's edits are invisible here; the snapshot is their only record.
        const snapshot = [
            { file: 'src/delegated.ts', additions: 3, deletions: 0 },
            { file: 'src/a.ts', additions: 2, deletions: 1 },
            { file: 'binary.png', additions: 0, deletions: 0 },
        ];
        expect(projectTurnChangedFiles(
            [assistant('a', [task('child', 'child-session'), edit('one', '/project/src/a.ts')], 'stop')],
            user(snapshot),
        )).toEqual([
            { file: 'src/a.ts', additions: 2, deletions: 1, inTurnDiff: true },
            { file: 'src/delegated.ts', additions: 3, deletions: 0, inTurnDiff: true },
        ]);
        expect(projectTurnChangedFiles([assistant('a', [task('child', 'child-session')], 'stop')], user(snapshot)))
            .toEqual([{ file: 'src/delegated.ts', additions: 3, deletions: 0, inTurnDiff: true }, { file: 'src/a.ts', additions: 2, deletions: 1, inTurnDiff: true }]);
        // Without a subagent the same snapshot entry stays out.
        expect(projectTurnChangedFiles([assistant('a', [edit('one', '/project/src/a.ts')], 'stop')], user(snapshot)))
            .toEqual([{ file: 'src/a.ts', additions: 2, deletions: 1, inTurnDiff: true }]);
    });

    test('a snapshot diff without any tool edit yields no files', () => {
        expect(projectTurnChangedFiles(
            [assistant('a', [], 'stop')],
            user([{ file: 'src/extra.ts', additions: 1, deletions: 0 }]),
        )).toBeUndefined();
    });
});

describe('projectTurnRecords changed files', () => {
    const options = { showTextJustificationActivity: false, showTurnChangedFiles: true };

    test('projects files once the turn has a final answer and not before', () => {
        const parts = [edit('one', '/project/src/a.ts')];
        const streaming = projectTurnRecords([user(), assistant('a', parts)], options);
        expect(streaming.turns[0]?.changedFiles).toBeUndefined();

        const finished = projectTurnRecords([user(), assistant('a', parts, 'stop')], options);
        expect(finished.turns[0]?.changedFiles).toEqual([{ file: 'src/a.ts', additions: 2, deletions: 1, inTurnDiff: false }]);
    });

    test('leaves files out while the setting is off', () => {
        const projection = projectTurnRecords(
            [user(), assistant('a', [edit('one', '/project/src/a.ts')], 'stop')],
            { ...options, showTurnChangedFiles: false },
        );
        expect(projection.turns[0]?.changedFiles).toBeUndefined();
    });
});
