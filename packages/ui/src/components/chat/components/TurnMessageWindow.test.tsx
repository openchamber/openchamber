import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import type { AssistantMessage, ToolPart } from '@/lib/opencode/model';
import type { ChatMessageEntry } from '../lib/turns/types';
import { ActivityRowSkipContext } from '../lib/turns/activityRows';
import {
    FULL_MESSAGE_WINDOW,
    TURN_ROW_WINDOW_SIZE,
    TURN_ROW_WINDOW_THRESHOLD,
    TurnMessageWindowContext,
    createTurnMessageWindowStore,
    openedFoldMessageWindow,
    resolveMountedMessages,
    shouldHoldRevealAnchor,
    type TurnMessageWindowStore,
} from '../lib/turns/turnMessageWindow';
import { TurnMessageWindow } from './TurnMessageWindow';

const toolCall = (messageID: string, index: number): ToolPart => ({
    id: `${messageID}-call-${index}`, callID: `${messageID}-call-${index}`, type: 'tool', tool: 'glob',
    messageID, sessionID: 'session',
    state: { status: 'completed', input: {}, output: '', metadata: {}, time: { start: 1, end: 2 } },
});

// A step with `rows` tool calls: one row each.
function assistant(id: string, rows = 1): ChatMessageEntry {
    const info: AssistantMessage = {
        id, sessionID: 'session', role: 'assistant', time: { created: 1, completed: 2 },
        modelID: 'model', providerID: 'provider', agent: 'build',
        cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, finish: 'tool-calls',
    };
    return { info, parts: Array.from({ length: rows }, (_, index) => toolCall(id, index)) };
}

const steps = (count: number, rows = 1): ChatMessageEntry[] => Array.from({ length: count }, (_, index) => assistant(`step-${index}`, rows));

function SkipProbe({ message }: { message: ChatMessageEntry }) {
    const skip = React.useContext(ActivityRowSkipContext);
    return <div data-message-id={message.info.id} data-skip={skip?.messageId === message.info.id ? skip.rows : 0} />;
}
const renderMessage = (message: ChatMessageEntry) => <SkipProbe key={message.info.id} message={message} />;

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

    const render = (store: TurnMessageWindowStore | null, messages: ChatMessageEntry[]) => act(async () => root.render(
        <TurnMessageWindowContext.Provider value={store}>
            <TurnMessageWindow turnId="turn" messages={messages} renderMessage={renderMessage} />
        </TurnMessageWindowContext.Provider>,
    ));
    const mountedIds = () => Array.from(container.querySelectorAll('[data-message-id]'), (node) => node.getAttribute('data-message-id'));
    const spacer = () => container.querySelector('[data-turn-message-spacer="head"]');
    const tailSpacer = () => container.querySelector('[data-turn-message-spacer="tail"]');

    test('a long turn mounts only its newest rows behind a spacer', async () => {
        const messages = steps(100);
        await render(createTurnMessageWindowStore(), messages);
        expect(mountedIds()).toEqual(messages.slice(-TURN_ROW_WINDOW_SIZE).map((message) => message.info.id));
        expect(spacer()).not.toBeNull();
    });

    test('a turn at the threshold mounts every row', async () => {
        await render(createTurnMessageWindowStore(), steps(TURN_ROW_WINDOW_THRESHOLD));
        expect(mountedIds()).toHaveLength(TURN_ROW_WINDOW_THRESHOLD);
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
        expect(mountedIds()).toHaveLength(TURN_ROW_WINDOW_SIZE + 10);
        expect(mountedIds().at(-1)).toBe('step-109');
    });

    test('a remounted turn keeps the messages the reader already revealed', async () => {
        const store = createTurnMessageWindowStore();
        await render(store, steps(100));
        await act(async () => store.setRange('turn', { hiddenHead: 30, hiddenTail: 0 }));
        await act(async () => root.unmount());
        root = createRoot(container);
        await render(store, steps(100));
        expect(mountedIds()).toHaveLength(70);
        expect(mountedIds()[0]).toBe('step-30');
    });

    test('navigation mounts the whole turn through the store', async () => {
        const store = createTurnMessageWindowStore();
        await render(store, steps(100));
        await act(async () => store.setRange('turn', FULL_MESSAGE_WINDOW));
        expect(mountedIds()).toHaveLength(100);
        expect(spacer()).toBeNull();
    });

    test('an opened fold mounts its first steps above a tail spacer', async () => {
        const store = createTurnMessageWindowStore();
        store.setRange('turn', openedFoldMessageWindow(100));
        const messages = steps(100);
        await render(store, messages);
        expect(mountedIds()).toEqual(messages.slice(0, TURN_ROW_WINDOW_SIZE).map((message) => message.info.id));
        expect(spacer()).toBeNull();
        expect(tailSpacer()).not.toBeNull();
    });

    test('revealing the tail mounts the steps below the window', async () => {
        const store = createTurnMessageWindowStore();
        store.setRange('turn', openedFoldMessageWindow(100));
        await render(store, steps(100));
        await act(async () => store.setRange('turn', { hiddenHead: 0, hiddenTail: 30 }));
        expect(mountedIds()).toHaveLength(70);
        expect(mountedIds().at(-1)).toBe('step-69');
    });

    test('a step with many parallel calls is windowed inside the step', async () => {
        // Three steps of 50 calls: 150 rows, of which the newest 40 mount.
        const messages = steps(3, 50);
        await render(createTurnMessageWindowStore(), messages);
        expect(mountedIds()).toEqual(['step-2']);
        expect(container.querySelector('[data-message-id="step-2"]')?.getAttribute('data-skip')).toBe('10');
        // Navigation reads the cut from the spacer: step-2's top is not its start.
        expect(spacer()?.getAttribute('data-turn-message-cut')).toBe('step-2');
    });

    test('the step the head cuts into keeps its tree when the head reveals it whole', async () => {
        const store = createTurnMessageWindowStore();
        await render(store, steps(3, 50));
        const cut = container.querySelector('[data-message-id="step-2"]');
        await act(async () => store.setRange('turn', { hiddenHead: 100, hiddenTail: 0 }));
        expect(container.querySelector('[data-message-id="step-2"]')).toBe(cut);
        expect(cut?.getAttribute('data-skip')).toBe('0');
        expect(spacer()?.hasAttribute('data-turn-message-cut')).toBe(false);
    });
});

describe('turn message window inside a folded live activity', () => {
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

    test('rows the fold already skips do not open a window, and its skip reaches the message', async () => {
        // One step of 100 parallel calls; the fold shows its last 7.
        await act(async () => root.render(
            <TurnMessageWindowContext.Provider value={createTurnMessageWindowStore()}>
                <ActivityRowSkipContext.Provider value={{ messageId: 'step-0', rows: 93 }}>
                    <TurnMessageWindow turnId="turn" messages={steps(1, 100)} renderMessage={renderMessage} />
                </ActivityRowSkipContext.Provider>
            </TurnMessageWindowContext.Provider>,
        ));
        expect(container.querySelector('[data-turn-message-spacer]')).toBeNull();
        expect(container.querySelector('[data-message-id="step-0"]')?.getAttribute('data-skip')).toBe('93');
    });

    test('a window cutting into the message the fold cuts into skips both', async () => {
        const store = createTurnMessageWindowStore();
        store.setRange('turn', { hiddenHead: 10, hiddenTail: 0 });
        await act(async () => root.render(
            <TurnMessageWindowContext.Provider value={store}>
                <ActivityRowSkipContext.Provider value={{ messageId: 'step-0', rows: 20 }}>
                    <TurnMessageWindow turnId="turn" messages={steps(1, 100)} renderMessage={renderMessage} />
                </ActivityRowSkipContext.Provider>
            </TurnMessageWindowContext.Provider>,
        ));
        expect(container.querySelector('[data-message-id="step-0"]')?.getAttribute('data-skip')).toBe('30');
    });
});

describe('mounted messages of a row range', () => {
    test('the head hides whole messages and cuts into the next one', () => {
        expect(resolveMountedMessages([3, 3, 4, 2], { hiddenHead: 5, hiddenTail: 0 }))
            .toEqual({ headMessages: 1, headSkipRows: 2, tailMessages: 0, hiddenHeadRows: 5, hiddenTailRows: 0 });
        expect(resolveMountedMessages([3, 3, 4, 2], { hiddenHead: 6, hiddenTail: 0 }))
            .toEqual({ headMessages: 2, headSkipRows: 0, tailMessages: 0, hiddenHeadRows: 6, hiddenTailRows: 0 });
    });

    test('the tail hides whole messages only and never the one the head cuts into', () => {
        expect(resolveMountedMessages([3, 3, 4, 2], { hiddenHead: 0, hiddenTail: 5 }))
            .toEqual({ headMessages: 0, headSkipRows: 0, tailMessages: 1, hiddenHeadRows: 0, hiddenTailRows: 2 });
        expect(resolveMountedMessages([10, 10], { hiddenHead: 5, hiddenTail: 20 }))
            .toEqual({ headMessages: 0, headSkipRows: 5, tailMessages: 1, hiddenHeadRows: 5, hiddenTailRows: 10 });
    });

    test('a range larger than the turn hides at most every row', () => {
        expect(resolveMountedMessages([2, 2], { hiddenHead: 10, hiddenTail: 0 }))
            .toEqual({ headMessages: 2, headSkipRows: 0, tailMessages: 0, hiddenHeadRows: 4, hiddenTailRows: 0 });
    });
});

describe('opened fold window', () => {
    test('a short fold opens whole', () => {
        expect(openedFoldMessageWindow(TURN_ROW_WINDOW_THRESHOLD)).toEqual(FULL_MESSAGE_WINDOW);
    });

    test('a long fold opens at its first steps, under the header', () => {
        const hidden = TURN_ROW_WINDOW_THRESHOLD + 1 - TURN_ROW_WINDOW_SIZE;
        expect(openedFoldMessageWindow(TURN_ROW_WINDOW_THRESHOLD + 1)).toEqual({ hiddenHead: 0, hiddenTail: hidden });
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
