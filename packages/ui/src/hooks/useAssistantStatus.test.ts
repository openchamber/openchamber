import { describe, expect, test } from 'bun:test';
import type { AssistantMessage, Metadata, Part, StructuredError, SyntheticMessage, ToolInput, ToolState, UserMessage } from '@/lib/opencode/model';

import { createParsedStatus, getActiveAssistantContext, hasBackgroundableWork, limitResetsAt } from './useAssistantStatus';

const userMessage = (id: string): UserMessage => ({
    id,
    role: 'user',
    sessionID: 'ses_1',
    time: { created: 1 },
});

const assistantMessage = (id: string, providerID: string, modelID: string): AssistantMessage => ({
    id,
    role: 'assistant',
    sessionID: 'ses_1',
    time: { created: 2 },
    agent: 'build',
    providerID,
    modelID,
});

const syntheticMessage = (id: string): SyntheticMessage => ({
    id,
    role: 'synthetic',
    sessionID: 'ses_1',
    time: { created: 3 },
    text: 'server plugin prompt',
});

describe('getActiveAssistantContext', () => {
    test('keeps the model when plumbing messages land after the assistant', () => {
        const assistant = assistantMessage('assistant_1', 'anthropic', 'claude-opus-4-1');

        expect(getActiveAssistantContext([userMessage('user_1'), assistant, syntheticMessage('synthetic_1')])).toEqual({
            assistantId: assistant.id,
            model: {
                providerId: 'anthropic',
                modelId: 'claude-opus-4-1',
            },
        });
    });

    test('reports the model recorded on the newest assistant message', () => {
        const prompt = userMessage('user_1');
        const assistant = assistantMessage('assistant_1', 'anthropic', 'claude-opus-4-1');
        const laterPrompt = userMessage('user_2');

        expect(getActiveAssistantContext([prompt, assistant, laterPrompt])).toEqual({
            assistantId: assistant.id,
            model: {
                providerId: 'anthropic',
                modelId: 'claude-opus-4-1',
            },
        });
    });

    test('follows the newer assistant message when the model changed mid-session', () => {
        const firstUser = userMessage('user_1');
        const firstAssistant = assistantMessage('assistant_1', 'anthropic', 'claude-opus-4-1');
        const secondUser = userMessage('user_2');
        const secondAssistant = assistantMessage('assistant_2', 'openai', 'gpt-5.6-sol');

        expect(getActiveAssistantContext([firstUser, firstAssistant, secondUser, secondAssistant])).toEqual({
            assistantId: secondAssistant.id,
            model: {
                providerId: 'openai',
                modelId: 'gpt-5.6-sol',
            },
        });
    });

    test('does not guess a model when the assistant message records none', () => {
        const assistant = assistantMessage('assistant_1', '', '');

        expect(getActiveAssistantContext([assistant])).toEqual({
            assistantId: assistant.id,
            model: null,
        });
    });

    test('reports no assistant when the session has only prompts', () => {
        expect(getActiveAssistantContext([userMessage('user_1')])).toEqual({
            assistantId: null,
            model: null,
        });
    });

    test('shows the session record model while a prompt sent after a finished turn waits for its answer', () => {
        // A v2 user message records no model; the send switched the session
        // first, so the session record names the model the new turn runs on.
        const previousAssistant = { ...assistantMessage('assistant_1', 'anthropic', 'claude-opus-4-1'), time: { created: 2, completed: 3 } };
        const messages = [userMessage('user_1'), previousAssistant, userMessage('user_2')];

        expect(getActiveAssistantContext(messages, { providerID: 'openai', id: 'gpt-5.6-sol' })).toEqual({
            assistantId: previousAssistant.id,
            model: { providerId: 'openai', modelId: 'gpt-5.6-sol' },
        });
        // Without a session record nothing is shown: naming the previous turn's
        // model would name the wrong one.
        expect(getActiveAssistantContext(messages)).toEqual({ assistantId: previousAssistant.id, model: null });
    });

    test('a turn still running keeps its model when a prompt is queued behind it', () => {
        const running = assistantMessage('assistant_1', 'anthropic', 'claude-opus-4-1');

        expect(getActiveAssistantContext([userMessage('user_1'), running, userMessage('user_2')])).toEqual({
            assistantId: running.id,
            model: { providerId: 'anthropic', modelId: 'claude-opus-4-1' },
        });
    });
});

describe('hasBackgroundableWork', () => {
    const tool = (name: string, state: Extract<Part, { type: 'tool' }>['state']): Part => ({
        id: `prt_${name}`,
        sessionID: 'ses_1',
        messageID: 'msg_1',
        type: 'tool',
        callID: `call_${name}`,
        tool: name,
        state,
    });

    test('a running command or subagent can go to the background', () => {
        expect(hasBackgroundableWork([tool('shell', { status: 'running', input: { command: 'bun test' }, time: { start: 1 } })])).toBe(true);
        expect(hasBackgroundableWork([tool('subagent', { status: 'running', input: { agent: 'explore' }, time: { start: 1 } })])).toBe(true);
    });

    test('other tools, pending calls and settled calls cannot', () => {
        expect(hasBackgroundableWork([tool('read', { status: 'running', input: {}, time: { start: 1 } })])).toBe(false);
        expect(hasBackgroundableWork([tool('shell', { status: 'pending', input: {}, raw: '' })])).toBe(false);
        expect(hasBackgroundableWork([tool('shell', {
            status: 'completed',
            input: { command: 'sleep 300', background: true },
            output: 'Command moved to the background',
            metadata: { status: 'running', shellID: 'sh_1' },
            time: { start: 1, end: 2 },
        })])).toBe(false);
    });

    test('a command or subagent inside Code Mode can go to the background', () => {
        for (const name of ['shell', 'subagent']) {
            expect(hasBackgroundableWork([tool('execute', {
                status: 'running', input: { code: 'await tools.shell(...)' }, time: { start: 1 },
                metadata: { toolCalls: [{ tool: name, status: 'running' }] },
            })])).toBe(true);
        }
    });

    test('Code Mode uses live nested calls, including parallel work', () => {
        const execute = (toolCalls: Array<{ tool: string; status: string }>) => tool('execute', {
            status: 'running', input: {}, time: { start: 1 }, metadata: { toolCalls },
        });
        expect(hasBackgroundableWork([execute([{ tool: 'shell', status: 'completed' }])])).toBe(false);
        expect(hasBackgroundableWork([execute([{ tool: 'shell', status: 'error' }])])).toBe(false);
        expect(hasBackgroundableWork([execute([{ tool: 'read', status: 'running' }])])).toBe(false);
        expect(hasBackgroundableWork([execute([])])).toBe(false);
        expect(hasBackgroundableWork([execute([
            { tool: 'shell', status: 'running' }, { tool: 'read', status: 'completed' },
        ])])).toBe(true);
    });

    test('Code Mode recognizes child progress that replaces the nested call list', () => {
        const progress: Metadata[] = [{ shellID: 'sh_1' }, { sessionID: 'ses_child', status: 'running' }];
        for (const metadata of progress) {
            expect(hasBackgroundableWork([tool('execute', {
                status: 'running', input: {}, time: { start: 1 }, metadata,
            })])).toBe(true);
            expect(hasBackgroundableWork([tool('execute', {
                status: 'completed', input: {}, output: 'done', time: { start: 1, end: 2 }, metadata,
            })])).toBe(false);
        }
    });
});

describe('createParsedStatus', () => {
    const toolState = (status: 'running' | 'pending' | 'completed'): ToolState => {
        if (status === 'completed') {
            return { status: 'completed', input: {}, output: '', time: { start: 1, end: 2 } };
        }
        if (status === 'pending') {
            return { status: 'pending', input: {}, raw: '' };
        }
        return { status: 'running', input: {}, time: { start: 1 } };
    };

    const tool = (id: string, name: string, status: 'running' | 'pending' | 'completed' = 'running'): Part => ({
        id,
        sessionID: 'ses_1',
        messageID: 'msg_1',
        type: 'tool',
        callID: `call_${id}`,
        tool: name,
        state: toolState(status),
    });

    const statusOf = (parts: Part[]) => createParsedStatus(parts, 'ses_1:msg_1');

    test('names a tool by the kind of work it does', () => {
        expect(statusOf([tool('1', 'read')]).statusText).toBe('reading a file');
        expect(statusOf([tool('1', 'patch')]).statusText).toBe('editing a file');
        expect(statusOf([tool('1', 'shell')]).statusText).toBe('running a command');
        expect(statusOf([tool('1', 'webfetch')]).statusText).toBe('looking things up');
        expect(statusOf([tool('1', 'subagent')]).statusText).toBe('handing off a task');
        expect(statusOf([tool('1', 'skill')]).statusText).toBe('picking up a skill');
    });

    test('counts parallel calls of the same kind', () => {
        expect(statusOf([tool('1', 'read'), tool('2', 'read'), tool('3', 'file-diff')]).statusText).toBe('reading 3 files');
        expect(statusOf([tool('1', 'write'), tool('2', 'patch')]).statusText).toBe('editing 2 files');
        expect(statusOf([tool('1', 'shell'), tool('2', 'execute')]).statusText).toBe('running 2 commands');
        expect(statusOf([tool('1', 'subagent'), tool('2', 'subagent')]).statusText).toBe('handing off 2 tasks');
    });

    test('does not count searches, since one call spans many files', () => {
        expect(statusOf([tool('1', 'grep'), tool('2', 'glob')]).statusText).toBe('searching files');
    });

    test('counts only unfinished calls', () => {
        expect(statusOf([tool('1', 'read'), tool('2', 'read', 'completed')]).statusText).toBe('reading a file');
    });

    test('shows the newest kind when different tools run together', () => {
        expect(statusOf([tool('1', 'read'), tool('2', 'shell')]).statusText).toBe('running a command');
        expect(statusOf([tool('1', 'shell'), tool('2', 'read')]).statusText).toBe('reading a file');
    });

    describe('OpenChamber tools', () => {
        const call = (name: string, input: ToolInput, status: 'running' | 'pending' = 'running'): Part => ({
            id: '1',
            sessionID: 'ses_1',
            messageID: 'msg_1',
            type: 'tool',
            callID: 'call_1',
            tool: name,
            state: status === 'running'
                ? { status: 'running', input, time: { start: 1 } }
                : { status: 'pending', input, raw: '' },
        });
        const script = (toolCalls: Metadata[]): Part => ({
            id: '1',
            sessionID: 'ses_1',
            messageID: 'msg_1',
            type: 'tool',
            callID: 'call_1',
            tool: 'execute',
            state: { status: 'running', input: {}, time: { start: 1 }, metadata: { toolCalls } },
        });

        test('say what the action does instead of the tool name', () => {
            expect(statusOf([call('openchamber_web', { action: 'browser.snapshot', parameters: {} })]).statusText).toBe('reading a page');
            expect(statusOf([call('openchamber_memory', { action: 'memory.save', parameters: { title: 'x' } })]).statusText).toBe('saving to memory');
            expect(statusOf([call('openchamber', { action: 'session.create' })]).statusText).toBe('starting a session');
            expect(statusOf([call('openchamber_notify', { title: 'Done' })]).statusText).toBe('sending a notification');
        });

        test('fall back to the tool phrase for an action without its own', () => {
            expect(statusOf([call('openchamber_web', { action: 'browser.click' })]).statusText).toBe('using the browser');
            expect(statusOf([call('openchamber_knowledge', {})]).statusText).toBe('checking project knowledge');
        });

        test('a page that waits for the answer says so once it shows', () => {
            const input = { action: 'render.page', parameters: { html: '<p>a</p>', awaitAnswer: true } };
            expect(statusOf([call('openchamber_render', input, 'pending')]).statusText).toBe('drawing a page');
            expect(statusOf([call('openchamber_render', input)]).statusText).toBe('waiting for your answer');
        });

        test('read the same from inside a Code Mode script', () => {
            expect(statusOf([script([
                { tool: 'openchamber_web', status: 'completed', input: { action: 'browser.open' } },
                { tool: 'openchamber_memory', status: 'running', input: { action: 'memory.read' } },
            ])]).statusText).toBe('checking memory');
        });
    });

    describe('tools outside the built-ins', () => {
        const script = (tool: string): Part => ({
            id: '1',
            sessionID: 'ses_1',
            messageID: 'msg_1',
            type: 'tool',
            callID: 'call_1',
            tool: 'execute',
            state: { status: 'running', input: {}, time: { start: 1 }, metadata: { toolCalls: [{ tool, status: 'running' }] } },
        });
        const servers = ['linear', 'claude_in_chrome', 'claude', 'my.server'];
        const statusWith = (parts: Part[]) => createParsedStatus(parts, 'ses_1:msg_1', servers).statusText;

        test('the opencode namespace says what OpenCode does to itself', () => {
            expect(statusWith([script('opencode_session_rename')])).toBe('renaming the session');
            expect(statusWith([script('opencode_worktree_list')])).toBe('checking worktrees');
            expect(statusWith([script('opencode_read_mcp_resource')])).toBe('reading an MCP resource');
            expect(statusWith([tool('1', 'opencode.models')])).toBe('looking up models');
        });

        test('an MCP tool names its integration, the longest server name first', () => {
            expect(statusWith([script('linear_list_issues')])).toBe('using linear');
            expect(statusWith([tool('1', 'linear_get_document')])).toBe('using linear');
            expect(statusWith([script('claude_in_chrome_navigate')])).toBe('using claude in chrome');
            expect(statusWith([script('my_server_query')])).toBe('using my.server');
        });

        test('a tool no server claims reads as words', () => {
            expect(statusOf([script('linear_list_issues')]).statusText).toBe('using linear list issues');
            expect(statusOf([tool('1', 'jev-route')]).statusText).toBe('using jev route');
        });
    });
});

describe('limitResetsAt', () => {
    const error = (body: string): StructuredError => ({ type: 'provider.rate-limit', message: 'limit', status: 429, response: { body } });
    const rateLimit = (body: unknown) => error(JSON.stringify(body));

    test('reads resets_at under error, as the Claude Code plugin sends it', () => {
        const claude = rateLimit({ error: { type: 'rate_limit_error', resets_at: '2026-10-19T12:20:00.000Z', retry_after: 16775 } });
        expect(limitResetsAt(claude)).toBe(Date.parse('2026-10-19T12:20:00.000Z'));
    });

    test('reads a top-level resets_at in epoch seconds or milliseconds', () => {
        expect(limitResetsAt(rateLimit({ resets_at: 1792412400 }))).toBe(1792412400000);
        expect(limitResetsAt(rateLimit({ resets_at: 1792412400000 }))).toBe(1792412400000);
    });

    test('ignores errors without a usable reset time', () => {
        expect(limitResetsAt(undefined)).toBeUndefined();
        expect(limitResetsAt({ type: 'provider.unknown', message: 'boom' })).toBeUndefined();
        expect(limitResetsAt(error('resets_at soon, not json'))).toBeUndefined();
        expect(limitResetsAt(rateLimit({ error: { resets_at: 'tomorrow' } }))).toBeUndefined();
    });
});
