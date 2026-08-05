import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, expect, test } from 'bun:test';
import type { Message } from '@opencode-ai/sdk/v2/client';

import {
    isOlderHistoryPrependCommit,
    shouldAutoLoadEarlierForUnderfilledPinnedViewport,
    useChatTimelineController,
    type UseChatTimelineControllerResult,
} from './useChatTimelineController';
import type { MessageListHandle } from '../MessageList';

const baseInput = {
    sessionId: 'ses_1',
    isPinned: true,
    canLoadEarlier: true,
    isLoadingOlder: false,
    pendingRevealWork: false,
    scrollHeight: 799,
    clientHeight: 800,
};

describe('shouldAutoLoadEarlierForUnderfilledPinnedViewport', () => {
    test('loads when pinned content does not fill the viewport', () => {
        expect(shouldAutoLoadEarlierForUnderfilledPinnedViewport(baseInput)).toBe(true);
    });

    test('does not load when content already overflows', () => {
        expect(shouldAutoLoadEarlierForUnderfilledPinnedViewport({
            ...baseInput,
            scrollHeight: 802,
        })).toBe(false);
    });

    test('does not load while user is away from bottom or history work is active', () => {
        expect(shouldAutoLoadEarlierForUnderfilledPinnedViewport({
            ...baseInput,
            isPinned: false,
        })).toBe(false);
        expect(shouldAutoLoadEarlierForUnderfilledPinnedViewport({
            ...baseInput,
            isLoadingOlder: true,
        })).toBe(false);
        expect(shouldAutoLoadEarlierForUnderfilledPinnedViewport({
            ...baseInput,
            pendingRevealWork: true,
        })).toBe(false);
    });
});

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

describe('useChatTimelineController identity lifecycle', () => {
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
