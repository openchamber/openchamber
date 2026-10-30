import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import type { LatestReply } from '@/lib/messages/latestReply';
import { useAutoReadAloud, type AutoReadAloudOptions } from './useAutoReadAloud';

let root: Root | null = null;
let host: HTMLElement;
let appStateListener: ((state: { isActive: boolean }) => void) | undefined;
let getAppState: () => Promise<{ isActive: boolean }>;
let listenerRemovals = 0;

mock.module('@capacitor/app', () => ({
    App: {
        addListener: async (_event: string, listener: typeof appStateListener) => {
            appStateListener = listener;
            return { remove: async () => { listenerRemovals += 1; } };
        },
        getState: () => getAppState(),
    },
}));

const useNativeMobile = () => {
    Object.defineProperty(window, 'Capacitor', { value: { isNativePlatform: () => true } });
};

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
    appStateListener = undefined;
    getAppState = async () => ({ isActive: true });
    listenerRemovals = 0;
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
    const setVisible = (visible: boolean) => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: visible ? 'visible' : 'hidden' });
        document.dispatchEvent(new Event('visibilitychange'));
    };

    test('a native mobile background reply is skipped without a claim or replay on return', async () => {
        useNativeMobile();
        const { calls, play } = recorder();
        const claims: string[] = [];
        const claim = async (id: string) => { claims.push(id); return true; };
        const props = { sessionKey: 'ses_1', ready: true, sessionIsActive: true, reply: null, enabled: true, play, claim };
        await mount(props);
        setVisible(false);
        await mount({ ...props, reply: reply('background') });
        setVisible(true);
        await mount({ ...props, reply: reply('background') });
        expect(calls).toEqual([]);
        expect(claims).toEqual([]);
        await mount({ ...props, reply: reply('foreground') });
        expect(calls).toEqual(['Text of foreground']);
    });

    test('backgrounding during a claim cancels it even after returning', async () => {
        useNativeMobile();
        const { calls, play } = recorder();
        let resolveClaim: (claimed: boolean) => void = () => {};
        const claim = () => new Promise<boolean>((resolve) => { resolveClaim = resolve; });
        const props = { sessionKey: 'ses_1', ready: true, sessionIsActive: true, reply: null, enabled: true, play, claim };
        await mount(props);
        await mount({ ...props, reply: reply('pending') });
        setVisible(false);
        setVisible(true);
        await act(async () => resolveClaim(true));
        expect(calls).toEqual([]);
    });

    test('preparation eligibility stays cancelled after a background round trip', async () => {
        useNativeMobile();
        let canStart: (() => boolean) | undefined;
        const play: AutoReadAloudOptions['play'] = async (_text, options) => { canStart = options?.canStart; };
        const props = { sessionKey: 'ses_1', ready: true, sessionIsActive: true, reply: null, enabled: true, play };
        await mount(props);
        await mount({ ...props, reply: reply('preparing') });
        expect(canStart?.()).toBe(true);
        setVisible(false);
        setVisible(true);
        expect(canStart?.()).toBe(false);
    });

    test('web and desktop keep claiming and preparing replies in a hidden document', async () => {
        const claims: string[] = [];
        const guards: Array<() => boolean> = [];
        const claim = async (id: string) => { claims.push(id); return true; };
        const play: AutoReadAloudOptions['play'] = async (_text, options) => {
            if (options?.canStart) guards.push(options.canStart);
        };
        const props = { sessionKey: 'ses_1', ready: true, sessionIsActive: true, reply: null, enabled: true, play, claim };
        await mount(props);
        setVisible(false);
        await mount({ ...props, reply: reply('background') });
        expect(claims).toEqual(['background']);
        expect(guards[0]()).toBe(true);
        setVisible(true);
        setVisible(false);
        expect(guards[0]()).toBe(true);
    });

    test('web and desktop allow a pending claim to finish after a background round trip', async () => {
        const { calls, play } = recorder();
        let resolveClaim: (claimed: boolean) => void = () => {};
        const claim = () => new Promise<boolean>((resolve) => { resolveClaim = resolve; });
        const props = { sessionKey: 'ses_1', ready: true, sessionIsActive: true, reply: null, enabled: true, play, claim };
        await mount(props);
        await mount({ ...props, reply: reply('pending') });
        setVisible(false);
        setVisible(true);
        await act(async () => resolveClaim(true));
        expect(calls).toEqual(['Text of pending']);
    });

    test('native lifecycle alone cancels preparation and removes its listener on unmount', async () => {
        useNativeMobile();
        let canStart: (() => boolean) | undefined;
        const play: AutoReadAloudOptions['play'] = async (_text, options) => { canStart = options?.canStart; };
        const props = { sessionKey: 'ses_1', ready: true, sessionIsActive: true, reply: null, enabled: true, play };
        await mount(props);
        await mount({ ...props, reply: reply('preparing') });
        expect(canStart?.()).toBe(true);
        appStateListener?.({ isActive: false });
        appStateListener?.({ isActive: true });
        expect(canStart?.()).toBe(false);
        act(() => root?.unmount());
        root = null;
        expect(listenerRemovals).toBe(1);
    });

    test('unknown native state stays silent and a newer lifecycle event wins over initial state', async () => {
        useNativeMobile();
        let resolveState: (state: { isActive: boolean }) => void = () => {};
        getAppState = () => new Promise((resolve) => { resolveState = resolve; });
        const { calls, play } = recorder();
        const claims: string[] = [];
        const claim = async (id: string) => { claims.push(id); return true; };
        const props = { sessionKey: 'ses_1', ready: true, sessionIsActive: true, reply: null, enabled: true, play, claim };
        await mount(props);
        await mount({ ...props, reply: reply('unknown') });
        appStateListener?.({ isActive: false });
        await act(async () => resolveState({ isActive: true }));
        await mount({ ...props, reply: reply('inactive') });
        expect(calls).toEqual([]);
        expect(claims).toEqual([]);
        appStateListener?.({ isActive: true });
        await mount({ ...props, reply: reply('active') });
        expect(calls).toEqual(['Text of active']);
    });

    test('session changes and disabling auto-read invalidate preparation', async () => {
        const guards: Array<() => boolean> = [];
        const play: AutoReadAloudOptions['play'] = async (_text, options) => {
            if (options?.canStart) guards.push(options.canStart);
        };
        const props = { sessionKey: 'ses_1', ready: true, sessionIsActive: true, reply: null, enabled: true, play };
        await mount(props);
        await mount({ ...props, reply: reply('preparing') });
        await mount({ ...props, reply: reply('preparing'), enabled: false });
        await mount({ ...props, reply: reply('preparing'), enabled: true });
        expect(guards[0]()).toBe(false);
        await mount({ ...props, reply: reply('next') });
        await mount({ ...props, sessionKey: 'ses_2' });
        await mount({ ...props, reply: reply('next') });
        expect(guards[1]()).toBe(false);
    });
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
