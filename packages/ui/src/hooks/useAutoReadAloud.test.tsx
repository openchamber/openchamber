import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import type { LatestReply } from '@/lib/messages/latestReply';
import { useAutoReadAloud, type AutoReadAloudOptions } from './useAutoReadAloud';

let root: Root | null = null;
let host: HTMLElement;

const Probe: React.FC<AutoReadAloudOptions> = (props) => {
    useAutoReadAloud(props);
    return null;
};

const reply = (messageId: string, text = `Text of ${messageId}`): LatestReply => ({ messageId, text });

const recorder = () => {
    const calls: string[] = [];
    return {
        calls,
        play: async (text: string): Promise<void> => {
            calls.push(text);
        },
    };
};

const mount = (props: AutoReadAloudOptions) => act(async () => root?.render(<Probe {...props} />));

beforeEach(() => {
    const dom = new Window({ url: 'http://localhost' });
    Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: dom });
    Object.defineProperty(globalThis, 'document', { configurable: true, writable: true, value: dom.document });
    Object.defineProperty(globalThis, 'navigator', { configurable: true, writable: true, value: dom.navigator });
    Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, writable: true, value: true });
    host = document.createElement('div');
    root = createRoot(host);
});

afterEach(() => {
    act(() => root?.unmount());
    root = null;
    Reflect.deleteProperty(globalThis, 'window');
    Reflect.deleteProperty(globalThis, 'document');
    Reflect.deleteProperty(globalThis, 'navigator');
});

describe('useAutoReadAloud', () => {
    test('a reply already present at mount is the baseline, not speech', async () => {
        const { calls, play } = recorder();

        await mount({ sessionKey: 'ses_1', ready: true, sessionIsActive: true, reply: reply('a1'), enabled: true, play });
        expect(calls).toEqual([]);

        await mount({ sessionKey: 'ses_1', ready: true, sessionIsActive: true, reply: reply('a1'), enabled: true, play });
        expect(calls).toEqual([]);
    });

    test('reads a reply completed after the surface watched the turn run', async () => {
        const { calls, play } = recorder();

        await mount({ sessionKey: 'ses_1', ready: true, sessionIsActive: true, reply: reply('a1'), enabled: true, play });
        await mount({ sessionKey: 'ses_1', ready: true, sessionIsActive: false, reply: reply('a2', 'Second answer'), enabled: true, play });

        expect(calls).toEqual(['Second answer']);
    });

    test('reads the same reply once', async () => {
        const { calls, play } = recorder();

        await mount({ sessionKey: 'ses_1', ready: true, sessionIsActive: true, reply: null, enabled: true, play });
        await mount({ sessionKey: 'ses_1', ready: true, sessionIsActive: false, reply: reply('a1'), enabled: true, play });
        await mount({ sessionKey: 'ses_1', ready: true, sessionIsActive: false, reply: reply('a1'), enabled: true, play });

        expect(calls).toEqual(['Text of a1']);
    });

    test('reverting to an answer that was already read does not read it again', async () => {
        const { calls, play } = recorder();

        await mount({ sessionKey: 'ses_1', ready: true, sessionIsActive: true, reply: null, enabled: true, play });
        await mount({ sessionKey: 'ses_1', ready: true, sessionIsActive: false, reply: reply('a1', 'First answer'), enabled: true, play });
        await mount({ sessionKey: 'ses_1', ready: true, sessionIsActive: true, reply: reply('a1'), enabled: true, play });
        await mount({ sessionKey: 'ses_1', ready: true, sessionIsActive: false, reply: reply('a2', 'Second answer'), enabled: true, play });
        expect(calls).toEqual(['First answer', 'Second answer']);

        // Trimming the later turn makes the earlier answer the latest reply
        // again, with no new turn behind it.
        await mount({ sessionKey: 'ses_1', ready: true, sessionIsActive: false, reply: reply('a1', 'First answer'), enabled: true, play });
        expect(calls).toEqual(['First answer', 'Second answer']);
    });

    test('a reply that arrives while auto-read is off is not spoken when it is turned on', async () => {
        const { calls, play } = recorder();

        await mount({ sessionKey: 'ses_1', ready: true, sessionIsActive: true, reply: reply('a1'), enabled: false, play });
        await mount({ sessionKey: 'ses_1', ready: true, sessionIsActive: false, reply: reply('a2'), enabled: false, play });
        await mount({ sessionKey: 'ses_1', ready: true, sessionIsActive: false, reply: reply('a2'), enabled: true, play });
        expect(calls).toEqual([]);

        await mount({ sessionKey: 'ses_1', ready: true, sessionIsActive: true, reply: reply('a3', 'Third answer'), enabled: true, play });
        expect(calls).toEqual(['Third answer']);
    });

    test('a session that was never seen running does not speak its history', async () => {
        const { calls, play } = recorder();

        await mount({ sessionKey: 'ses_1', ready: true, sessionIsActive: false, reply: reply('a1'), enabled: true, play });
        await mount({ sessionKey: 'ses_1', ready: true, sessionIsActive: false, reply: reply('a2'), enabled: true, play });

        expect(calls).toEqual([]);
    });

    test('a session switch starts a baseline on the new session', async () => {
        const { calls, play } = recorder();

        await mount({ sessionKey: 'ses_1', ready: true, sessionIsActive: true, reply: reply('a1'), enabled: true, play });
        await mount({ sessionKey: 'ses_2', ready: false, sessionIsActive: false, reply: null, enabled: true, play });
        await mount({ sessionKey: 'ses_2', ready: true, sessionIsActive: false, reply: reply('b1'), enabled: true, play });
        expect(calls).toEqual([]);

        await mount({ sessionKey: 'ses_2', ready: true, sessionIsActive: true, reply: reply('b2', 'New session answer'), enabled: true, play });
        expect(calls).toEqual(['New session answer']);

        await mount({ sessionKey: 'ses_1', ready: true, sessionIsActive: false, reply: reply('a1'), enabled: true, play });
        expect(calls).toEqual(['New session answer']);
    });

    test('history is not a baseline until the message load reports ready', async () => {
        const { calls, play } = recorder();

        await mount({ sessionKey: 'ses_1', ready: false, sessionIsActive: true, reply: reply('a1'), enabled: true, play });
        await mount({ sessionKey: 'ses_1', ready: true, sessionIsActive: true, reply: reply('a1'), enabled: true, play });
        expect(calls).toEqual([]);

        await mount({ sessionKey: 'ses_1', ready: true, sessionIsActive: false, reply: reply('a2', 'Loaded answer'), enabled: true, play });
        expect(calls).toEqual(['Loaded answer']);
    });

    test('a mid-turn mount reads the answer that completes later', async () => {
        const { calls, play } = recorder();

        await mount({ sessionKey: 'ses_1', ready: true, sessionIsActive: true, reply: null, enabled: true, play });
        await mount({ sessionKey: 'ses_1', ready: true, sessionIsActive: false, reply: reply('a1', 'Just finished'), enabled: true, play });

        expect(calls).toEqual(['Just finished']);
    });
});
