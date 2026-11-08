import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import { useChatTimelineScroll, type TimelineListHandle } from './useChatTimelineScroll';
import { requestMessageFocus, releaseMessageFocusOutside } from '@/lib/router/messageFocus';
import { dispatchPageWaiting, dispatchTabStep } from '@/components/chat/lib/scroll/timelineScrollIntent';
import { isWaitingPageRevealPending, releaseWaitingPageRevealOutside, revealWaitingPage } from '@/sync/request-reveal';
import { useUIStore } from '@/stores/useUIStore';
import { KeepAlive } from '@/components/ui/KeepAlive';
import { readSessionScrollPosition, rememberSessionScrollPosition } from '@/components/chat/lib/scroll/sessionScrollMemory';
import type { MessageViewportAnchor } from '@/components/chat/lib/scroll/messageViewportAnchor';

let root: Root;
let node: HTMLDivElement;
let scroll: ReturnType<typeof useChatTimelineScroll>;
let frames: Map<number, FrameRequestCallback>;
let subscribers: Set<() => void>;
let writes: number;
let listOffsets: number[];
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
            scrollToEnd: () => { writes += 1; }, scrollToOffset: ({ offset }) => { listOffsets.push(offset); }, scrollToIndex: () => {},
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
    frames = new Map(); subscribers = new Set(); writes = 0; listOffsets = []; loads = 0; missing = 0; checkLinkedMessage = undefined; contentLength = 2000; working = true;
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
        CSS: dom.CSS,
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

for (const leaving of ['first reading position', 'changed reading position', 'end'] as const) {
    test(`captures ${leaving} before a retained transcript hides and restores on return`, async () => {
        const key = `retained-${leaving}`;
        rememberSessionScrollPosition(key, leaving === 'first reading position' ? null : { messageId: 'message', offsetTop: -10 });
        let aNode: HTMLElement | null = null;
        const alignments: MessageViewportAnchor[] = [];
        type AnchorHandle = { alignViewportAnchor: (anchor: MessageViewportAnchor) => 'aligned' };

        function RetainedList({ name, register, anchorRef }: {
            name: string;
            register: (list: TimelineListHandle | null) => void;
            anchorRef: React.RefObject<AnchorHandle | null>;
        }) {
            const ref = React.useRef<HTMLDivElement>(null);
            React.useLayoutEffect(() => {
                const element = ref.current!.parentElement;
                if (!element) throw new Error('Missing retained list host');
                if (name === key) aNode = element;
                const hidden = () => {
                    for (let parent: HTMLElement | null = element; parent; parent = parent.parentElement) {
                        if (parent.style.display === 'none') return true;
                    }
                    return false;
                };
                Object.defineProperties(element, {
                    scrollHeight: { configurable: true, value: 2000 },
                    clientHeight: { configurable: true, value: 500 },
                });
                element.getBoundingClientRect = () => new dom.DOMRect(0, 0, 800, hidden() ? 0 : 500);
                element.firstElementChild!.getBoundingClientRect = () => hidden()
                    ? new dom.DOMRect()
                    : new dom.DOMRect(0, 700 - element.scrollTop, 800, 1000);
                const handle: AnchorHandle = {
                    alignViewportAnchor: (anchor) => {
                        alignments.push(anchor);
                        element.scrollTop = 700 - anchor.offsetTop;
                        return 'aligned';
                    },
                };
                anchorRef.current = handle;
                register({
                    getScrollableNode: () => element,
                    getState: () => ({
                        data: [], scroll: element.scrollTop, scrollLength: 500, contentLength: 2000,
                        positionAtIndex: () => undefined, sizeAtIndex: () => undefined,
                    }),
                    scrollToEnd: () => { element.scrollTop = 1500; },
                    scrollToOffset: () => {}, scrollToIndex: () => {},
                });
                return () => {
                    if (anchorRef.current === handle) anchorRef.current = null;
                };
            }, [name, register, anchorRef]);
            // Retained lists can unregister after Activity has hidden their
            // host. Keep the detach on that lifecycle edge in this fixture.
            React.useEffect(() => () => register(null), [register]);
            return <div ref={ref} data-message-id="message" />;
        }
        function RetainedHarness({ name }: { name: string }) {
            const anchorRef = React.useRef<AnchorHandle | null>(null);
            scroll = useChatTimelineScroll({
                currentSessionId: name, currentSessionKey: name, composerOverlayHeight: 0,
                messageListRef: anchorRef, sessionIsWorking: false,
            });
            const { registerList, captureOutgoingPosition } = scroll;
            const register = React.useCallback((list: TimelineListHandle | null) => registerList(list, name), [registerList, name]);
            return <KeepAlive cacheKey={name} capacity={4} onBeforeHide={captureOutgoingPosition}>
                <div><RetainedList name={name} register={register} anchorRef={anchorRef} /></div>
            </KeepAlive>;
        }
        const select = (name: string) => act(async () => root.render(<RetainedHarness name={name} />));
        await select(key);
        await frame();
        // Finish any entry alignment before the reader changes position.
        for (let index = 0; index < 35; index += 1) await frame();
        const outgoing = aNode!;
        act(() => outgoing.dispatchEvent(new WheelEvent('wheel', { deltaY: -100 })));
        outgoing.scrollTop = leaving === 'end' ? 1500 : 730;
        if (leaving === 'end') {
            act(() => scroll.onIsAtEndChange(true));
            await frame();
        }
        alignments.length = 0;
        await select(`${key}-B`);
        expect(outgoing.style.display).toBe('none');
        expect(readSessionScrollPosition(key)).toEqual(leaving === 'end' ? null : { messageId: 'message', offsetTop: -30 });
        outgoing.scrollTop = 0;
        await select(key);
        await frame();
        expect(aNode).toBe(outgoing);
        expect(outgoing.scrollTop).toBe(leaving === 'end' ? 1500 : 730);
        if (leaving !== 'end') expect(alignments.at(-1)).toEqual({ messageId: 'message', offsetTop: -30 });
    });
}

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

test('the toast of a waiting page brings it to a reader who scrolled away, even if it came before', async () => {
    await render('visible'); await frame();
    node.scrollTop = 300;
    const { block, targets } = waitingPage();
    act(() => dispatchPageWaiting(block));
    await frame();
    expect(targets).toEqual([1300]);
    node.scrollTop = 300;
    act(() => { node.dispatchEvent(new WheelEvent('wheel', { deltaY: -100 })); });
    await frame();

    act(() => revealWaitingPage('session'));
    await frame();

    expect(targets).toEqual([1300, 1300]);
});

test('the toast of a waiting page is not served to another session, and a later entry drops it', async () => {
    await render('visible'); await frame();
    node.scrollTop = 300;
    const { targets } = waitingPage();
    act(() => revealWaitingPage('other'));
    await frame();
    expect(targets).toEqual([]);
    expect(isWaitingPageRevealPending('other')).toBe(true);
    releaseWaitingPageRevealOutside('session');
    expect(isWaitingPageRevealPending('other')).toBe(false);
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

describe('Next on a waiting form\'s Tabs', () => {
    // The reader sits at the end, the bottom of a 700 px tab in a 500 px viewport.
    const atEndOfTallTab = async () => {
        await render('visible'); await frame();
        node.scrollTop = 1500;
        return waitingPage(1100);
    };

    test('brings the start of the next tab into view from the end of a tab taller than the screen', async () => {
        const { block, targets } = await atEndOfTallTab();
        act(() => dispatchTabStep(block));
        await frame();
        expect(targets).toEqual([1088]);
        expect(listOffsets).toEqual([1500]);
    });

    test('moves a reader who scrolled up, or who turned auto-follow off', async () => {
        useUIStore.getState().setStreamingAutoFollowEnabled(false);
        try {
            const { block, targets } = await atEndOfTallTab();
            act(() => { node.dispatchEvent(new WheelEvent('wheel', { deltaY: -100 })); });
            act(() => dispatchTabStep(block));
            await frame();
            expect(targets).toEqual([1088]);
        } finally {
            useUIStore.getState().setStreamingAutoFollowEnabled(true);
        }
    });

    test('aims again as the list grows, until the reader scrolls', async () => {
        const { block, targets } = await atEndOfTallTab();
        act(() => dispatchTabStep(block));
        await frame();
        node.scrollTop = 1400;
        act(() => scroll.onTimelineDataChange());
        await frame();
        expect(targets).toEqual([1088, 1088]);
        act(() => { node.dispatchEvent(new WheelEvent('wheel', { deltaY: -100 })); });
        act(() => scroll.onTimelineDataChange());
        await frame();
        expect(targets.length).toBe(2);
    });

    test('a height report from the page keeps the aim on the tab', async () => {
        const { block, targets } = await atEndOfTallTab();
        act(() => dispatchPageWaiting(block));
        await frame();
        const tabs = document.createElement('div');
        block.append(tabs);
        Object.defineProperty(tabs, 'getBoundingClientRect', { value: () => ({ top: 1250 - node.scrollTop, bottom: 1800 - node.scrollTop }) });
        act(() => dispatchTabStep(tabs));
        act(() => dispatchPageWaiting(block));
        await frame();
        expect(targets.at(-1)).toBe(1238);
    });
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
