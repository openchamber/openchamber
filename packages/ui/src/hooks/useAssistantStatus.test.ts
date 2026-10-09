import { describe, expect, test } from 'bun:test';
import type { AssistantMessage, Part, SyntheticMessage, ToolState, UserMessage } from '@/lib/opencode/model';

import { createParsedStatus, getActiveAssistantContext, hasBackgroundableWork } from './useAssistantStatus';

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
});
