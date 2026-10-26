import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import type { Message } from '@/lib/opencode/model';

import {
    isOlderHistoryPrependCommit,
    useChatTimelineController,
    type UseChatTimelineControllerResult,
} from './useChatTimelineController';
import type { MessageListHandle } from '../MessageList';
import type { ChatMessageEntry } from '../lib/turns/types';

describe('isOlderHistoryPrependCommit', () => {
    test('detects older messages inserted above the existing timeline', () => {
        expect(isOlderHistoryPrependCommit({
            previousOldestId: 'msg_2',
            previousNewestId: 'msg_4',
            currentOldestId: 'msg_1',
            currentNewestId: 'msg_4',
        })).toBe(true);
    });

    test('does not treat appends or replacements as prepends', () => {
        expect(isOlderHistoryPrependCommit({
            previousOldestId: 'msg_2',
            previousNewestId: 'msg_4',
            currentOldestId: 'msg_2',
            currentNewestId: 'msg_5',
        })).toBe(false);
        expect(isOlderHistoryPrependCommit({
            previousOldestId: 'msg_2',
            previousNewestId: 'msg_4',
            currentOldestId: 'msg_1',
            currentNewestId: 'msg_5',
        })).toBe(false);
    });
});

const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((next) => {
        resolve = next;
    });
    return { promise, resolve };
};

const installMinimalDom = () => {
    const descriptors = new Map<string, PropertyDescriptor | undefined>();
    const setGlobal = (name: string, value: unknown) => {
        descriptors.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
        Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    };
    class ElementStub {}
    const documentStub: Record<string, unknown> = {
        nodeType: 9,
        defaultView: globalThis,
        activeElement: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
    };
    const container = {
        nodeType: 1,
        tagName: 'DIV',
        nodeName: 'DIV',
        namespaceURI: 'http://www.w3.org/1999/xhtml',
        ownerDocument: documentStub,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
    };
    documentStub.documentElement = container;
    documentStub.body = container;
    setGlobal('document', documentStub);
    setGlobal('window', globalThis);
    setGlobal('location', { search: '', protocol: 'http:', hostname: 'localhost' });
    setGlobal('Element', ElementStub);
    setGlobal('HTMLElement', ElementStub);
    setGlobal('HTMLIFrameElement', ElementStub);
    setGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    setGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0));
    setGlobal('cancelAnimationFrame', (id: ReturnType<typeof setTimeout>) => clearTimeout(id));
    return {
        container: container as unknown as Element,
        restore: () => {
            for (const [name, descriptor] of descriptors) {
                if (descriptor) Object.defineProperty(globalThis, name, descriptor);
                else Reflect.deleteProperty(globalThis, name);
            }
        },
    };
};

describe('loadHistoryUntilMessage', () => {
    const userMessage = (id: string, created: number): ChatMessageEntry => {
        const info: Message = { id, sessionID: 'session', role: 'user', time: { created } };
        return { info, parts: [] };
    };

    // Real scheduling instead of act: the loader waits for the render that
    // publishes each page, which act would hold back until its scope ends.
    const renderHarness = (options: {
        pages: ChatMessageEntry[][];
        complete?: boolean;
    }) => {
        const dom = installMinimalDom();
        Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { configurable: true, writable: true, value: false });
        const root = createRoot(dom.container);
        let messages: ChatMessageEntry[] = [userMessage('msg_9', 9)];
        let calls = 0;
        let controller!: UseChatTimelineControllerResult;
        const Harness = () => {
            controller = useChatTimelineController({
                sessionId: 'session', sessionKey: 'runtime\n/repo\nsession', messages,
                historyMeta: { limit: messages.length, complete: options.complete === true, loading: false },
                scrollRef: { current: null }, messageListRef: { current: null }, isPinned: true, showScrollButton: false,
                loadMoreMessages: async () => {
                    const page = options.pages[calls] ?? [];
                    calls += 1;
                    messages = [...page, ...messages];
                    root.render(React.createElement(Harness));
                },
                goToBottom: () => undefined, releaseAutoFollow: () => undefined,
            });
            return null;
        };
        root.render(React.createElement(Harness));
        return {
            get controller() { return controller; },
            get calls() { return calls; },
            ready: () => new Promise((resolve) => setTimeout(resolve, 20)),
            dispose: () => {
                root.unmount();
                dom.restore();
            },
        };
    };

    test('loads older batches until the message arrives', async () => {
        const harness = renderHarness({ pages: [[userMessage('msg_5', 5)], [userMessage('msg_1', 1)]] });
        try {
            await harness.ready();
            expect(await harness.controller.loadHistoryUntilMessage('msg_1', { maxBatches: 3 })).toBe(true);
            expect(harness.calls).toBe(2);
        } finally {
            harness.dispose();
        }
    });

    test('gives up after the batch limit when the message never arrives', async () => {
        const harness = renderHarness({ pages: [[userMessage('msg_5', 5)], [userMessage('msg_4', 4)], [userMessage('msg_3', 3)], [userMessage('msg_2', 2)]] });
        try {
            await harness.ready();
            expect(await harness.controller.loadHistoryUntilMessage('reverted', { maxBatches: 3 })).toBe(false);
            expect(harness.calls).toBe(3);
        } finally {
            harness.dispose();
        }
    });

    test('loads nothing when the history is already complete', async () => {
        const harness = renderHarness({ pages: [], complete: true });
        try {
            await harness.ready();
            expect(await harness.controller.loadHistoryUntilMessage('msg_1', { maxBatches: 3 })).toBe(false);
            expect(harness.calls).toBe(0);
        } finally {
            harness.dispose();
        }
    });
});

describe('useChatTimelineController identity lifecycle', () => {
    test('cancels the mobile prepend watchdog on hide and recreates it for a new prepend', async () => {
        const dom = installMinimalDom();
        const root = createRoot(dom.container);
        const previousRequest = window.requestAnimationFrame;
        const previousCancel = window.cancelAnimationFrame;
        const frames = new Map<number, FrameRequestCallback>();
        let nextFrame = 0;
        window.requestAnimationFrame = (callback) => { frames.set(++nextFrame, callback); return nextFrame; };
        window.cancelAnimationFrame = (id) => { frames.delete(id); };
        window.location.search = '?surface=mobile';
        const browser = new Window();
        Object.defineProperty(globalThis, 'document', { configurable: true, writable: true, value: browser.document });
        const container = document.createElement('div');
        let height = 1000;
        Object.defineProperties(container, { scrollHeight: { get: () => height }, clientHeight: { value: 500 } });
        container.scrollTop = 100;
        let messages: ChatMessageEntry[] = [{ info: { id: 'new', sessionID: 'session', role: 'user', time: { created: 3 } }, parts: [] }];
        let controller!: UseChatTimelineControllerResult;
        const list: MessageListHandle = {
            captureViewportAnchor: () => null, restoreViewportAnchor: () => false, alignViewportAnchor: () => 'missing',
            isHistoryVirtualized: () => false, scrollToTurnId: () => false, scrollToMessageId: () => false,
            holdViewportAnchor: () => {}, scrollToBottom: () => {},
        };
        const Harness = () => {
            controller = useChatTimelineController({
                sessionId: 'session', sessionKey: 'runtime\n/repo\nsession', messages,
                historyMeta: { limit: 1, complete: false, loading: false },
                scrollRef: { current: container }, messageListRef: { current: list }, isPinned: false, showScrollButton: false,
                loadMoreMessages: async () => {}, goToBottom: () => {}, releaseAutoFollow: () => {},
            });
            return null;
        };
        const render = (mode: 'visible' | 'hidden') => root.render(React.createElement(React.Activity, { mode, children: React.createElement(Harness) }));
        try {
            await act(async () => render('visible'));
            let load!: Promise<void>;
            act(() => { load = controller.loadEarlier(); });
            height = 1200;
            messages = [{ info: { id: 'older', sessionID: 'session', role: 'user', time: { created: 2 } }, parts: [] }, ...messages];
            await act(async () => render('visible'));
            await act(async () => { await load; });
            expect(frames.size).toBe(1);
            const stale = [...frames.values()];
            await act(async () => render('hidden'));
            expect(frames.size).toBe(0);
            container.scrollTop = 0;
            for (const callback of stale) callback(0);
            expect(container.scrollTop).toBe(0);
            expect(frames.size).toBe(0);
            await act(async () => render('visible'));
            act(() => { load = controller.loadEarlier(); });
            height = 1400;
            messages = [{ info: { id: 'oldest', sessionID: 'session', role: 'user', time: { created: 1 } }, parts: [] }, ...messages];
            await act(async () => render('visible'));
            await act(async () => { await load; });
            expect(frames.size).toBe(1);
        } finally {
            await act(async () => root.unmount());
            window.requestAnimationFrame = previousRequest;
            window.cancelAnimationFrame = previousCancel;
            dom.restore();
            await browser.happyDOM.close();
        }
    });
    test('retires an in-flight history search on effect cleanup and permits a fresh same-key action', async () => {
        const dom = installMinimalDom();
        const root = createRoot(dom.container);
        const pending = deferred();
        let messages: ChatMessageEntry[] = [{ info: { id: 'new', sessionID: 'session', role: 'user', time: { created: 2 } }, parts: [] }];
        let controller!: UseChatTimelineControllerResult;
        let calls = 0;
        const Harness = () => {
            controller = useChatTimelineController({
                sessionId: 'session', sessionKey: 'runtime\n/repo\nsession', messages,
                historyMeta: { limit: 1, complete: false, loading: false },
                scrollRef: { current: null }, messageListRef: { current: null }, isPinned: false, showScrollButton: false,
                loadMoreMessages: async () => { calls += 1; if (calls === 1) await pending.promise; },
                goToBottom: () => {}, releaseAutoFollow: () => {},
            });
            return null;
        };
        const render = (mode: 'visible' | 'hidden') => root.render(React.createElement(React.Activity, { mode, children: React.createElement(Harness) }));
        try {
            await act(async () => render('visible'));
            let search!: Promise<boolean>;
            act(() => { search = controller.loadHistoryUntilMessage('target', { maxBatches: 3 }); });
            expect(calls).toBe(1);
            await act(async () => render('hidden'));
            messages = [{ info: { id: 'older', sessionID: 'session', role: 'user', time: { created: 1 } }, parts: [] }, ...messages];
            await act(async () => render('visible'));
            expect(controller.isLoadingOlder).toBe(false);
            await act(async () => { pending.resolve(); });
            await act(async () => { expect(await search).toBe(false); });
            expect(calls).toBe(1);
            let fresh!: Promise<void>;
            act(() => { fresh = controller.loadEarlier(); });
            await act(async () => { await fresh; });
            expect(calls).toBe(2);
            expect(controller.isLoadingOlder).toBe(false);
        } finally {
            await act(async () => root.unmount());
            dom.restore();
        }
    });
    test('one history action delegates one batch even when rendering has no new user turn', async () => {
        const dom = installMinimalDom();
        const root = createRoot(dom.container);
        const pending = deferred();
        const user: Message = { id: 'user', sessionID: 'session', role: 'user', time: { created: 100 } };
        const older: Message = {
            id: 'older-step', sessionID: 'session', role: 'assistant',
            time: { created: 99, completed: 100 }, providerID: 'test', modelID: 'test', agent: 'build',
        };
        let messages: ChatMessageEntry[] = [{ info: user, parts: [] }];
        let calls = 0;
        let controller!: UseChatTimelineControllerResult;
        const scrollRef = { current: null };
        const messageListRef = { current: null };
        const Harness = () => {
            controller = useChatTimelineController({
                sessionId: 'session', sessionKey: 'runtime\n/repo\nsession', messages,
                historyMeta: { limit: messages.length, complete: false, loading: false },
                scrollRef, messageListRef, isPinned: false, showScrollButton: false,
                loadMoreMessages: async () => { calls += 1; await pending.promise; },
                goToBottom: () => undefined, releaseAutoFollow: () => undefined,
            });
            return null;
        };
        try {
            await act(async () => root.render(React.createElement(Harness)));
            let first!: Promise<void>;
            let duplicate!: Promise<void>;
            act(() => {
                first = controller.loadEarlier({ userInitiated: true });
                duplicate = controller.loadEarlier({ userInitiated: true });
            });
            expect(calls).toBe(1);
            await act(async () => { pending.resolve(); await Promise.resolve(); });
            messages = [{ info: older, parts: [] }, ...messages];
            act(() => root.render(React.createElement(Harness)));
            await act(async () => { await Promise.all([first, duplicate]); });
            expect(calls).toBe(1);
            expect(controller.isLoadingOlder).toBe(false);
        } finally {
            await act(async () => root.unmount());
            dom.restore();
        }
    });

    test('preserves the new identity while an old load is waiting for its render', async () => {
        const dom = installMinimalDom();
        const root: Root = createRoot(dom.container);
        const pendingA = deferred();
        const pendingB = deferred();
        const calls: string[] = [];
        const sessionId = 'shared-session';
        const message = {
            info: { id: 'msg_1', sessionID: sessionId, role: 'user', time: { created: 1 } } as Message,
            parts: [],
        };
        const olderMessage = {
            info: { id: 'msg_0', sessionID: sessionId, role: 'user', time: { created: 0 } } as Message,
            parts: [],
        };
        const assistantMessage = {
            info: { id: 'msg_2', sessionID: sessionId, role: 'assistant', time: { created: 2 } } as Message,
            parts: [],
        };
        const scrollMetrics = {
            scrollTop: 100,
            scrollHeight: 1000,
            clientHeight: 500,
            firstElementChild: null,
        };
        const scrollElement = scrollMetrics as unknown as HTMLDivElement;
        const scrollRef = { current: scrollElement };
        const capturedAnchors: string[] = [];
        const restoredAnchors: string[] = [];
        const messageListRef = {
            current: {
                captureViewportAnchor: () => {
                    const messageId = `anchor-${directory}`;
                    capturedAnchors.push(messageId);
                    return { messageId, offsetTop: 0 };
                },
                restoreViewportAnchor: (anchor: { messageId: string }) => {
                    restoredAnchors.push(anchor.messageId);
                    return true;
                },
                isHistoryVirtualized: () => false,
                scrollToTurnId: () => false,
                scrollToMessageId: () => false,
            } as unknown as MessageListHandle,
        };
        let controller!: UseChatTimelineControllerResult;
        let directory = 'A';
        let messages = [message];
        let startBOnLayout = false;
        let loadB: Promise<void> | null = null;

        const Harness = () => {
            const selectedDirectory = directory;
            controller = useChatTimelineController({
                sessionId,
                sessionKey: `runtime\n${selectedDirectory}\n${sessionId}`,
                messages,
                historyMeta: { limit: 1, complete: false, loading: false },
                scrollRef,
                messageListRef,
                loadMoreMessages: async () => {
                    calls.push(selectedDirectory);
                    await (selectedDirectory === 'A' ? pendingA.promise : pendingB.promise);
                },
                goToBottom: () => undefined,
                releaseAutoFollow: () => undefined,
                isPinned: false,
                showScrollButton: false,
            });
            React.useLayoutEffect(() => {
                if (selectedDirectory === 'B' && startBOnLayout && !loadB) {
                    loadB = controller.loadEarlier({ userInitiated: true });
                }
            }, [selectedDirectory]);
            return null;
        };

        try {
            await act(async () => root.render(React.createElement(Harness)));
            let loadA!: Promise<void>;
            act(() => {
                loadA = controller.loadEarlier({ userInitiated: true });
            });
            expect(calls).toEqual(['A']);

            // Let A pass its post-network identity check and enter the render
            // waiter before switching. B starts in the same layout commit that
            // releases A's waiter, so A must not clear B's new snapshot.
            await act(async () => {
                pendingA.resolve();
                await Promise.resolve();
            });
            directory = 'B';
            // Growth within the existing user turn means stale A would request
            // another A page after its render wait without the second token gate.
            messages = [message, assistantMessage];
            startBOnLayout = true;
            await act(async () => {
                root.render(React.createElement(Harness));
                await loadA;
            });
            expect(calls).toEqual(['A', 'B']);
            expect(controller.isLoadingOlder).toBe(true);
            expect(capturedAnchors).toContain('anchor-B');
            expect(restoredAnchors).toEqual([]);

            await act(async () => {
                pendingB.resolve();
                await new Promise((resolve) => setTimeout(resolve, 0));
            });
            messages = [olderMessage, message, assistantMessage];
            scrollMetrics.scrollHeight = 1200;
            act(() => {
                root.render(React.createElement(Harness));
            });
            await act(async () => {
                await loadB;
            });
            expect(controller.isLoadingOlder).toBe(false);
            expect(calls).toEqual(['A', 'B']);
            expect(restoredAnchors).toEqual(['anchor-B']);
        } finally {
            await act(async () => root.unmount());
            dom.restore();
        }
    });
});
