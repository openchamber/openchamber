import { describe, expect, test } from 'bun:test';
import type { AssistantMessage, Message, Part, SyntheticMessage, TextPart, UserMessage } from '@/lib/opencode/model';
import { CONTEXT_METADATA_KEY, readContextPart } from '@/lib/messages/contextParts';

import { readSessionNoticePart } from '@/lib/opencode/session-notices';

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

const step = (id: string, finish?: 'stop' | 'tool-calls'): ChatMessageEntry => {
    const info: AssistantMessage = { id, sessionID: SESSION, role: 'assistant', time: { created: 1 }, agent: 'build', providerID: 'openai', modelID: 'gpt-5' };
    if (finish) info.finish = finish;
    return entry(info, [textPart(id, 'working')]);
};

const pluginNotice = (id: string, description = 'Waiting for quota reset'): ChatMessageEntry => entry({
    id,
    sessionID: SESSION,
    role: 'synthetic',
    time: { created: 1 },
    text: 'Retry round 3, the provider answered 429.',
    description,
});

const noticeLabels = (message: ChatMessageEntry | undefined): string[] => (message?.parts ?? []).flatMap((part) => {
    const notice = part.type === 'tool' ? readSessionNoticePart(part) : undefined;
    return notice?.kind === 'plugin' ? [notice.label] : [];
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

    test('keeps the last notice between two answers so the later answer opens a turn there', () => {
        const answer = entry({ id: 'a1', sessionID: SESSION, role: 'assistant', time: { created: 1 }, agent: 'build', providerID: 'openai', modelID: 'gpt-5', finish: 'stop' });
        const result = attachSyntheticContext([
            userMessage('u1', 'hello'),
            answer,
            roleMessage('sw1', 'agent-switched'),
            pluginMessage('s1'),
            roleMessage('a2', 'assistant'),
        ]);

        expect(result.map((message) => message.info.id)).toEqual(['u1', 'a1', 's1', 'a2']);
    });

    test('puts a notice that lands mid-run on the step it followed', () => {
        const working = step('a1', 'tool-calls');
        const result = attachSyntheticContext([userMessage('u1', 'go'), working, pluginNotice('n1'), step('a2')]);

        expect(result.map((message) => message.info.id)).toEqual(['u1', 'a1', 'a2']);
        expect(noticeLabels(result[1])).toEqual(['Waiting for quota reset']);
        expect(result[1]?.parts[0]).toBe(working.parts[0]!);
        expect(result[1]?.parts.at(-1)?.messageID).toBe('a1');
        expect(working.parts).toHaveLength(1);
    });

    test('puts a notice that lands before any step on the run\'s first step', () => {
        const result = attachSyntheticContext([userMessage('u1', 'go'), pluginNotice('n1'), step('a1')]);

        expect(result.map((message) => message.info.id)).toEqual(['u1', 'a1']);
        expect(noticeLabels(result[1])).toEqual(['Waiting for quota reset']);
        expect(result[1]?.parts[0]?.messageID).toBe('a1');
    });

    test('keeps a notice after a prompt as an entry until the run\'s first step arrives', () => {
        const notice = pluginNotice('n1');
        const result = attachSyntheticContext([userMessage('u1', 'go'), notice]);

        expect(result.map((message) => message.info.id)).toEqual(['u1', 'n1']);
        expect(result[1]).toBe(notice);
    });

    test('keeps a notice that landed during the final step on it after it answered', () => {
        const answer = step('a1', 'stop');
        if (answer.info.role === 'assistant') answer.info.time = { created: 1, completed: 10 };
        const during = pluginNotice('n1');
        during.info.time = { created: 5 };
        const after = pluginNotice('n2', 'later');
        after.info.time = { created: 20 };
        const result = attachSyntheticContext([userMessage('u1', 'go'), answer, during, after]);

        expect(result.map((message) => message.info.id)).toEqual(['u1', 'a1', 'n2']);
        expect(noticeLabels(result[1])).toEqual(['Waiting for quota reset']);
    });

    test('moves a notice the answer took to the turn it opens when the agent resumes', () => {
        const answer = step('a1', 'stop');
        if (answer.info.role === 'assistant') answer.info.time = { created: 1, completed: 10 };
        const during = pluginNotice('n1');
        during.info.time = { created: 5 };
        const result = attachSyntheticContext([userMessage('u1', 'go'), answer, during, step('a2')]);

        expect(result.map((message) => message.info.id)).toEqual(['u1', 'a1', 'n1', 'a2']);
        expect(noticeLabels(result[1])).toEqual([]);
    });

    test('keeps a notice after an answer between the turns', () => {
        const notice = pluginNotice('n1');
        const result = attachSyntheticContext([userMessage('u1', 'go'), step('a1', 'stop'), notice, userMessage('u2', 'next')]);

        expect(result.map((message) => message.info.id)).toEqual(['u1', 'a1', 'n1', 'u2']);
        expect(result[2]).toBe(notice);
    });

    test('opens the turn of a step after an answer at the last notice, keeping earlier ones between', () => {
        const result = attachSyntheticContext([
            userMessage('u1', 'go'),
            step('a1', 'stop'),
            pluginNotice('n1', 'first'),
            pluginNotice('n2', 'second'),
            step('a2'),
        ]);

        expect(result.map((message) => message.info.id)).toEqual(['u1', 'a1', 'n1', 'n2', 'a2']);
        expect(noticeLabels(result[4])).toEqual([]);
    });

    test('keeps a notice of a running step on it when a prompt was queued behind it', () => {
        const running = step('a1');
        const queued = userMessage('u2', 'next');
        queued.info.time = { created: 5 };
        const notice = pluginNotice('n1', 'Loaded AGENTS.md');
        notice.info.time = { created: 6 };
        const result = attachSyntheticContext([userMessage('u1', 'go'), running, queued, notice]);

        expect(result.map((message) => message.info.id)).toEqual(['u1', 'a1', 'u2']);
        expect(noticeLabels(result[1])).toEqual(['Loaded AGENTS.md']);
    });

    test('keeps the step with its notices identical while nothing changed', () => {
        const messages = [userMessage('u1', 'go'), step('a1', 'tool-calls'), pluginNotice('n1')];
        const first = attachSyntheticContext(messages);
        const second = attachSyntheticContext(messages);

        expect(second[1]).toBe(first[1]!);
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
