import { describe, expect, test } from 'bun:test';
import type { AssistantMessage, Part, ToolPart, ToolStateCompleted } from '@/lib/opencode/model';
import { getLiveFinalMessage, getTurnsWithLaterAssistant, hasLiveActivity } from './liveActivity';
import { projectTurnRecords } from './projectTurnRecords';
import { summarizeLiveActivity } from './liveActivitySummary';
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

function user(id = 'user', hidden = false): ChatMessageEntry {
    return {
        info: { id, sessionID: 'session', role: 'user', time: { created: 1 } },
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
            : { ...common, status: 'completed', output: '' };
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
            assistant('b', [tool('shell', 'shell')]),
        ]).turns;
        expect([...getTurnsWithLaterAssistant(turns)]).toEqual(['user']);
        expect(getLiveFinalMessage(turns[0].assistantMessages)).toBeUndefined();
    });

    test('hidden user continuations keep their visible turn open', () => {
        const turns = projectTurnRecords([
            user(), assistant('a', [tool('read', 'read')]), user('hidden', true),
            assistant('b', [tool('shell', 'shell')]),
        ], { mergeHiddenUserTurns: true }).turns;
        expect(turns).toHaveLength(1);
        expect(getTurnsWithLaterAssistant(turns).size).toBe(0);
    });

    test('only stop text is a final answer, not a tool step or an earlier stop', () => {
        const final = assistant('final', [text('Done')], { finish: 'stop' });
        expect(getLiveFinalMessage([final])).toBe(final);
        expect(getLiveFinalMessage([assistant('progress', [text('Checking')], { finish: 'tool-calls' })])).toBeUndefined();
        expect(getLiveFinalMessage([final, assistant('continued', [tool('read', 'read')])])).toBeUndefined();
        expect(getLiveFinalMessage([assistant('form', [text('Which?'), tool('form', 'form', { status: 'running' })])])).toBeUndefined();
    });

    test('plumbing messages after the final answer stay transparent', () => {
        const final = assistant('final', [text('Done')], { finish: 'stop' });
        const synthetic: ChatMessageEntry = {
            info: { id: 'synthetic', sessionID: 'session', role: 'synthetic', time: { created: 3 }, text: 'plugin prompt' },
            parts: [],
        };
        expect(getLiveFinalMessage([final, synthetic])).toBe(final);
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
            ...['read', 'glob', 'grep', 'skill', 'webfetch', 'websearch'].map((name) => tool(name, name)),
            tool('shell1', 'shell', { input: { command: 'first && second' } }),
            tool('shell2', 'shell'),
            tool('subagent1', 'subagent', { metadata: { sessionID: 'child' } }),
            tool('subagent2', 'subagent', { metadata: { sessionID: 'child' } }),
            tool('subagent3', 'subagent', { metadata: { sessionID: 'other-child' } }),
        ])]);
        expect(result).toMatchObject({ explored: true, researched: true, commands: 2, subagents: 2, files: 0 });
    });

    test('does not invent meanings for managed tools, MCP names or unknown aliases', () => {
        const result = summarizeLiveActivity([assistant('a', [
            ...['list', 'lsp', 'todowrite', 'plan_exit', 'StructuredOutput', 'openchamber', 'openchamber_web', 'openchamber_memory', 'linear_save_issue', 'mcp.edit'].map((name) => tool(name, name)),
        ])]);
        expect(result).toMatchObject({ explored: false, researched: false, commands: 0, subagents: 0, files: 0 });
    });

    test('counts each command call once, including a confirmed nonzero exit but not a permission refusal', () => {
        const command = tool('shell', 'shell');
        const result = summarizeLiveActivity([assistant('a', [
            command, command,
            tool('failed', 'shell', { status: 'error', error: 'exit 1', metadata: { exit: 1 } }),
            tool('denied', 'shell', { status: 'error', error: 'Permission denied' }),
            tool('running', 'shell', { status: 'running' }),
        ])]);
        expect(result.commands).toBe(2);
    });

    test('sums actual call diffs while deduplicating paths and duplicate call records', () => {
        const first = tool('edit1', 'edit', { input: { path: '/project/src/a.ts' }, metadata: { diff } });
        const result = summarizeLiveActivity([assistant('a', [
            first, first,
            tool('edit2', 'edit', { input: { path: '/project/src/a.ts' }, metadata: { diff: '@@ -1,1 +1,0 @@\n-after' } }),
        ])]);
        expect(result).toMatchObject({ files: 1, additions: 2, deletions: 2, hasCompleteDiff: true });
    });

    test('takes all patch files and never double-counts their top-level diff', () => {
        const result = summarizeLiveActivity([assistant('a', [tool('patch', 'patch', { metadata: {
            diff,
            files: [
                { file: '/project/a', patch: diff, status: 'modified' },
                { file: '/project/b', patch: '@@ -1,1 +1,0 @@\n-deleted', status: 'deleted' },
                { file: '/project/c', additions: 3, deletions: 0, status: 'added' },
            ],
        } })])]);
        expect(result).toMatchObject({ files: 3, additions: 5, deletions: 2, hasCompleteDiff: true });
    });

    test('a rename preserves the identity of a file already edited in the turn', () => {
        const result = summarizeLiveActivity([assistant('a', [
            tool('edit', 'edit', { input: { path: '/project/old.ts' }, metadata: { diff } }),
            tool('move', 'patch', { metadata: { files: [{ file: '/project/old.ts', movePath: '/project/new.ts', additions: 0, deletions: 0 }] } }),
            tool('edit-again', 'edit', { input: { path: '/project/new.ts' }, metadata: { diff } }),
        ])]);
        expect(result).toMatchObject({ files: 1, additions: 4, deletions: 2 });
        expect(result.changedFiles).toEqual([{ path: '/project/new.ts', additions: 4, deletions: 2 }]);
    });

    test('uses the whole-call diff when per-file stats are missing, without adding partial numbers', () => {
        const result = summarizeLiveActivity([assistant('a', [tool('patch', 'patch', { metadata: {
            diff: `${diff}\n@@ -1,1 +1,0 @@\n-deleted`,
            files: [{ file: '/project/a', patch: diff }, { file: '/project/b' }],
        } })])]);
        expect(result).toMatchObject({ files: 2, additions: 2, deletions: 2, hasCompleteDiff: true });
        // The call's patch cannot be split between two files, so only the
        // file with its own patch keeps numbers.
        expect(result.changedFiles).toEqual([{ path: '/project/a', additions: 2, deletions: 1 }, { path: '/project/b' }]);
    });

    test('write content is not a diff and partial stats are not shown as a complete total', () => {
        const result = summarizeLiveActivity([assistant('a', [
            tool('edit', 'edit', { input: { path: 'a' }, metadata: { diff } }),
            tool('write', 'write', { input: { path: 'b', content: 'one\ntwo\nthree' } }),
        ])]);
        expect(result).toMatchObject({ files: 2, hasCompleteDiff: false });
        expect(result.changedFiles).toEqual([{ path: 'a', additions: 2, deletions: 1 }, { path: 'b' }]);
    });

    // v2 assistant messages carry no working directory, so a path is listed
    // exactly as the tool reported it, only normalized.
    test('lists touched files as the tools reported them, in first-touch order', () => {
        const result = summarizeLiveActivity([assistant('a', [
            tool('write', 'write', { input: { path: '/project/src/new.ts' }, metadata: { diff } }),
            tool('edit', 'edit', { input: { path: '/project/src/a.ts' }, metadata: { filediff: { file: '/project/src/a.ts', additions: 1, deletions: 0 } } }),
            tool('again', 'edit', { input: { path: '/project/src/new.ts' }, metadata: { diff: '@@ -1,1 +1,0 @@\n-after' } }),
            tool('outside', 'edit', { input: { path: '/elsewhere/b.ts' }, metadata: { diff } }),
        ])]);
        expect(result.changedFiles).toEqual([
            { path: '/project/src/new.ts', additions: 2, deletions: 2 },
            { path: '/project/src/a.ts', additions: 1, deletions: 0 },
            { path: '/elsewhere/b.ts', additions: 2, deletions: 1 },
        ]);
    });

    test('a Windows tool path joins the forward-slash path git prints for the same file', () => {
        const result = summarizeLiveActivity([assistant('windows', [
            tool('one', 'edit', { input: { path: 'C:\\Project\\src\\A.ts' }, metadata: { diff } }),
            tool('two', 'edit', { input: { path: 'c:/project/src/a.ts' }, metadata: { diff } }),
        ])]);
        expect(result.changedFiles).toEqual([{ path: 'C:/Project/src/A.ts', additions: 4, deletions: 2 }]);
    });

    test('rejects truncated diff counts and counts source lines resembling diff headers', () => {
        expect(summarizeLiveActivity([assistant('a', [tool('edit', 'edit', { input: { path: 'a' }, metadata: { diff: '@@ -1,1 +1,2 @@\n-old\n+incomplete' } })])]).hasCompleteDiff).toBe(false);
        expect(summarizeLiveActivity([assistant('a', [tool('edit', 'edit', { input: { path: 'a' }, metadata: { diff: '@@ -1,1 +1,1 @@\n---source\n+++source' } })])])).toMatchObject({ additions: 1, deletions: 1 });
    });

    test('failed edits and malformed metadata cannot erase another valid change', () => {
        const result = summarizeLiveActivity([assistant('a', [
            tool('bad', 'edit', { status: 'error', error: 'failed', input: { path: 'bad' }, metadata: { diff } }),
            tool('good', 'edit', { input: { path: 'good' }, metadata: { diff, files: 'invalid' } }),
        ])]);
        expect(result).toMatchObject({ files: 1, additions: 2, deletions: 1, hasCompleteDiff: true });
    });

    test('normalizes absolute dot segments and Windows path spelling', () => {
        expect(summarizeLiveActivity([assistant('unix', [
            tool('one', 'edit', { input: { path: '/project/src/../a' }, metadata: { diff } }),
            tool('two', 'edit', { input: { path: '/project/a' }, metadata: { diff } }),
        ])]).files).toBe(1);
        expect(summarizeLiveActivity([assistant('windows', [
            tool('one', 'edit', { input: { path: 'C:\\Project\\A.ts' }, metadata: { diff } }),
            tool('two', 'edit', { input: { path: 'c:/project/./a.ts' }, metadata: { diff } }),
        ])]).files).toBe(1);
    });

    test('a confirmed no-op is not a changed file, but creating an empty file is', () => {
        expect(summarizeLiveActivity([assistant('a', [tool('patch', 'patch', { metadata: { files: [
            { file: '/project/noop', additions: 0, deletions: 0, status: 'modified' },
            { file: '/project/empty', additions: 0, deletions: 0, status: 'added' },
        ] } })])])).toMatchObject({ files: 1, additions: 0, deletions: 0, hasCompleteDiff: true });
    });
});
