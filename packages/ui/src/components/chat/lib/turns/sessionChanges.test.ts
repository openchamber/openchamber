import { describe, expect, test } from 'bun:test';
import type { AssistantMessage, Part, Session, ToolPart, ToolStateCompleted } from '@/lib/opencode/model';
import { collectDescendantSessionIds, collectSessionFileChanges, sessionChangePatch } from './sessionChanges';
import type { ChatMessageEntry } from './types';

function assistant(id: string, parts: Part[], options: Partial<AssistantMessage> = {}): ChatMessageEntry {
    return {
        info: {
            id, sessionID: 'session', role: 'assistant',
            time: { created: 2 }, modelID: 'model', providerID: 'provider', agent: 'build',
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            ...options,
        },
        parts,
    };
}

function tool(id: string, name: string, options: {
    status?: 'completed' | 'error' | 'running';
    input?: ToolStateCompleted['input'];
    metadata?: ToolStateCompleted['metadata'];
} = {}): ToolPart {
    const common = { input: options.input ?? {}, metadata: options.metadata ?? {}, time: { start: 1, end: 2 } };
    const state: ToolPart['state'] = options.status === 'error'
        ? { ...common, status: 'error', error: 'failed' }
        : options.status === 'running'
            ? { ...common, status: 'running' }
            : { ...common, status: 'completed', output: '' };
    return {
        id, callID: id, type: 'tool', tool: name, messageID: 'message', sessionID: 'session',
        state,
    };
}

const diff = '@@ -1,1 +1,2 @@\n-before\n+after\n+added';
const secondDiff = '@@ -3,1 +3,1 @@\n-old\n+new';

describe('session file changes', () => {
    test('lists an edit with its path relative to the session directory', () => {
        const changes = collectSessionFileChanges([
            assistant('a', [tool('edit', 'edit', {
                input: { path: '/project/src/a.ts' },
                metadata: { files: [{ file: '/project/src/a.ts', patch: diff, status: 'modified' }] },
            })]),
        ], '/project');

        expect(changes).toHaveLength(1);
        expect(changes[0]).toMatchObject({ path: 'src/a.ts', status: 'modified', additions: 2, deletions: 1 });
        expect(changes[0]?.patches).toEqual([diff]);
    });

    test('merges every edit to one file, counting duplicate records once', () => {
        const repeated = tool('e2', 'edit', { input: { path: 'src/a.ts' }, metadata: { files: [{ file: 'src/a.ts', patch: secondDiff }] } });
        const changes = collectSessionFileChanges([
            assistant('a', [tool('e1', 'edit', { input: { path: '/project/src/a.ts' }, metadata: { files: [{ file: '/project/src/a.ts', patch: diff }] } })]),
            assistant('b', [repeated, repeated]),
        ], '/project');

        expect(changes).toHaveLength(1);
        expect(changes[0]).toMatchObject({ path: 'src/a.ts', additions: 3, deletions: 2 });
        expect(changes[0]?.patches).toHaveLength(2);
    });

    test('keeps a whole-file write with the contents it wrote', () => {
        const changes = collectSessionFileChanges([
            assistant('a', [tool('w', 'write', { input: { path: '/project/src/new.ts', content: 'hello\nworld' } })]),
        ], '/project');

        expect(changes).toHaveLength(1);
        expect(changes[0]).toMatchObject({ path: 'src/new.ts', writtenContent: 'hello\nworld' });
        expect(changes[0]?.patches).toEqual([]);
    });

    test('follows a rename to its new path', () => {
        const changes = collectSessionFileChanges([
            assistant('a', [tool('m', 'patch', {
                metadata: { files: [{ file: '/project/old.ts', movePath: '/project/new.ts', additions: 0, deletions: 0 }] },
            })]),
        ], '/project');

        expect(changes).toHaveLength(1);
        expect(changes[0]).toMatchObject({ path: 'new.ts', status: 'renamed' });
    });

    test('ignores running and unrelated tool calls', () => {
        const changes = collectSessionFileChanges([
            assistant('a', [
                tool('running', 'edit', { status: 'running', input: { path: '/project/a.ts' } }),
                tool('read', 'read', { input: { path: '/project/a.ts' } }),
            ]),
        ], '/project');

        expect(changes).toEqual([]);
    });

    test('merges a parent and its subagent child into one review', () => {
        const parent = assistant('p', [tool('spawn', 'subagent', { metadata: { sessionID: 'child' } })]);
        const child = assistant('c', [tool('edit', 'edit', {
            input: { path: '/project/src/a.ts' },
            metadata: { files: [{ file: '/project/src/a.ts', patch: diff }] },
        })]);
        const changes = collectSessionFileChanges([parent, child], '/project');

        expect(changes).toHaveLength(1);
        expect(changes[0]).toMatchObject({ path: 'src/a.ts', additions: 2, deletions: 1 });
        expect(changes[0]?.patches).toEqual([diff]);
    });
});

const session = (id: string, parentID?: string): Session => ({ id, parentID } as Session);

describe('descendant sessions', () => {
    test('walks children and grandchildren breadth-first', () => {
        const sessions = [
            session('root'),
            session('child-a', 'root'),
            session('child-b', 'root'),
            session('grandchild', 'child-a'),
        ];
        expect(collectDescendantSessionIds(sessions, 'root')).toEqual(['child-a', 'child-b', 'grandchild']);
    });

    test('ignores unrelated sessions and cannot loop on a cycle', () => {
        const sessions = [
            session('other'),
            session('root'),
            session('child', 'root'),
            session('root', 'child'),
        ];
        expect(collectDescendantSessionIds(sessions, 'root')).toEqual(['child']);
    });
});

describe('session change patch', () => {
    test('returns a lone patch untouched', () => {
        const change = { path: 'a.ts', status: 'modified' as const, additions: 2, deletions: 1, patches: [diff] };
        expect(sessionChangePatch(change)).toBe(diff);
    });

    test('concatenates hunks from several edits under one header', () => {
        const first = `--- a.ts\n+++ a.ts\n${diff}`;
        const second = `--- a.ts\n+++ a.ts\n${secondDiff}`;
        const change = { path: 'a.ts', status: 'modified' as const, additions: 0, deletions: 0, patches: [first, second] };

        const combined = sessionChangePatch(change);
        expect(combined).toContain('@@ -1,1 +1,2 @@');
        expect(combined).toContain('@@ -3,1 +3,1 @@');
        expect(combined?.startsWith('--- a.ts\n+++ a.ts\n')).toBe(true);
    });

    test('has no patch for a file that was only written', () => {
        const change = { path: 'a.ts', status: 'modified' as const, additions: 0, deletions: 0, patches: [] };
        expect(sessionChangePatch(change)).toBeUndefined();
    });
});
