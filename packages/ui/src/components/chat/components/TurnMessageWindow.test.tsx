import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import type { AssistantMessage } from '@/lib/opencode/model';
import type { ChatMessageEntry } from '../lib/turns/types';
import {
    TURN_MESSAGE_WINDOW_TAIL,
    TURN_MESSAGE_WINDOW_THRESHOLD,
    TurnMessageWindowContext,
    createTurnMessageWindowStore,
    shouldHoldRevealAnchor,
    type TurnMessageWindowStore,
} from '../lib/turns/turnMessageWindow';
import { TurnMessageWindow } from './TurnMessageWindow';

function assistant(id: string): ChatMessageEntry {
    const info: AssistantMessage = {
        id, sessionID: 'session', role: 'assistant', time: { created: 1, completed: 2 },
        modelID: 'model', providerID: 'provider', agent: 'build',
        cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, finish: 'tool-calls',
    };
    return { info, parts: [] };
}

const steps = (count: number): ChatMessageEntry[] => Array.from({ length: count }, (_, index) => assistant(`step-${index}`));
const renderMessage = (message: ChatMessageEntry) => <div key={message.info.id} data-message-id={message.info.id} />;

describe('turn message window', () => {
    let root: Root;
    let container: HTMLDivElement;
    let restore: () => void;

    beforeEach(() => {
        const win = new Window({ url: 'http://localhost' });
        const globals = {
            window: win, document: win.document, HTMLElement: win.HTMLElement, Element: win.Element,
            IntersectionObserver: win.IntersectionObserver,
            IS_REACT_ACT_ENVIRONMENT: true,
        };
        const previous = Object.keys(globals).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
        for (const [name, value] of Object.entries(globals)) {
            Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
        }
        restore = () => {
            for (const [name, descriptor] of previous) {
                if (descriptor) Object.defineProperty(globalThis, name, descriptor);
                else Reflect.deleteProperty(globalThis, name);
            }
        };
        container = document.createElement('div');
        document.body.append(container);
        root = createRoot(container);
    });

    afterEach(async () => {
        await act(async () => root.unmount());
        restore();
    });

    const render = (store: TurnMessageWindowStore | null, messages: ChatMessageEntry[], mountAll = false) => act(async () => root.render(
        <TurnMessageWindowContext.Provider value={store}>
            <TurnMessageWindow turnId="turn" messages={messages} renderMessage={renderMessage} mountAll={mountAll} />
        </TurnMessageWindowContext.Provider>,
    ));
    const mountedIds = () => Array.from(container.querySelectorAll('[data-message-id]'), (node) => node.getAttribute('data-message-id'));
    const spacer = () => container.querySelector('[data-turn-message-spacer]');

    test('a long turn mounts only its newest messages behind a spacer', async () => {
        const messages = steps(100);
        await render(createTurnMessageWindowStore(), messages);
        expect(mountedIds()).toEqual(messages.slice(-TURN_MESSAGE_WINDOW_TAIL).map((message) => message.info.id));
        expect(spacer()).not.toBeNull();
    });

    test('a turn at the threshold mounts every message', async () => {
        await render(createTurnMessageWindowStore(), steps(TURN_MESSAGE_WINDOW_THRESHOLD));
        expect(mountedIds()).toHaveLength(TURN_MESSAGE_WINDOW_THRESHOLD);
        expect(spacer()).toBeNull();
    });

    test('without a window store every message mounts', async () => {
        await render(null, steps(100));
        expect(mountedIds()).toHaveLength(100);
        expect(spacer()).toBeNull();
    });

    test('messages appended while the turn runs stay mounted', async () => {
        const store = createTurnMessageWindowStore();
        await render(store, steps(100));
        await render(store, steps(110));
        expect(mountedIds()).toHaveLength(TURN_MESSAGE_WINDOW_TAIL + 10);
        expect(mountedIds().at(-1)).toBe('step-109');
    });

    test('a remounted turn keeps the messages the reader already revealed', async () => {
        const store = createTurnMessageWindowStore();
        await render(store, steps(100));
        await act(async () => store.setHiddenCount('turn', 40));
        await act(async () => root.unmount());
        root = createRoot(container);
        await render(store, steps(100));
        expect(mountedIds()).toHaveLength(60);
        expect(mountedIds()[0]).toBe('step-40');
    });

    test('navigation mounts the whole turn through the store', async () => {
        const store = createTurnMessageWindowStore();
        await render(store, steps(100));
        await act(async () => store.setHiddenCount('turn', 0));
        expect(mountedIds()).toHaveLength(100);
        expect(spacer()).toBeNull();
    });

    test('a turn the reader opened mounts every message', async () => {
        await render(createTurnMessageWindowStore(), steps(100), true);
        expect(mountedIds()).toHaveLength(100);
    });
});

describe('reveal anchor', () => {
    const view = { viewTop: 0, viewBottom: 800 };

    test('holds the reader below the spacer', () => {
        expect(shouldHoldRevealAnchor({ ...view, spacerTop: -3000, firstMountedTop: -200 })).toBe(true);
    });

    test('holds the reader when a spacer above the viewport peeks into it', () => {
        expect(shouldHoldRevealAnchor({ ...view, spacerTop: -1200, firstMountedTop: 150 })).toBe(true);
    });

    test('lets a spacer that starts inside the viewport fill in place', () => {
        expect(shouldHoldRevealAnchor({ ...view, spacerTop: 300, firstMountedTop: 1500 })).toBe(false);
    });

    test('holds nothing when the spacer covers the whole viewport', () => {
        expect(shouldHoldRevealAnchor({ ...view, spacerTop: -500, firstMountedTop: 900 })).toBe(false);
    });
});
