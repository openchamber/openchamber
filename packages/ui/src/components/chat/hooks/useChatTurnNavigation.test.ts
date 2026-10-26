import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { useChatTurnNavigation } from './useChatTurnNavigation';

const withDom = async (url: string, run: (dom: Window) => Promise<void>) => {
    const dom = new Window({ url });
    const originals = new Map<string, PropertyDescriptor | undefined>();
    const globals = {
        window: dom, document: dom.document, navigator: dom.navigator,
        Element: dom.Element, HTMLElement: dom.HTMLElement, HTMLIFrameElement: dom.HTMLIFrameElement, Node: dom.Node,
        IS_REACT_ACT_ENVIRONMENT: true,
    };
    for (const [name, value] of Object.entries(globals)) {
        originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
        Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    }
    try {
        await run(dom);
    } finally {
        for (const [name, descriptor] of originals) {
            if (descriptor) Object.defineProperty(globalThis, name, descriptor);
            else Reflect.deleteProperty(globalThis, name);
        }
        await dom.happyDOM.close();
    }
};

const mountNavigation = async (initialTurnIds: string[]) => {
    const root = createRoot(document.createElement('div'));
    const scrolledTo: string[] = [];
    let sessionId = 'session_1';
    let turnIds = initialTurnIds;
    let navigation: ReturnType<typeof useChatTurnNavigation> | null = null;
    const Harness = () => {
        navigation = useChatTurnNavigation({
            sessionId,
            turnIds,
            activeTurnId: null,
            // Like the timeline controller: a turn that has not loaded yet cannot be reached.
            scrollToTurn: async (turnId) => {
                scrolledTo.push(turnId);
                return turnIds.includes(turnId);
            },
            scrollToMessage: async () => false,
            resumeToBottom: () => undefined,
        });
        return null;
    };
    const render = () => act(async () => root.render(React.createElement(Harness)));
    await render();
    return {
        scrolledTo,
        jumpTo: (turnId: string) => act(async () => { await navigation?.scrollToTurnId(turnId, { behavior: 'auto' }); }),
        setTurnIds: (next: string[]) => {
            turnIds = next;
            return render();
        },
        openSession: (nextSessionId: string, nextTurnIds: string[]) => {
            sessionId = nextSessionId;
            turnIds = nextTurnIds;
            return render();
        },
        unmount: () => act(async () => root.unmount()),
    };
};

test('a send after a navigator jump does not jump back to the old prompt', () => withDom('http://localhost/', async (dom) => {
    const harness = await mountNavigation(['turn_a', 'turn_b', 'turn_c']);
    await harness.jumpTo('turn_a');
    expect(dom.location.hash).toBe('#turn-turn_a');

    await harness.setTurnIds(['turn_a', 'turn_b', 'turn_c', 'turn_d']);

    expect(harness.scrolledTo).toEqual(['turn_a']);
    await harness.unmount();
}));

test('a link to a turn jumps once the turn loads, and only once', () => withDom('http://localhost/#turn-turn_a', async () => {
    const harness = await mountNavigation(['turn_b']);
    await harness.setTurnIds(['turn_a', 'turn_b']);
    await harness.setTurnIds(['turn_a', 'turn_b', 'turn_c']);

    expect(harness.scrolledTo).toEqual(['turn_a', 'turn_a']);
    await harness.unmount();
}));

test('coming back to a session with its hash still in the address jumps there again', () => withDom('http://localhost/', async () => {
    const harness = await mountNavigation(['turn_a', 'turn_b']);
    await harness.jumpTo('turn_a');
    await harness.openSession('session_2', ['turn_x']);
    await harness.openSession('session_1', ['turn_a', 'turn_b']);

    expect(harness.scrolledTo).toEqual(['turn_a', 'turn_a', 'turn_a']);
    await harness.unmount();
}));

test('a changed hash jumps even to a turn reached before', () => withDom('http://localhost/', async (dom) => {
    const harness = await mountNavigation(['turn_a', 'turn_b']);
    await harness.jumpTo('turn_a');
    for (const hash of ['#turn-turn_b', '#turn-turn_a']) {
        await act(async () => {
            dom.history.replaceState({}, '', `/${hash}`);
            dom.dispatchEvent(new dom.HashChangeEvent('hashchange'));
        });
    }

    expect(harness.scrolledTo).toEqual(['turn_a', 'turn_b', 'turn_a']);
    await harness.unmount();
}));
