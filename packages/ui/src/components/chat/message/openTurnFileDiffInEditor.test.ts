import { describe, expect, test } from 'bun:test';

import type { EditorAPI } from '@/lib/api/types';

import { openTurnFileDiffInEditor } from './openTurnFileDiffInEditor';

const patch = [
    'Index: src/notes.txt',
    '===================================================================',
    '--- src/notes.txt',
    '+++ src/notes.txt',
    '@@ -1,2 +1,2 @@',
    '-alpha',
    '+alpha changed',
    ' line 1',
    '@@ -41,2 +41,2 @@',
    ' line 40',
    '-omega',
    '+omega changed',
].join('\n');

const recordingEditor = () => {
    const calls: unknown[][] = [];
    const editor: EditorAPI = {
        openDiff: async (...args) => { calls.push(['openDiff', ...args]); },
        openFile: async (...args) => { calls.push(['openFile', ...args]); },
    };
    return { calls, editor };
};

describe('openTurnFileDiffInEditor', () => {
    test('opens the whole turn change of the file in the editor diff', async () => {
        const { calls, editor } = recordingEditor();
        await openTurnFileDiffInEditor({
            directory: '/workspace/project',
            editor,
            file: '/workspace/project/src/notes.txt',
            turnDiff: [{ file: 'src/other.txt', patch: 'other' }, { file: 'src/notes.txt', patch }],
        });
        expect(calls).toEqual([['openDiff', '', '/workspace/project/src/notes.txt', undefined, { line: 1, patch }]]);
    });

    test('finds a relative chip path in the turn diff', async () => {
        const { calls, editor } = recordingEditor();
        await openTurnFileDiffInEditor({
            directory: '/workspace/project',
            editor,
            file: 'src/notes.txt',
            turnDiff: [{ file: 'src/notes.txt', patch }],
        });
        expect(calls).toEqual([['openDiff', '', '/workspace/project/src/notes.txt', undefined, { line: 1, patch }]]);
    });

    test('opens a file the turn diff does not list as it is', async () => {
        const { calls, editor } = recordingEditor();
        await openTurnFileDiffInEditor({
            directory: '/workspace/project',
            editor,
            file: 'src/ignored.log',
            turnDiff: [{ patch: 'entry without a file' }, { file: 'src/notes.txt', patch }],
        });
        expect(calls).toEqual([['openFile', '/workspace/project/src/ignored.log']]);
    });
});
