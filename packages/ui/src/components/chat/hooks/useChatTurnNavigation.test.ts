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
        // Mirror the production caller: useChatTimelineController hands the
        // hook useCallback-stable scroll functions, so keep these identities
        // stable across renders too. Fresh inline arrows change identity on
        // every render and re-run the hook's hash effect, replaying a
        // not-yet-reached hash scroll. The closures read the harness's
        // mutable turnIds binding, so a stable identity still sees the
        // latest turns.
        const scrollToTurn = React.useCallback(async (turnId: string) => {
            scrolledTo.push(turnId);
            return turnIds.includes(turnId);
        }, []);
        const scrollToMessage = React.useCallback(async () => false, []);
        const resumeToBottom = React.useCallback(() => undefined, []);
        navigation = useChatTurnNavigation({
            sessionId,
            turnIds,
            activeTurnId: null,
            // Like the timeline controller: a turn that has not loaded yet cannot be reached.
            scrollToTurn,
            scrollToMessage,
            resumeToBottom,
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

test('coming back to a session with its hash still in the address jumps there again', () => withDom('http://localhost/', async (dom) => {
    const harness = await mountNavigation(['turn_a', 'turn_b']);
    await harness.jumpTo('turn_a');
    // happy-dom delivers an asynchronous hashchange for the jump's own
    // replaceState hash write (real browsers never fire one for
    // replaceState). Drain the DOM task queue before switching sessions:
    // while still in session_1 the hook's already-reached guard absorbs
    // that stale event, but if it lands after the switch -- when the
    // reached record has been reset and the hash is unreached in the new
    // session -- it replays the scroll and adds an extra attempt.
    await dom.happyDOM.waitUntilComplete();
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
