import { afterEach, beforeEach, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { useChatTimelineScroll, type TimelineListHandle } from './useChatTimelineScroll';
import { requestMessageFocus, releaseMessageFocusOutside } from '@/lib/router/messageFocus';

let root: Root;
let node: HTMLDivElement;
let scroll: ReturnType<typeof useChatTimelineScroll>;
let frames: Map<number, FrameRequestCallback>;
let subscribers: Set<() => void>;
let writes: number;
let loads: number;
let missing: number;
let checkLinkedMessage: (() => Promise<'exists' | 'missing'>) | undefined;
let dom: Window;
const descriptors = new Map<string, PropertyDescriptor | undefined>();

function Harness() {
    scroll = useChatTimelineScroll({
        currentSessionId: 'session', currentSessionKey: 'runtime\n/repo\nsession', composerOverlayHeight: 0,
        messageListRef: { current: { alignViewportAnchor: () => 'missing' } }, sessionIsWorking: true,
        checkLinkedMessage,
        loadHistoryUntilMessage: async () => { loads += 1; return false; },
        onLinkedMessageMissing: () => { missing += 1; },
    });
    const { registerList } = scroll;
    React.useLayoutEffect(() => {
        const list: TimelineListHandle = {
            getScrollableNode: () => node,
            getState: () => ({
                data: [], scroll: node.scrollTop, scrollLength: 500, contentLength: 2000,
                positionAtIndex: () => undefined, sizeAtIndex: () => undefined,
                listen: (_type, callback) => {
                    const notify = () => callback(2000);
                    subscribers.add(notify);
                    return () => { subscribers.delete(notify); };
                },
            }),
            scrollToEnd: () => { writes += 1; }, scrollToOffset: () => {}, scrollToIndex: () => {},
        };
        registerList(list);
        return () => registerList(null);
    }, [registerList]);
    return null;
}

const render = async (mode: 'visible' | 'hidden') => {
    await act(async () => root.render(<React.Activity mode={mode}><Harness /></React.Activity>));
};
const frame = async () => {
    const pending = [...frames.values()];
    frames.clear();
    await act(async () => { for (const callback of pending) callback(performance.now()); });
};

beforeEach(() => {
    dom = new Window({ url: 'https://app.test' });
    frames = new Map(); subscribers = new Set(); writes = 0; loads = 0; missing = 0; checkLinkedMessage = undefined;
    let nextFrame = 0;
    const request = (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame; };
    const cancel = (id: number) => { frames.delete(id); };
    Object.assign(dom, { requestAnimationFrame: request, cancelAnimationFrame: cancel });
    const globals = {
        window: dom,
        document: dom.document,
        HTMLElement: dom.HTMLElement,
        Element: dom.Element,
        localStorage: dom.localStorage,
        sessionStorage: dom.sessionStorage,
        getComputedStyle: dom.getComputedStyle.bind(dom),
        requestAnimationFrame: request,
        cancelAnimationFrame: cancel,
        MutationObserver: undefined,
        ResizeObserver: undefined,
        IS_REACT_ACT_ENVIRONMENT: true,
    };
    for (const [name, value] of Object.entries(globals)) {
        descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
        Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    }
    node = document.createElement('div'); document.body.append(node);
    Object.defineProperties(node, { scrollHeight: { value: 2000 }, clientHeight: { value: 500 } });
    node.scrollTo = () => { writes += 1; };
    const host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
    await act(async () => root.unmount());
    releaseMessageFocusOutside(null);
    for (const [name, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
    }
    descriptors.clear();
    await dom.happyDOM.close();
});

test('cancels a pending follow frame and can schedule again after effect reconnect', async () => {
    await render('visible'); await frame();
    node.scrollTop = 100;
    act(() => scroll.onTimelineDataChange());
    expect(frames.size).toBe(1);
    const stale = [...frames.values()];
    await render('hidden');
    expect(frames.size).toBe(0);
    expect(subscribers.size).toBe(0);
    await render('visible'); await frame();
    expect(subscribers.size).toBe(1);
    node.scrollTop = 100;
    const before = writes;
    act(() => { for (const callback of stale) callback(performance.now()); });
    expect(writes).toBe(before);
    act(() => { scroll.onTimelineDataChange(); scroll.onTimelineDataChange(); });
    expect(frames.size).toBe(1);
    await frame();
    expect(writes).toBe(before + 1);
});

test('clears return-to-end reassert timers across a hidden interval', async () => {
    await render('visible'); await frame();
    act(() => scroll.goToBottom());
    const before = writes;
    await render('hidden');
    await new Promise((resolve) => setTimeout(resolve, 0));
    await render('visible'); await frame();
    node.scrollTop = 100;
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 850)); });
    expect(writes).toBe(before);
    act(() => scroll.goToBottom());
    node.scrollTop = 100;
    expect(writes).toBe(before + 1);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 850)); });
    expect(writes).toBe(before + 4);
});

test('does not start a history search from a linked-message check completed after cleanup', async () => {
    let complete!: (value: 'exists') => void;
    checkLinkedMessage = () => new Promise((resolve) => { complete = resolve; });
    await render('visible'); await frame();
    act(() => requestMessageFocus('session', 'old-message'));
    await render('hidden');
    await act(async () => complete('exists'));
    expect(loads).toBe(0);
    expect(missing).toBe(0);
});
