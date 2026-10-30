import React, { act } from 'react';
import { expect, test } from 'bun:test';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';

import type { ChatQuoteAnchor } from '@/lib/chatQuoteAnchor';
import type { ChatQuoteHighlightStore, ChatQuoteMark } from '../hooks/chatQuoteHighlightStore';
import { ChatQuoteHighlightLayer } from './ChatQuoteHighlightLayer';
import { ChatColumnSessionContext } from '../chatColumnSession';

test('loads an older quote source before scrolling to it', async () => {
    const dom = new Window({ url: 'https://app.test' });
    const frames = new Map<number, FrameRequestCallback>();
    let nextFrame = 0;
    const requestAnimationFrame = (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame; };
    const cancelAnimationFrame = (id: number) => { frames.delete(id); };
    class TestHighlight extends Set<Range> {
        priority = 0;
        constructor(...ranges: Range[]) { super(ranges); }
    }
    Object.assign(dom, { requestAnimationFrame, cancelAnimationFrame, Highlight: TestHighlight });
    const highlights = new Map<string, TestHighlight>();
    const globals = {
        window: dom,
        document: dom.document,
        navigator: dom.navigator,
        HTMLElement: dom.HTMLElement,
        Element: dom.Element,
        Node: dom.Node,
        Event: dom.Event,
        KeyboardEvent: dom.KeyboardEvent,
        MutationObserver: dom.MutationObserver,
        requestAnimationFrame,
        cancelAnimationFrame,
        Highlight: TestHighlight,
        CSS: { highlights, escape: (value: string) => value },
        IS_REACT_ACT_ENVIRONMENT: true,
    };
    const previous = Object.keys(globals).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
    for (const [name, value] of Object.entries(globals)) {
        Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    }

    const events: string[] = [];
    let sourceState: 'available' | 'missing' | 'failed' | 'pending' = 'available';
    let finishLoad: ((loaded: boolean) => void) | undefined;
    const emptyMarks: ChatQuoteMark[] = [];
    let revealHandler: ((messageId: string, anchor: ChatQuoteAnchor) => void) | null = null;
    const store: ChatQuoteHighlightStore = {
        publishMarks: () => undefined,
        focusMark: () => undefined,
        reveal: () => undefined,
        subscribe: () => () => undefined,
        getMarks: () => emptyMarks,
        getChipFocus: () => null,
        setRevealHandler: (handler) => { revealHandler = handler; },
    };
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const scrollNode = document.createElement('div');
    document.body.append(scrollNode);
    const frame = async () => act(async () => {
        const pending = [...frames.values()];
        frames.clear();
        pending.forEach((callback) => callback(0));
    });

    try {
        const render = async (sessionId = 'session') => act(async () => {
            root.render(
                <ChatColumnSessionContext.Provider value={{ sessionId, directory: '/repo' }}>
                <ChatQuoteHighlightLayer
                    store={store}
                    scrollNode={scrollNode}
                    loadHistoryUntilMessage={async (messageId) => {
                        events.push(`load:${messageId}`);
                        if (sourceState === 'failed') throw new Error('History unavailable');
                        if (sourceState === 'pending') return new Promise<boolean>((resolve) => { finishLoad = resolve; });
                        return sourceState === 'available';
                    }}
                    scrollToMessage={async (messageId) => {
                        events.push(`scroll:${messageId}`);
                        return true;
                    }}
                />
                </ChatColumnSessionContext.Provider>,
            );
        });
        await render();

        expect(revealHandler).not.toBeNull();
        await act(async () => {
            revealHandler?.('older-message', { text: 'quoted text', prefix: '', suffix: '', start: 0 });
        });
        expect(events).toEqual(['load:older-message', 'scroll:older-message']);
        await frame();
        expect(highlights.size).toBe(0);
        for (let index = 0; index < 15; index += 1) await frame();
        // Expansion and lazy Markdown can commit after the first scroll frame.
        scrollNode.innerHTML = '<div data-message-id="older-message"><div data-chat-quote-root><p>Earlier <strong>quoted</strong> text here.</p></div></div>';
        await act(async () => { await dom.happyDOM.waitUntilComplete(); });
        await frame();
        expect([...highlights.get('oc-chat-quote') ?? []].map((range) => range.toString())).toEqual(['quoted text']);

        highlights.clear();
        await act(async () => {
            revealHandler?.('superseded', { text: 'obsolete text', prefix: '', suffix: '', start: 0 });
        });
        await act(async () => {
            revealHandler?.('replacement', { text: 'replacement text', prefix: '', suffix: '', start: 0 });
        });
        scrollNode.innerHTML = '<div data-message-id="superseded"><div data-chat-quote-root>obsolete text</div></div>';
        await act(async () => { await dom.happyDOM.waitUntilComplete(); });
        await frame();
        expect(highlights.size).toBe(0);
        await render('another-session');
        scrollNode.innerHTML = '<div data-message-id="replacement"><div data-chat-quote-root>replacement text</div></div>';
        await act(async () => { await dom.happyDOM.waitUntilComplete(); });
        await frame();
        expect(highlights.size).toBe(0);
        // These reveal attempts are independent of the loader failure cases.
        events.length = 0;

        for (const type of ['wheel', 'touchstart', 'pointerdown', 'keydown', 'openchamber:frame-scroll']) {
            scrollNode.innerHTML = '<div data-message-id="cancelled"><div data-chat-quote-root><div data-chat-quote-pending /></div></div>';
            await act(async () => {
                revealHandler?.('cancelled', { text: 'late text', prefix: '', suffix: '', start: 0 });
            });
            scrollNode.innerHTML = '<div data-message-id="cancelled"><div data-chat-quote-root>late text</div></div>';
            await act(async () => { await dom.happyDOM.waitUntilComplete(); });
            expect(frames.size).toBe(1);
            scrollNode.dispatchEvent(type === 'keydown' ? new KeyboardEvent(type, { key: 'PageUp' }) : new Event(type));
            await frame();
            expect(highlights.size).toBe(0);
        }

        // Wait for the lazy renderer, but unrelated streaming must not retry.
        scrollNode.innerHTML = '<div data-message-id="pending-markdown"><div data-chat-quote-root><div data-chat-quote-pending /></div></div><div data-message-id="streaming">other text</div>';
        await act(async () => {
            revealHandler?.('pending-markdown', { text: 'ready text', prefix: '', suffix: '', start: 0 });
        });
        await act(async () => { await dom.happyDOM.waitUntilComplete(); });
        await frame();
        scrollNode.querySelector('[data-message-id="streaming"]')!.textContent = 'more tokens';
        await act(async () => { await dom.happyDOM.waitUntilComplete(); });
        expect(frames.size).toBe(0);
        scrollNode.querySelector('[data-chat-quote-root]')!.innerHTML = '<p>ready text</p>';
        await act(async () => { await dom.happyDOM.waitUntilComplete(); });
        await frame();
        expect([...highlights.get('oc-chat-quote') ?? []].map((range) => range.toString())).toEqual(['ready text']);
        highlights.clear();

        // A mounted, finished source cannot resolve an ambiguous or changed quote.
        for (const text of ['same and same', 'changed text']) {
            scrollNode.innerHTML = `<div data-message-id="unresolved"><div data-chat-quote-root>${text}</div></div>`;
            await act(async () => {
                revealHandler?.('unresolved', { text: 'same', prefix: '', suffix: '', start: 0 });
            });
            await act(async () => { await dom.happyDOM.waitUntilComplete(); });
            await frame();
            scrollNode.querySelector('[data-chat-quote-root]')!.textContent = 'same';
            await act(async () => { await dom.happyDOM.waitUntilComplete(); });
            expect(frames.size).toBe(0);
            expect(highlights.size).toBe(0);
        }

        sourceState = 'pending';
        events.length = 0;
        await act(async () => {
            revealHandler?.('cancelled-load', { text: 'late text', prefix: '', suffix: '', start: 0 });
        });
        scrollNode.dispatchEvent(new Event('wheel'));
        await act(async () => { finishLoad?.(true); });
        expect(events).toEqual(['load:cancelled-load']);
        events.length = 0;

        sourceState = 'missing';
        await act(async () => {
            revealHandler?.('missing-message', { text: 'quoted text', prefix: '', suffix: '', start: 0 });
        });
        expect(events).toEqual(['load:missing-message']);

        sourceState = 'failed';
        await act(async () => {
            revealHandler?.('failed-message', { text: 'quoted text', prefix: '', suffix: '', start: 0 });
        });
        expect(events).toEqual(['load:missing-message', 'load:failed-message']);

        sourceState = 'pending';
        await act(async () => {
            revealHandler?.('obsolete-message', { text: 'quoted text', prefix: '', suffix: '', start: 0 });
        });
        await act(async () => { root.render(null); });
        await act(async () => { finishLoad?.(true); });
        expect(events).toEqual(['load:missing-message', 'load:failed-message', 'load:obsolete-message']);

        sourceState = 'available';
        await render();
        await act(async () => {
            revealHandler?.('unmounted', { text: 'late text', prefix: '', suffix: '', start: 0 });
        });
        await act(async () => { root.render(null); });
        scrollNode.innerHTML = '<div data-message-id="unmounted"><div data-chat-quote-root>late text</div></div>';
        await act(async () => { await dom.happyDOM.waitUntilComplete(); });
        await frame();
        expect(highlights.size).toBe(0);
    } finally {
        await act(async () => root.unmount());
        for (const [name, descriptor] of previous) {
            if (descriptor) Object.defineProperty(globalThis, name, descriptor);
            else Reflect.deleteProperty(globalThis, name);
        }
        await dom.happyDOM.close();
    }
});
