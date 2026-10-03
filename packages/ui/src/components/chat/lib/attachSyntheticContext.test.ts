import { describe, expect, test } from 'bun:test';
import type { Message, Part, SyntheticMessage, TextPart, UserMessage } from '@/lib/opencode/model';
import { CONTEXT_METADATA_KEY, readContextPart } from '@/lib/messages/contextParts';

import { attachSyntheticContext } from './attachSyntheticContext';
import type { ChatMessageEntry } from './turns/types';

const SESSION = 'ses_1';

const entry = (info: Message, parts: Part[] = []): ChatMessageEntry => ({ info, parts });

const textPart = (messageID: string, text: string): TextPart => ({
    id: `${messageID}-p`,
    sessionID: SESSION,
    messageID,
    type: 'text',
    text,
});

const userMessage = (id: string, text: string): ChatMessageEntry => {
    const info: UserMessage = { id, sessionID: SESSION, role: 'user', time: { created: 1 } };
    return entry(info, [textPart(id, text)]);
};

const roleMessage = (id: string, role: 'assistant' | 'shell' | 'model-switched' | 'agent-switched'): ChatMessageEntry => {
    const base = { id, sessionID: SESSION, time: { created: 1 } };
    switch (role) {
        case 'assistant':
            return entry({ ...base, role, agent: 'build', providerID: 'openai', modelID: 'gpt-5' });
        case 'shell':
            return entry({ ...base, role, shellID: 'sh_1', command: 'ls', status: 'exited' });
        case 'model-switched':
            return entry({ ...base, role, model: { providerID: 'openai', id: 'gpt-5' } });
        case 'agent-switched':
            return entry({ ...base, role, agent: 'build' });
    }
};

const contextMessage = (id: string): ChatMessageEntry => {
    const info: SyntheticMessage = {
        id,
        sessionID: SESSION,
        role: 'synthetic',
        time: { created: 1 },
        text: 'Comment on `app.ts` lines 1-2',
        metadata: {
            [CONTEXT_METADATA_KEY]: {
                kind: 'code-comment',
                source: 'file',
                fileLabel: 'app.ts',
                startLine: 1,
                endLine: 2,
                language: 'ts',
                code: 'const a = 1',
                text: 'why?',
            },
        },
    };
    return entry(info);
};

const pluginMessage = (id: string): ChatMessageEntry => entry({
    id,
    sessionID: SESSION,
    role: 'synthetic',
    time: { created: 1 },
    text: 'Welcome back, here is where you left off.',
});

const subagentReport = (id: string): ChatMessageEntry => entry({
    id,
    sessionID: SESSION,
    role: 'synthetic',
    time: { created: 1 },
    text: '<subagent sessionID="ses_child" state="completed" description="review">\nLooks good\n</subagent>',
    description: 'review',
    metadata: { source: 'subagent', childID: 'ses_child', agent: 'general', state: 'completed' },
});

describe('attachSyntheticContext', () => {
    test('attaches the context run to the user message it was sent with', () => {
        const user = userMessage('u1', 'fix this');
        const result = attachSyntheticContext([contextMessage('s1'), user]);

        expect(result).toHaveLength(1);
        expect(result[0]?.info.id).toBe('u1');
        expect(result[0]?.parts).toHaveLength(2);
        expect(readContextPart(result[0]!.parts[0]!)?.kind).toBe('code-comment');
        expect(result[0]?.parts[1]).toBe(user.parts[0]!);
        // The source entry stays untouched, so nothing else sees display parts.
        expect(user.parts).toHaveLength(1);
    });

    test('drops synthetic prompt plumbing and the roles the timeline never shows', () => {
        const result = attachSyntheticContext([
            roleMessage('m1', 'model-switched'),
            roleMessage('sw1', 'agent-switched'),
            pluginMessage('s1'),
            userMessage('u1', 'hello'),
            roleMessage('a1', 'assistant'),
        ]);

        expect(result.map((message) => message.info.id)).toEqual(['u1', 'a1']);
        expect(result[0]?.parts).toHaveLength(1);
    });

    test('keeps notice roles and does not carry context across them', () => {
        const result = attachSyntheticContext([
            contextMessage('s1'),
            roleMessage('sh1', 'shell'),
            userMessage('u1', 'hello'),
        ]);

        expect(result.map((message) => message.info.id)).toEqual(['sh1', 'u1']);
        expect(result[1]?.parts).toHaveLength(1);
    });

    test('keeps a subagent run report as its own entry and ends a context run at it', () => {
        const report = subagentReport('s2');
        const result = attachSyntheticContext([
            userMessage('u1', 'hello'),
            contextMessage('s1'),
            report,
            roleMessage('a1', 'assistant'),
        ]);

        expect(result.map((message) => message.info.id)).toEqual(['u1', 's2', 'a1']);
        expect(result[1]).toBe(report);
    });

    test('keeps context minted before the prompt on it when the context lands just after', () => {
        // The prompt is still optimistic and carries the client's clock, while
        // the server's context record already carries a later time.
        const user = userMessage('msg_2', '');
        const result = attachSyntheticContext([
            contextMessage('msg_0'),
            user,
            contextMessage('msg_1'),
            roleMessage('a1', 'assistant'),
        ]);

        expect(result.map((message) => message.info.id)).toEqual(['msg_2', 'a1']);
        expect(result[0]?.parts.map((part) => part.id)).toEqual(['ctx:msg_0', 'ctx:msg_1', 'msg_2-p']);
    });

    test('keeps the attached order while the context is echoed one record at a time', () => {
        // msg_0 is echoed with the server's later time and now sits after the
        // prompt; msg_1 is still optimistic and sits before it.
        const result = attachSyntheticContext([
            contextMessage('msg_1'),
            userMessage('msg_2', ''),
            contextMessage('msg_0'),
        ]);

        expect(result[0]?.parts.map((part) => part.id)).toEqual(['ctx:msg_0', 'ctx:msg_1', 'msg_2-p']);
    });

    test('leaves context minted after a prompt for the next prompt', () => {
        const result = attachSyntheticContext([
            userMessage('msg_1', 'first'),
            contextMessage('msg_2'),
            userMessage('msg_3', 'second'),
        ]);

        expect(result.map((message) => message.parts.length)).toEqual([1, 2]);
        expect(result[1]?.parts[0]?.id).toBe('ctx:msg_2');
    });

    test('returns the same array when there is nothing to fold', () => {
        const messages = [userMessage('u1', 'hello'), roleMessage('a1', 'assistant')];
        expect(attachSyntheticContext(messages)).toBe(messages);
    });

    test('keeps the merged user entry identical while its context is unchanged', () => {
        const messages = [contextMessage('s1'), userMessage('u1', 'hello')];
        const first = attachSyntheticContext(messages);
        const second = attachSyntheticContext(messages);

        expect(second[0]).toBe(first[0]!);
    });
});
