import { describe, expect, test } from 'bun:test';
import type { AssistantMessage, Part, ToolPart, ToolStateCompleted } from '@opencode-ai/sdk/v2';
import { getLiveFinalMessage, getTurnsWithLaterAssistant, hasLiveActivity } from './liveActivity';
import { projectTurnRecords } from './projectTurnRecords';
import { summarizeLiveActivity } from './liveActivitySummary';
import type { ChatMessageEntry } from './types';

function assistant(id: string, parts: Part[], options: Partial<AssistantMessage> = {}): ChatMessageEntry {
    return {
        info: {
            id, sessionID: 'session', role: 'assistant', parentID: 'user',
            time: { created: 2 }, modelID: 'model', providerID: 'provider', mode: 'build', agent: 'build',
            path: { cwd: '/project', root: '/project' }, cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            ...options,
        },
        parts,
    };
}

function user(id = 'user', hidden = false): ChatMessageEntry {
    return {
        info: { id, sessionID: 'session', role: 'user', time: { created: 1 }, agent: 'build', model: { providerID: 'provider', modelID: 'model' } },
        parts: hidden ? [] : [text(`Request ${id}`)],
    };
}

function text(content: string): Part {
    return { type: 'text', id: content, messageID: 'message', sessionID: 'session', text: content };
}

function tool(id: string, name: string, options: {
    status?: 'completed' | 'error' | 'running';
    input?: ToolStateCompleted['input'];
    metadata?: ToolStateCompleted['metadata'];
    error?: string;
} = {}): ToolPart {
    const common = { input: options.input ?? {}, metadata: options.metadata ?? {}, time: { start: 1, end: 2 } };
    const state: ToolPart['state'] = options.status === 'error'
        ? { ...common, status: 'error', error: options.error ?? 'failed' }
        : options.status === 'running'
            ? { ...common, status: 'running' }
            : { ...common, status: 'completed', output: '', title: name };
    return {
        id, callID: id, type: 'tool', tool: name, messageID: 'message', sessionID: 'session',
        state,
    };
}

const diff = '@@ -1,1 +1,2 @@\n-before\n+after\n+added';

describe('live turn boundaries', () => {
    test('a queued user message does not collapse the previous turn', () => {
        const turns = projectTurnRecords([user(), assistant('a', [tool('read', 'read')]), user('next')]).turns;
        expect(getTurnsWithLaterAssistant(turns).size).toBe(0);
    });

    test('an assistant with the next visible parent retires the previous turn', () => {
        const turns = projectTurnRecords([
            user(), assistant('a', [text('Checking'), tool('read', 'read')]), user('next'),
            assistant('b', [tool('bash', 'bash')], { parentID: 'next' }),
        ]).turns;
        expect([...getTurnsWithLaterAssistant(turns)]).toEqual(['user']);
        expect(getLiveFinalMessage(turns[0].assistantMessages)).toBeUndefined();
    });

    test('hidden user continuations keep their visible turn open', () => {
        const turns = projectTurnRecords([
            user(), assistant('a', [tool('read', 'read')]), user('hidden', true),
            assistant('b', [tool('bash', 'bash')], { parentID: 'hidden' }),
        ], { mergeHiddenUserTurns: { planModeEnabled: false } }).turns;
        expect(turns).toHaveLength(1);
        expect(getTurnsWithLaterAssistant(turns).size).toBe(0);
    });

    test('only stop text is a final answer, not a tool step, compaction or earlier stop', () => {
        const final = assistant('final', [text('Done')], { finish: 'stop' });
        expect(getLiveFinalMessage([final])).toBe(final);
        expect(getLiveFinalMessage([assistant('progress', [text('Checking')], { finish: 'tool-calls' })])).toBeUndefined();
        expect(getLiveFinalMessage([assistant('compact', [text('Summary')], { finish: 'stop', summary: true })])).toBeUndefined();
        expect(getLiveFinalMessage([final, assistant('continued', [tool('read', 'read')])])).toBeUndefined();
        expect(getLiveFinalMessage([assistant('question', [text('Which?'), tool('question', 'question', { status: 'running' })])])).toBeUndefined();
    });

    test('activity eligibility follows visible sorted activity rather than any assistant prose', () => {
        const reasoning: Part = { type: 'reasoning', id: 'thinking', messageID: 'a', sessionID: 'session', text: 'Thinking', time: { start: 1, end: 2 } };
        const turn = projectTurnRecords([user(), assistant('a', [reasoning, text('Done')], { finish: 'stop' })]).turns[0];
        expect(hasLiveActivity(turn, false)).toBe(false);
        expect(hasLiveActivity(turn, true)).toBe(true);
        expect(hasLiveActivity(projectTurnRecords([user(), assistant('a', [text('Hello')], { finish: 'stop' })]).turns[0], true)).toBe(false);
    });
});

describe('live activity report', () => {
    test('groups exploration and web calls without pretending their counts are file counts', () => {
        const result = summarizeLiveActivity([assistant('a', [
            ...['read', 'list', 'glob', 'grep', 'lsp', 'skill', 'webfetch', 'websearch', 'codesearch', 'perplexity'].map((name) => tool(name, name)),
            tool('bash1', 'bash', { input: { command: 'first && second' } }),
            tool('bash2', 'bash'),
            tool('task1', 'task', { metadata: { sessionId: 'child' } }),
            tool('task2', 'task', { metadata: { sessionId: 'child' } }),
            tool('task3', 'task', { metadata: { sessionId: 'other-child' } }),
        ])]);
        expect(result).toMatchObject({ explored: true, researched: true, commands: 2, subagents: 2, files: 0 });
    });

    test('does not invent meanings for managed tools, MCP names or unknown aliases', () => {
        const result = summarizeLiveActivity([assistant('a', [
            ...['question', 'todowrite', 'plan_exit', 'StructuredOutput', 'openchamber', 'openchamber_web', 'openchamber_memory', 'linear_save_issue', 'mcp.edit'].map((name) => tool(name, name)),
        ])]);
        expect(result).toMatchObject({ explored: false, researched: false, commands: 0, subagents: 0, files: 0 });
    });

    test('counts each command call once, including a confirmed nonzero exit but not a permission refusal', () => {
        const command = tool('bash', 'bash');
        const result = summarizeLiveActivity([assistant('a', [
            command, command,
            tool('failed', 'bash', { status: 'error', error: 'exit 1', metadata: { exit: 1 } }),
            tool('denied', 'bash', { status: 'error', error: 'Permission denied' }),
            tool('running', 'bash', { status: 'running' }),
        ])]);
        expect(result.commands).toBe(2);
    });

    test('sums actual call diffs while deduplicating paths and duplicate call records', () => {
        const first = tool('edit1', 'edit', { input: { filePath: './src/a.ts' }, metadata: { diff } });
        const result = summarizeLiveActivity([assistant('a', [
            first, first,
            tool('edit2', 'edit', { input: { filePath: '/project/src/a.ts' }, metadata: { diff: '@@ -1,1 +1,0 @@\n-after' } }),
        ])]);
        expect(result).toMatchObject({ files: 1, additions: 2, deletions: 2, hasCompleteDiff: true });
    });

    test('takes all patch files and never double-counts their top-level diff', () => {
        const result = summarizeLiveActivity([assistant('a', [tool('patch', 'apply_patch', { metadata: {
            diff,
            files: [
                { filePath: '/project/a', patch: diff, type: 'update' },
                { filePath: '/project/b', diff: '@@ -1,1 +1,0 @@\n-deleted', type: 'delete' },
                { filePath: '/project/c', additions: 3, deletions: 0, type: 'add' },
            ],
        } })])]);
        expect(result).toMatchObject({ files: 3, additions: 5, deletions: 2, hasCompleteDiff: true });
    });

    test('a rename preserves the identity of a file already edited in the turn', () => {
        const result = summarizeLiveActivity([assistant('a', [
            tool('edit', 'edit', { input: { filePath: 'old.ts' }, metadata: { diff } }),
            tool('move', 'apply_patch', { metadata: { files: [{ filePath: '/project/old.ts', movePath: '/project/new.ts', additions: 0, deletions: 0 }] } }),
            tool('edit-again', 'edit', { input: { filePath: 'new.ts' }, metadata: { diff } }),
        ])]);
        expect(result).toMatchObject({ files: 1, additions: 4, deletions: 2 });
        expect(result.changedFiles).toEqual([{ path: 'new.ts', additions: 4, deletions: 2 }]);
    });

    test('uses the whole-call diff when per-file stats are missing, without adding partial numbers', () => {
        const result = summarizeLiveActivity([assistant('a', [tool('patch', 'apply_patch', { metadata: {
            diff: `${diff}\n@@ -1,1 +1,0 @@\n-deleted`,
            files: [{ filePath: '/project/a', patch: diff }, { filePath: '/project/b' }],
        } })])]);
        expect(result).toMatchObject({ files: 2, additions: 2, deletions: 2, hasCompleteDiff: true });
        // The call's patch cannot be split between two files, so only the
        // file with its own patch keeps numbers.
        expect(result.changedFiles).toEqual([{ path: 'a', additions: 2, deletions: 1 }, { path: 'b' }]);
    });

    test('write content is not a diff and partial stats are not shown as a complete total', () => {
        const result = summarizeLiveActivity([assistant('a', [
            tool('edit', 'edit', { input: { filePath: 'a' }, metadata: { diff } }),
            tool('write', 'write', { input: { filePath: 'b', content: 'one\ntwo\nthree' } }),
        ])]);
        expect(result).toMatchObject({ files: 2, hasCompleteDiff: false });
        expect(result.changedFiles).toEqual([{ path: 'a', additions: 2, deletions: 1 }, { path: 'b' }]);
    });

    test('lists touched files relative to the project root in first-touch order', () => {
        const result = summarizeLiveActivity([assistant('a', [
            tool('write', 'write', { input: { filePath: '/project/src/new.ts' }, metadata: { diff } }),
            tool('edit', 'edit', { input: { filePath: './src/a.ts' }, metadata: { filediff: { file: '/project/src/a.ts', additions: 1, deletions: 0 } } }),
            tool('again', 'edit', { input: { filePath: '/project/src/new.ts' }, metadata: { diff: '@@ -1,1 +1,0 @@\n-after' } }),
            tool('relative', 'edit', { input: { filePath: 'lib/x.ts' }, metadata: { diff } }),
            tool('outside', 'edit', { input: { filePath: '/elsewhere/b.ts' }, metadata: { diff } }),
        ], { path: { cwd: '/project/packages', root: '/project' } })]);
        expect(result.changedFiles).toEqual([
            { path: 'src/new.ts', additions: 2, deletions: 2 },
            { path: 'src/a.ts', additions: 1, deletions: 0 },
            { path: 'packages/lib/x.ts', additions: 2, deletions: 1 },
            { path: '/elsewhere/b.ts', additions: 2, deletions: 1 },
        ]);
    });

    test('a Windows tool path joins the forward-slash path git prints for the same file', () => {
        const result = summarizeLiveActivity([assistant('windows', [
            tool('one', 'edit', { input: { filePath: 'C:\\Project\\src\\A.ts' }, metadata: { diff } }),
            tool('two', 'edit', { input: { filePath: 'c:/project/src/a.ts' }, metadata: { diff } }),
        ], { path: { cwd: 'C:\\Project', root: 'C:\\Project' } })]);
        expect(result.changedFiles).toEqual([{ path: 'src/A.ts', additions: 4, deletions: 2 }]);
    });

    test('rejects truncated diff counts and counts source lines resembling diff headers', () => {
        expect(summarizeLiveActivity([assistant('a', [tool('edit', 'edit', { input: { filePath: 'a' }, metadata: { diff: '@@ -1,1 +1,2 @@\n-old\n+incomplete' } })])]).hasCompleteDiff).toBe(false);
        expect(summarizeLiveActivity([assistant('a', [tool('edit', 'edit', { input: { filePath: 'a' }, metadata: { diff: '@@ -1,1 +1,1 @@\n---source\n+++source' } })])])).toMatchObject({ additions: 1, deletions: 1 });
    });

    test('failed edits and malformed metadata cannot erase another valid change', () => {
        const result = summarizeLiveActivity([assistant('a', [
            tool('bad', 'edit', { status: 'error', error: 'failed', input: { filePath: 'bad' }, metadata: { diff } }),
            tool('good', 'edit', { input: { filePath: 'good' }, metadata: { diff, files: 'invalid' } }),
        ])]);
        expect(result).toMatchObject({ files: 1, additions: 2, deletions: 1, hasCompleteDiff: true });
    });

    test('normalizes absolute dot segments and Windows path spelling', () => {
        expect(summarizeLiveActivity([assistant('unix', [
            tool('one', 'edit', { input: { filePath: '/project/src/../a' }, metadata: { diff } }),
            tool('two', 'edit', { input: { filePath: 'a' }, metadata: { diff } }),
        ])]).files).toBe(1);
        expect(summarizeLiveActivity([assistant('windows', [
            tool('one', 'edit', { input: { filePath: 'C:\\Project\\A.ts' }, metadata: { diff } }),
            tool('two', 'edit', { input: { filePath: 'c:/project/./a.ts' }, metadata: { diff } }),
        ], { path: { cwd: 'C:/Project', root: 'C:/Project' } })]).files).toBe(1);
    });

    test('a confirmed no-op is not a changed file, but creating an empty file is', () => {
        expect(summarizeLiveActivity([assistant('a', [tool('patch', 'apply_patch', { metadata: { files: [
            { filePath: '/project/noop', additions: 0, deletions: 0, type: 'update' },
            { filePath: '/project/empty', additions: 0, deletions: 0, type: 'add' },
        ] } })])])).toMatchObject({ files: 1, additions: 0, deletions: 0, hasCompleteDiff: true });
    });
});
