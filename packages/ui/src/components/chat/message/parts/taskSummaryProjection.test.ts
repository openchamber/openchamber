import { describe, expect, test } from 'bun:test';
import type { Part, ToolPart } from '@opencode-ai/sdk/v2';

import { projectTaskSummary, type TaskSummaryEntry } from './taskSummaryProjection';

type ChildMessage = {
    info: { id: string; role: string };
    parts: Part[];
};

const tool = (
    id: string,
    name: string,
    options: { status?: string; input?: Record<string, unknown>; endedAt?: number; error?: string } = {},
): ToolPart => ({
    id,
    type: 'tool',
    tool: name,
    state: {
        status: options.status ?? 'completed',
        input: options.input ?? {},
        error: options.error,
        time: options.endedAt === undefined ? undefined : { end: options.endedAt },
    },
} as ToolPart);

const message = (id: string, parts: Part[], role = 'assistant'): ChildMessage => ({
    info: { id, role },
    parts,
});

const text = (id: string, value: string): Part => ({ id, type: 'text', text: value } as Part);
const reasoning = (id: string): Part => ({ id, type: 'reasoning', text: 'internal' } as Part);

const project = (childSessionMessages: ChildMessage[], fallbackEntries: unknown[] = [], expanded = true) => projectTaskSummary({
    taskPartId: 'parent-task',
    childSessionMessages,
    fallbackEntries,
    expanded,
});

const entry = (id: string, toolName: string, status = 'completed'): TaskSummaryEntry => ({
    id,
    tool: toolName,
    state: { status },
});

describe('projectTaskSummary', () => {
    test('keeps a live singleton canonical read as an ordinary row', () => {
        const result = project([message('m1', [tool('read-1', 'read')])]);

        expect(result.rows).toHaveLength(1);
        expect(result.rows[0]?.type).toBe('task-entry');
        if (result.rows[0]?.type !== 'task-entry') return;
        expect(result.rows[0].key).toBe('task-summary:parent-task:entry:m1:0:read-1');
        expect(result.rows[0].entry.toolName).toBe('read');
        expect(result.rows[0].activityCount).toBe(1);
    });

    test('groups live contiguous canonical actions with namespaced first-child key and source order', () => {
        const result = project([message('m1', [
            tool('read-1', 'read', { input: { filePath: '/repo/a.ts' } }),
            tool('grep-1', 'grep', { input: { pattern: 'needle' } }),
        ])]);

        expect(result.rows).toHaveLength(1);
        expect(result.rows[0]?.type).toBe('context-tool-group');
        if (result.rows[0]?.type !== 'context-tool-group') return;
        expect(result.rows[0].key).toBe('task-summary:parent-task:context-tool-group:m1:0:read-1');
        expect(result.rows[0].counts).toEqual({ read: 1, search: 1, list: 0 });
        expect(result.rows[0].activityCount).toBe(2);
        expect(result.rows[0].children.map((child) => child.id)).toEqual(['m1:0:read-1', 'm1:1:grep-1']);
    });

    test('groups contiguous local searches and context actions without preceding task entries', () => {
        const result = project([message('m1', [
            tool('search-1', 'search', { input: { pattern: 'first' } }),
            tool('search-2', 'search', { input: { query: 'second' } }),
            tool('read-1', 'read', { input: { filePath: '/repo/src/App.tsx' } }),
            tool('grep-1', 'grep', { input: { pattern: 'third', include: '*.tsx', path: 'src' } }),
            tool('glob-1', 'glob', { input: { pattern: '**/*.ts' } }),
        ])]);

        expect(result.rows).toHaveLength(1);
        expect(result.rows[0]?.type).toBe('context-tool-group');
        expect(result.rows.some((row) => row.type === 'task-entry')).toBe(false);
        if (result.rows[0]?.type !== 'context-tool-group') return;
        expect(result.rows[0].counts).toEqual({ read: 1, search: 4, list: 0 });
        expect(result.rows[0].activityCount).toBe(5);
        expect(result.rows[0].children.map((child) => [child.id, child.kind, child.hint])).toEqual([
            ['m1:0:search-1', 'search', 'first'],
            ['m1:1:search-2', 'search', 'second'],
            ['m1:2:read-1', 'read', 'App.tsx'],
            ['m1:3:grep-1', 'search', 'third · *.tsx · src'],
            ['m1:4:glob-1', 'search', '**/*.ts'],
        ]);
    });

    test('keeps context tools grouped across hidden reasoning in consecutive assistant messages', () => {
        const result = project([
            message('m1', [
                tool('search-1', 'search', { input: { pattern: 'first' } }),
                reasoning('reasoning-1'),
                tool('search-2', 'search', { input: { query: 'second' } }),
                reasoning('reasoning-2'),
            ]),
            message('m2', [
                tool('read-1', 'read', { input: { filePath: '/repo/a.ts' } }),
                tool('read-2', 'read', { input: { filePath: '/repo/b.ts' } }),
                tool('grep-1', 'grep', { input: { pattern: 'third' } }),
                tool('glob-1', 'glob', { input: { pattern: '**/*.ts' } }),
            ]),
        ]);

        expect(result.rows).toHaveLength(1);
        expect(result.rows[0]?.type).toBe('context-tool-group');
        if (result.rows[0]?.type !== 'context-tool-group') return;
        expect(result.rows[0].counts).toEqual({ read: 2, search: 4, list: 0 });
        expect(result.rows[0].activityCount).toBe(6);
    });

    test('treats non-empty text as a non-rendered hard separator', () => {
        const result = project([message('m1', [tool('read-1', 'read'), text('text-1', 'explaining'), tool('grep-1', 'grep')])]);

        expect(result.rows.map((row) => row.type)).toEqual(['task-entry', 'task-entry']);
        expect(result.rows.some((row) => row.type === 'context-tool-group')).toBe(false);
    });

    test('treats nested task and todo tools as non-rendered hard separators', () => {
        for (const separator of [tool('task-1', 'task'), tool('todo-1', 'todowrite'), tool('todo-read-1', 'todoread')]) {
            const result = project([message('m1', [tool('read-1', 'read'), separator, tool('grep-1', 'grep')])]);

            expect(result.rows.map((row) => row.type)).toEqual(['task-entry', 'task-entry']);
            expect(result.rows).toHaveLength(2);
        }
    });

    test('keeps shell and mutating actions as independent ordinary rows', () => {
        for (const ordinaryTool of ['bash', 'apply_patch']) {
            const result = project([message('m1', [tool('read-1', 'read'), tool(`${ordinaryTool}-1`, ordinaryTool), tool('grep-1', 'grep')])]);

            expect(result.rows.map((row) => row.type)).toEqual(['task-entry', 'task-entry', 'task-entry']);
            expect(result.rows[1]?.type).toBe('task-entry');
            if (result.rows[1]?.type !== 'task-entry') return;
            expect(result.rows[1].entry.toolName).toBe(ordinaryTool);
        }
    });

    test('groups live canonical actions across assistant messages without an actual separator', () => {
        const result = project([
            message('m1', [tool('read-1', 'read')]),
            message('m2', [tool('grep-1', 'grep')]),
        ]);

        expect(result.rows).toHaveLength(1);
        expect(result.rows[0]?.type).toBe('context-tool-group');
        if (result.rows[0]?.type !== 'context-tool-group') return;
        expect(result.rows[0].activityCount).toBe(2);
    });

    test('treats a user message between canonical actions as a hard separator', () => {
        const result = project([
            message('m1', [tool('read-1', 'read')]),
            message('m2', [text('text-1', 'Please search for it')], 'user'),
            message('m3', [tool('grep-1', 'grep')]),
        ]);

        expect(result.rows.map((row) => row.type)).toEqual(['task-entry', 'task-entry']);
        expect(result.rows.some((row) => row.type === 'context-tool-group')).toBe(false);
    });

    test('keeps metadata fallback context actions independent because separators are unavailable', () => {
        const result = project([], [entry('read-1', 'read'), entry('grep-1', 'grep')]);

        expect(result.rows.map((row) => row.type)).toEqual(['task-entry', 'task-entry']);
    });

    test('prefers renderable live child activity over fallback metadata', () => {
        const result = project(
            [message('m1', [tool('live-read', 'read'), tool('live-grep', 'grep')])],
            [entry('fallback-bash', 'bash')],
        );

        expect(result.rows).toHaveLength(1);
        expect(result.rows[0]?.type).toBe('context-tool-group');
        expect(result.rows[0]?.key).toBe('task-summary:parent-task:context-tool-group:m1:0:live-read');
    });

    test('exposes only child presentation fields from a context group', () => {
        const result = project([message('m1', [tool('read-1', 'read'), tool('grep-1', 'grep')])]);

        expect(result.rows[0]?.type).toBe('context-tool-group');
        if (result.rows[0]?.type !== 'context-tool-group') return;
        expect(result.rows[0].children[0]).toEqual({ id: 'm1:0:read-1', kind: 'read', state: 'done', hint: 'read' });
        expect('activity' in result.rows[0].children[0]).toBe(false);
        expect('turnId' in result.rows[0].children[0]).toBe(false);
    });

    test('normalizes entry title before rendering and signing it', () => {
        const first = project([], [{ id: 'entry-1', tool: 'bash', state: { status: 'completed', title: 'foo' } }]);
        const padded = project([], [{ id: 'entry-1', tool: 'bash', state: { status: 'completed', title: ' foo ' } }]);

        expect(first.rows[0]?.type).toBe('task-entry');
        expect(padded.rows[0]?.type).toBe('task-entry');
        if (first.rows[0]?.type !== 'task-entry' || padded.rows[0]?.type !== 'task-entry') return;
        expect(first.rows[0].entry.label).toBe('foo');
        expect(padded.rows[0].entry.label).toBe('foo');
        expect(first.rows[0].renderSignature).toBe(padded.rows[0].renderSignature);
    });

    test('uses message and part position to disambiguate duplicate live IDs', () => {
        const result = project([
            message('m1', [tool('duplicate', 'bash')]),
            message('m2', [tool('duplicate', 'bash')]),
        ]);

        expect(result.rows.map((row) => row.key)).toEqual([
            'task-summary:parent-task:entry:m1:0:duplicate',
            'task-summary:parent-task:entry:m2:0:duplicate',
        ]);
    });

    test('uses ordered fallback positions to disambiguate duplicate and empty IDs', () => {
        const result = project([], [entry('duplicate', 'bash'), entry('duplicate', 'bash'), entry('', 'bash')]);

        expect(result.rows.map((row) => row.key)).toEqual([
            'task-summary:parent-task:entry:fallback:0:duplicate',
            'task-summary:parent-task:entry:fallback:1:duplicate',
            'task-summary:parent-task:entry:fallback:2',
        ]);
    });

    test('uses unique child and group identities when grouped tools share supplied IDs', () => {
        const first = project([message('m1', [tool('duplicate', 'read'), tool('duplicate', 'grep')])]);
        const appended = project([message('m1', [tool('duplicate', 'read'), tool('duplicate', 'grep'), tool('duplicate', 'glob')])]);

        expect(first.rows[0]?.type).toBe('context-tool-group');
        if (first.rows[0]?.type !== 'context-tool-group') return;
        expect(first.rows[0].key).toBe('task-summary:parent-task:context-tool-group:m1:0:duplicate');
        expect(first.rows[0].children.map((child) => child.id)).toEqual(['m1:0:duplicate', 'm1:1:duplicate']);
        expect(appended.rows[0]?.key).toBe(first.rows[0].key);
    });

    test('normalizes terminal failures and preserves their error text', () => {
        for (const status of ['failed', 'aborted', 'timeout', 'cancelled']) {
            const result = project([message('m1', [tool('bash-1', 'bash', { status, error: `${status} detail` })])]);

            expect(result.rows[0]?.type).toBe('task-entry');
            if (result.rows[0]?.type !== 'task-entry') return;
            expect(result.rows[0].entry.state).toBe('error');
            expect(result.rows[0].entry.label).toBe(`${status} detail`);
        }
    });

    test('changes ordinary row signature when visible failure state or error text changes', () => {
        const first = project([], [{ id: 'one', tool: 'bash', state: { status: 'failed', error: 'first failure' } }]);
        const second = project([], [{ id: 'one', tool: 'bash', state: { status: 'timeout', error: 'second failure' } }]);

        expect(first.rows[0]?.type).toBe('task-entry');
        expect(second.rows[0]?.type).toBe('task-entry');
        if (first.rows[0]?.type !== 'task-entry' || second.rows[0]?.type !== 'task-entry') return;
        expect(first.rows[0].renderSignature).not.toBe(second.rows[0].renderSignature);
    });

    test('normalizes raw metadata fallback errors through the projection interface', () => {
        const result = project([], [{
            id: 'metadata-1',
            tool: 'bash',
            state: { status: 'failed', error: 'failure detail' },
        }]);

        expect(result.rows[0]?.type).toBe('task-entry');
        if (result.rows[0]?.type !== 'task-entry') return;
        expect(result.rows[0].entry).toEqual({ toolName: 'bash', state: 'error', label: 'failure detail' });
        expect(result.rows[0].renderSignature).toContain('failure detail');
    });

    test('normalizes raw metadata strings and top-level object fields', () => {
        const result = project([], [
            'completed summary',
            { id: 'top-level', tool: 'read', status: 'completed', title: 'README.md' },
        ]);

        expect(result.rows.map((row) => row.type)).toEqual(['task-entry', 'task-entry']);
        expect(result.rows[0]?.type === 'task-entry' && result.rows[0].entry).toEqual({
            toolName: 'tool', state: 'done', label: 'completed summary',
        });
        expect(result.rows[1]?.type === 'task-entry' && result.rows[1].entry).toEqual({
            toolName: 'read', state: 'done', label: 'README.md',
        });
    });

    test('groups before applying the six-row preview cutoff', () => {
        const result = project([message('m1', [
            tool('one', 'bash'),
            tool('two', 'bash'),
            tool('three', 'bash'),
            tool('four', 'bash'),
            tool('five', 'bash'), tool('six', 'bash'),
            tool('read-1', 'read'),
            tool('grep-1', 'grep'),
        ])], [], false);

        expect(result.rows).toHaveLength(6);
        expect(result.rows.at(-1)?.type).toBe('context-tool-group');
        expect(result.rows.at(-1)?.activityCount).toBe(2);
        expect(result.hiddenActionCount).toBe(1);
    });

    test('counts original hidden actions represented by projected rows', () => {
        const result = project([message('m1', [
            tool('read-1', 'read'),
            tool('grep-1', 'grep'),
            tool('one', 'bash'),
            tool('two', 'bash'),
            tool('three', 'bash'),
            tool('four', 'bash'),
            tool('five', 'bash'),
            tool('six', 'bash'),
        ])], [], false);

        expect(result.rows).toHaveLength(6);
        expect(result.hiddenActionCount).toBe(2);
    });

    test('returns every projected row with no hidden count when expanded', () => {
        const result = project([message('m1', [
            tool('one', 'bash'), tool('two', 'bash'), tool('three', 'bash'), tool('four', 'bash'), tool('five', 'bash'), tool('six', 'bash'),
            tool('read-1', 'read'), tool('grep-1', 'grep'),
        ])]);

        expect(result.rows).toHaveLength(7);
        expect(result.hiddenActionCount).toBe(0);
    });

    test('keeps the first-child group key when streaming appends another context action', () => {
        const first = project([message('m1', [tool('read-1', 'read'), tool('grep-1', 'grep')])]);
        const appended = project([message('m1', [tool('read-1', 'read'), tool('grep-1', 'grep'), tool('glob-1', 'glob')])]);

        expect(first.rows[0]?.key).toBe('task-summary:parent-task:context-tool-group:m1:0:read-1');
        expect(appended.rows[0]?.key).toBe(first.rows[0]?.key);
    });

    test('inherits source order and active/error group state from existing context projection', () => {
        const result = project([message('m1', [
            tool('read-active', 'read', { status: 'running' }),
            tool('grep-error', 'grep', { status: 'failed' }),
        ])]);

        expect(result.rows[0]?.type).toBe('context-tool-group');
        if (result.rows[0]?.type !== 'context-tool-group') return;
        expect(result.rows[0].status).toBe('error');
        expect(result.rows[0].children.map((child) => child.state)).toEqual(['active', 'error']);
    });
});
