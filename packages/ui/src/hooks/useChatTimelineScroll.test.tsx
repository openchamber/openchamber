import { afterEach, beforeEach, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { useChatTimelineScroll, type TimelineListHandle } from './useChatTimelineScroll';
import { requestMessageFocus, releaseMessageFocusOutside } from '@/lib/router/messageFocus';
import { dispatchPageWaiting } from '@/components/chat/lib/scroll/timelineScrollIntent';
import { useUIStore } from '@/stores/useUIStore';

let root: Root;
let node: HTMLDivElement;
let scroll: ReturnType<typeof useChatTimelineScroll>;
let frames: Map<number, FrameRequestCallback>;
let subscribers: Set<() => void>;
let writes: number;
let loads: number;
let missing: number;
let checkLinkedMessage: (() => Promise<'exists' | 'missing'>) | undefined;
let contentLength: number;
let working: boolean;
let dom: Window;
const descriptors = new Map<string, PropertyDescriptor | undefined>();

function Harness() {
    scroll = useChatTimelineScroll({
        currentSessionId: 'session', currentSessionKey: 'runtime\n/repo\nsession', composerOverlayHeight: 0,
        messageListRef: { current: { alignViewportAnchor: () => 'missing' } }, sessionIsWorking: working,
        checkLinkedMessage,
        loadHistoryUntilMessage: async () => { loads += 1; return false; },
        onLinkedMessageMissing: () => { missing += 1; },
    });
    const { registerList } = scroll;
    React.useLayoutEffect(() => {
        const list: TimelineListHandle = {
            getScrollableNode: () => node,
            getState: () => ({
                data: [], scroll: node.scrollTop, scrollLength: 500, contentLength,
                positionAtIndex: () => undefined, sizeAtIndex: () => undefined,
                listen: (_type, callback) => {
                    const notify = () => callback(contentLength);
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
    frames = new Map(); subscribers = new Set(); writes = 0; loads = 0; missing = 0; checkLinkedMessage = undefined; contentLength = 2000; working = true;
    let nextFrame = 0;
    const request = (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame; };
    const cancel = (id: number) => { frames.delete(id); };
    Object.assign(dom, { requestAnimationFrame: request, cancelAnimationFrame: cancel });
    const globals = {
        window: dom,
        document: dom.document,
        HTMLElement: dom.HTMLElement,
        Element: dom.Element,
        CustomEvent: dom.CustomEvent,
        WheelEvent: dom.WheelEvent,
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

// A waiting page whose block sits at content offsets `top` to 1800, below
// the 500 px viewport; scroll commands are recorded.
const waitingPage = (top = 1700) => {
    const block = document.createElement('div');
    block.dataset.waitingPage = 'page-1';
    node.append(block);
    Object.defineProperty(block, 'getBoundingClientRect', { value: () => ({ top: top - node.scrollTop, bottom: 1800 - node.scrollTop }) });
    const targets: number[] = [];
    Object.defineProperty(node, 'scrollTo', { value: (options: ScrollToOptions) => { targets.push(options.top ?? Number.NaN); } });
    return { block, targets };
};

test('brings a page waiting for an answer into view for a reader nothing released', async () => {
    await render('visible'); await frame();
    node.scrollTop = 300;
    const { block, targets } = waitingPage();
    act(() => dispatchPageWaiting(block));
    await frame();
    expect(targets).toEqual([1300]);
});

test('a return to the end ends the reveal of a page taller than the screen', async () => {
    await render('visible'); await frame();
    node.scrollTop = 300;
    const { block, targets } = waitingPage(1100);
    act(() => dispatchPageWaiting(block));
    await frame();
    expect(targets.length).toBe(1);
    act(() => scroll.goToBottom());
    act(() => dispatchPageWaiting(block));
    await frame();
    expect(targets.length).toBe(1);
});

test('leaves a reader with auto-follow off where they are when a page waits for an answer', async () => {
    useUIStore.getState().setStreamingAutoFollowEnabled(false);
    try {
        await render('visible'); await frame();
        node.scrollTop = 300;
        const { block, targets } = waitingPage();
        act(() => dispatchPageWaiting(block));
        await frame();
        expect(targets).toEqual([]);
    } finally {
        useUIStore.getState().setStreamingAutoFollowEnabled(true);
    }
});

test('leaves a reader who scrolled up away from a page waiting for an answer', async () => {
    await render('visible'); await frame();
    node.scrollTop = 300;
    act(() => { node.dispatchEvent(new WheelEvent('wheel', { deltaY: -100 })); });
    const { block, targets } = waitingPage();
    act(() => dispatchPageWaiting(block));
    await frame();
    expect(targets).toEqual([]);
});

// The list reports a new total before it moves the viewport for rows above
// the reader that measured smaller; in between, the reader reads as on the end.
test('rows above a reader measuring smaller do not bring them back to the end', async () => {
    await render('visible'); await frame();
    node.scrollTop = 1300;
    act(() => { node.dispatchEvent(new WheelEvent('wheel', { deltaY: -100 })); });
    expect(scroll.userOwnsScroll).toBe(true);
    await act(async () => {
        contentLength = 1700;
        scroll.onTimelineDataChange();
        node.scrollTop = 1000;
    });
    await frame();
    expect(scroll.userOwnsScroll).toBe(true);
});

test('content closing below a reader brings the end to them', async () => {
    await render('visible'); await frame();
    node.scrollTop = 1300;
    act(() => { node.dispatchEvent(new WheelEvent('wheel', { deltaY: -100 })); });
    await act(async () => {
        contentLength = 1700;
        node.scrollTop = 1200;
        scroll.onTimelineDataChange();
    });
    await frame();
    expect(scroll.userOwnsScroll).toBe(false);
});

test('a check waiting for its frame sees the end a later gesture and closing row brought', async () => {
    await render('visible'); await frame();
    node.scrollTop = 1300;
    act(() => { node.dispatchEvent(new WheelEvent('wheel', { deltaY: -100 })); });
    await act(async () => {
        contentLength = 1700;
        scroll.onTimelineDataChange();
        node.scrollTop = 1000;
    });
    act(() => { node.dispatchEvent(new WheelEvent('wheel', { deltaY: -100 })); });
    await act(async () => {
        node.scrollTop = 1200;
        scroll.onTimelineDataChange();
    });
    await frame();
    expect(scroll.userOwnsScroll).toBe(false);
});

// A turn ending cuts its long answer into rows the list counts at estimated
// heights until measured; the list reports the end with screens still below.
test('an end the list reports mid-pass does not bring a released reader down', async () => {
    working = false;
    await render('visible'); await frame();
    node.scrollTop = 1300;
    act(() => { node.dispatchEvent(new WheelEvent('wheel', { deltaY: -100 })); });
    await act(async () => {
        contentLength = 1800;
        scroll.onIsAtEndChange(true);
        contentLength = 2000;
    });
    await frame();
    expect(scroll.userOwnsScroll).toBe(true);
});

test('a released reader who scrolls to the end is followed again', async () => {
    await render('visible'); await frame();
    node.scrollTop = 1300;
    act(() => { node.dispatchEvent(new WheelEvent('wheel', { deltaY: -100 })); });
    await act(async () => {
        node.scrollTop = 1500;
        scroll.onIsAtEndChange(true);
    });
    await frame();
    expect(scroll.userOwnsScroll).toBe(false);
});

test('while the turn runs, a reader who scrolls back to the end is followed at once', async () => {
    await render('visible'); await frame();
    node.scrollTop = 1300;
    act(() => { node.dispatchEvent(new WheelEvent('wheel', { deltaY: -100 })); });
    await act(async () => {
        node.scrollTop = 1500;
        scroll.onIsAtEndChange(true);
        contentLength = 2200;
    });
    expect(scroll.userOwnsScroll).toBe(false);
});
