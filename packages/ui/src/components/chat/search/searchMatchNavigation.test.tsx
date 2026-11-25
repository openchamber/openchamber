import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';

import { releaseMessageFocusOutside, peekMessageFocus, settleMessageFocus } from '@/lib/router/messageFocus';

import { onNavigationRelease, dispatchFrameScroll } from '../lib/scroll/timelineScrollIntent';
import { showSearchMatch, type MatchLocator, type MatchPlace } from './searchMatchNavigation';

// React DOM decides at import whether it runs in a page.
const loadingDom = new Window({ url: 'https://app.test' });
Object.assign(globalThis, { window: loadingDom, document: loadingDom.document, navigator: loadingDom.navigator, localStorage: loadingDom.localStorage, sessionStorage: loadingDom.sessionStorage });
const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { ChatSearchBar } = await import('./ChatSearchBar');

type Row = { readonly html: string; readonly attributes?: string };

const VIEWPORT = 600;
const ROW = 400;
const OVERSCAN = 250;
const SESSION = 'ses';

describe('search navigation over a virtualized reply', () => {
    let restore: () => void;
    let dom: Window;
    let frames: FrameRequestCallback[];
    let clock: number;
    let chat: HTMLElement;
    let rows: readonly Row[];
    let pinned: ReadonlySet<number>;
    let scrollTop: number;
    let scrolls: number;

    const rect = (top: number, height: number): DOMRect => ({ top, height, bottom: top + height, left: 0, right: 100, width: 100, x: 0, y: top, toJSON: () => ({}) });
    const rowTop = (element: Element | null): number => Number(element?.closest('[data-at]')?.getAttribute('data-at') ?? 0) * ROW - scrollTop;

    const mount = () => {
        for (const element of chat.querySelectorAll('[data-at]')) {
            const at = Number(element.getAttribute('data-at'));
            if (!isMounted(at)) element.remove();
        }
        rows.forEach((row, at) => {
            if (!isMounted(at) || chat.querySelector(`[data-at="${at}"]`)) return;
            const host = document.createElement('div');
            host.setAttribute('data-at', String(at));
            const slice = at === 0 ? '' : `data-message-slice="p:${at}"`;
            host.innerHTML = `<div data-message-id="m" ${slice} data-message-row="${at}/${rows.length}" ${row.attributes ?? ''}>${row.html}</div>`;
            chat.append(host);
        });
    };
    const isMounted = (at: number): boolean => pinned.has(at)
        || (at * ROW < scrollTop + VIEWPORT + OVERSCAN && (at + 1) * ROW > scrollTop - OVERSCAN);

    const frame = () => {
        mount();
        for (const callback of frames.splice(0)) callback(0);
    };
    const run = (count = 300) => {
        for (let ran = 0; frames.length > 0 && ran < count; ran += 1) frame();
    };
    const answer = (text = 'filler'): Row => ({ html: `<div data-markdown-content><p>${text}</p></div>` });
    const reply = (count: number, matches: readonly number[]): Row[] => Array.from({ length: count }, (_, at) => answer(matches.includes(at) ? 'the quokka table' : 'filler'));
    const at = (row: number): MatchLocator => ({ key: 'm:m', part: row === 0 ? null : `p:${row}`, row, order: 0 });

    const show = (place: MatchPlace, reasoning = false) => {
        const shown: MatchLocator[] = [];
        const result = { shown, notFound: 0, interrupted: 0, stop: () => {} };
        result.stop = showSearchMatch({
            scrollNode: chat,
            sessionId: SESSION,
            target: { messageId: 'm', reasoning },
            terms: ['quokka'],
            place,
            takeViewport: () => {
                const request = peekMessageFocus(SESSION);
                if (request) settleMessageFocus(request);
            },
            onShown: (locator) => result.shown.push(locator),
            onNotFound: () => { result.notFound += 1; },
            onInterrupted: () => { result.interrupted += 1; },
        });
        return result;
    };

    beforeEach(() => {
        dom = new Window({ url: 'https://app.test' });
        frames = [];
        clock = 0;
        rows = [];
        pinned = new Set();
        scrollTop = 0;
        scrolls = 0;
        const request = (callback: FrameRequestCallback) => frames.push(callback);
        const cancel = (id: number) => { frames[id - 1] = () => {}; };
        Object.assign(dom, { requestAnimationFrame: request, cancelAnimationFrame: cancel });
        Object.defineProperty(dom.HTMLElement.prototype, 'getBoundingClientRect', {
            configurable: true,
            value(this: HTMLElement) {
                if (this.id === 'chat') return rect(0, VIEWPORT);
                if (this.hasAttribute('data-composer-slot')) return rect(400, 200);
                const box = this.closest('[data-box]');
                return box ? rect(rowTop(this) + 10, Number(box.getAttribute('data-box'))) : rect(rowTop(this), ROW);
            },
        });
        Object.defineProperty(dom.Range.prototype, 'getBoundingClientRect', {
            configurable: true,
            value(this: Range) {
                const holder = this.startContainer.parentElement;
                return rect(rowTop(holder) + Number(holder?.getAttribute('data-y') ?? 190), 20);
            },
        });
        const globals = {
            window: dom,
            document: dom.document,
            navigator: dom.navigator,
            NodeFilter: dom.NodeFilter,
            Node: dom.Node,
            Element: dom.Element,
            HTMLElement: dom.HTMLElement,
            Event: dom.Event,
            KeyboardEvent: dom.KeyboardEvent,
            CustomEvent: dom.CustomEvent,
            MutationObserver: dom.MutationObserver,
            localStorage: dom.localStorage,
            sessionStorage: dom.sessionStorage,
            CSS: { escape: (value: string) => value },
            getComputedStyle: dom.getComputedStyle.bind(dom),
            requestAnimationFrame: request,
            cancelAnimationFrame: cancel,
            IS_REACT_ACT_ENVIRONMENT: true,
        };
        const previous = Object.keys(globals).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
        for (const [name, value] of Object.entries(globals)) Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
        const now = performance.now;
        performance.now = () => clock;
        restore = () => {
            performance.now = now;
            for (const [name, descriptor] of previous) {
                if (descriptor) Object.defineProperty(globalThis, name, descriptor);
                else Reflect.deleteProperty(globalThis, name);
            }
        };
        document.body.innerHTML = '<div data-composer-bound><div id="chat"></div></div><div id="bar"></div><textarea id="composer"></textarea>';
        const node = document.getElementById('chat');
        if (!node) throw new Error('fixture element missing');
        chat = node;
        Object.defineProperty(chat, 'scrollTop', {
            configurable: true,
            get: () => scrollTop,
            set: (value: number) => {
                scrolls += 1;
                scrollTop = Math.min(Math.max(0, value), Math.max(0, rows.length * ROW - VIEWPORT));
            },
        });
    });
    afterEach(async () => {
        releaseMessageFocusOutside(null);
        restore();
        await dom.happyDOM.close();
    });

    test('a match that cannot reach the middle, at the end of the chat, stops being held', () => {
        rows = reply(1, [0]);
        const result = show({ kind: 'index', index: 0 });
        let ran = 0;
        for (; frames.length > 0 && ran < 100; ran += 1) frame();
        expect(result.shown).toEqual([at(0)]);
        expect(ran).toBeLessThan(20);
    });

    for (const [title, place, start, landed] of [
        ['next, with the match shown last unmounted on the way', { kind: 'next', index: 1, from: at(1) }, 0, 18],
        ['previous, with the match shown last unmounted on the way', { kind: 'previous', index: 0, from: at(18) }, 18, 1],
        ['next, after the reader scrolled far away from the match shown last', { kind: 'next', index: 1, from: at(1) }, 25, 18],
        ['previous, after the reader scrolled far away from the match shown last', { kind: 'previous', index: 0, from: at(18) }, 2, 1],
        ['the third match of the reply, with none shown yet', { kind: 'index', index: 2 }, 12, 24],
        ['the last match, from the top of the reply', { kind: 'last', index: 2 }, 0, 24],
    ] as const) {
        test(`lands on the right match: ${title}`, () => {
            rows = reply(30, [1, 18, 24]);
            scrollTop = start * ROW;
            const result = show(place);
            run();
            expect(result.shown).toEqual([at(landed)]);
            expect(scrollTop).toBeGreaterThan(landed * ROW - VIEWPORT);
            expect(scrollTop).toBeLessThan((landed + 1) * ROW);
        });
    }

    test('a shown match whose row no longer exists is found by its number', () => {
        rows = reply(30, [12]);
        const result = show({ kind: 'shown', index: 0, locator: at(99) });
        run();
        expect(result.shown).toEqual([at(12)]);
        expect(result.notFound).toBe(0);
    });

    test('a gap between mounted rows hides no match, in either direction', () => {
        rows = reply(30, [0, 10, 20]);
        pinned = new Set([0, 20]);
        const forward = show({ kind: 'next', index: 1, from: at(0) });
        run();
        expect(forward.shown).toEqual([at(10)]);
        scrollTop = 20 * ROW;
        const back = show({ kind: 'previous', index: 1, from: at(20) });
        run();
        expect(back.shown).toEqual([at(10)]);
    });

    test('a step past the matches the page draws stays on the last of them', () => {
        rows = reply(30, [3]);
        const result = show({ kind: 'next', index: 1, from: at(3) });
        run();
        expect(result.shown).toEqual([at(3)]);
    });

    test('reasoning in a later row of a long step is reached', () => {
        const thinking = (id: string, text: string): Row => ({ html: `<div data-reasoning-message-id="m" data-reasoning-block-id="${id}"><div data-markdown-content><p>${text}</p></div></div>` });
        rows = [thinking('b1', 'first quokka'), ...reply(20, [4]).slice(1), thinking('b2', 'second quokka'), answer()];
        const result = show({ kind: 'next', index: 1, from: { key: 'r:m', part: 'b1', row: 0, order: 0 } }, true);
        run();
        expect(result.shown.map((locator) => locator.part)).toEqual(['b2']);
    });

    test('history that takes 20 seconds to load still ends on the match', () => {
        const result = show({ kind: 'index', index: 1 });
        for (let second = 0; second < 20; second += 1) {
            frame();
            clock += 1000;
        }
        expect(result.notFound).toBe(0);
        rows = reply(30, [2, 15]);
        const request = peekMessageFocus(SESSION);
        if (!request) throw new Error('the message was not asked for');
        settleMessageFocus(request);
        run();
        expect(result.shown).toEqual([at(15)]);
    });

    test('a match inside a collapsed prompt brings the prompt into view', () => {
        rows = [...reply(5, []), { html: '<div data-user-message-bubble><div data-box="40" style="overflow-y: hidden"><p data-y="3000">quokka</p></div></div>' }, ...reply(5, [])];
        pinned = new Set([0, 1, 2, 3, 4, 5]);
        show({ kind: 'index', index: 0 });
        run();
        expect(Math.abs(rowTop(chat.querySelector('[data-at="5"]')) + 30 - (12 + VIEWPORT - 12) / 2)).toBeLessThanOrEqual(1);
    });

    test('the match lands between the top fade and a floating composer', () => {
        rows = reply(12, [6]);
        const composer = document.createElement('div');
        composer.setAttribute('data-composer-slot', 'floating');
        chat.parentElement?.append(composer);
        show({ kind: 'index', index: 0 });
        run();
        expect(rowTop(chat.querySelector('[data-at="6"]')) + 200).toBe((12 + 400 - 12) / 2);
    });

    const inputs: readonly (readonly [string, () => void])[] = [
        ['a wheel over the chat', () => chat.dispatchEvent(new Event('wheel'))],
        ['a wheel inside an embedded page', () => dispatchFrameScroll(chat, 'down')],
        ['a key press outside the search bar', () => document.getElementById('composer')?.dispatchEvent(new Event('keydown', { bubbles: true }))],
        ['a press on a control outside the transcript', () => document.getElementById('composer')?.dispatchEvent(new Event('pointerdown', { bubbles: true }))],
    ];
    for (const [title, input] of inputs) {
        test(`${title} ends the walk and nothing moves after it`, () => {
            rows = reply(30, [1, 25]);
            scrollTop = ROW;
            const result = show({ kind: 'next', index: 1, from: at(1) });
            for (let ran = 0; ran < 3; ran += 1) frame();
            input();
            const stopped = scrolls;
            run();
            expect(result).toMatchObject({ shown: [], interrupted: 1 });
            expect(scrolls).toBe(stopped);
        });
    }

    test('an input while the message loads drops the request, so it cannot land later', () => {
        const result = show({ kind: 'index', index: 0 });
        frame();
        expect(peekMessageFocus(SESSION)).not.toBeNull();
        document.getElementById('composer')?.dispatchEvent(new Event('keydown', { bubbles: true }));
        expect(result.interrupted).toBe(1);
        expect(peekMessageFocus(SESSION)).toBeNull();
    });

    describe('the search bar', () => {
        let emphasized: Range[];
        let unmount: () => Promise<void>;
        const previousFetch = globalThis.fetch;
        afterEach(async () => {
            await unmount();
            jest.useRealTimers();
            globalThis.fetch = previousFetch;
        });

        const open = async (matchCount: number) => {
            jest.useFakeTimers();
            emphasized = [];
            class FakeHighlight {
                priority = 0;
                readonly ranges: Range[];
                constructor(...ranges: Range[]) { this.ranges = ranges; }
            }
            const highlights = { set: (name: string, value: FakeHighlight) => { if (name.endsWith('current')) emphasized = value.ranges; }, delete: (name: string) => { if (name.endsWith('current')) emphasized = []; } };
            Object.assign(dom, { Highlight: FakeHighlight });
            Object.assign(globalThis, { Highlight: FakeHighlight });
            Object.assign(globalThis.CSS, { highlights });
            const hit = { id: 'm', sessionId: SESSION, role: 'assistant', createdAt: 1, sessionTitle: '', directory: '/', snippet: '', matchCount };
            globalThis.fetch = Object.assign(async () => Response.json({ status: 'ok', hits: [hit], next: null, index: null }), { preconnect: () => {} });
            const host = document.getElementById('bar');
            if (!host) throw new Error('fixture element missing');
            const root = createRoot(host);
            unmount = async () => { await act(async () => root.unmount()); };
            await act(async () => root.render(<I18nProvider><ChatSearchBar sessionId={SESSION} scrollNode={chat} focusRequest={0} onTakeViewport={() => {}} onClose={() => {}} /></I18nProvider>));
            const input = host.querySelector('input');
            if (!input) throw new Error('search field missing');
            const setValue = Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, 'value')?.set;
            await act(async () => {
                setValue?.call(input, 'quokka');
                input.dispatchEvent(new Event('input', { bubbles: true }));
            });
            await act(async () => { jest.advanceTimersByTime(200); });
            for (let turn = 0; turn < 20; turn += 1) await act(async () => {});
            const key = (shiftKey: boolean) => act(async () => {
                input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey, bubbles: true }));
            });
            const position = () => host.querySelector('[role="status"]')?.textContent ?? '';
            return { next: () => key(false), previous: () => key(true), position };
        };
        const settle = async (count = 400) => {
            for (let ran = 0; frames.length > 0 && ran < count; ran += 1) await act(async () => frame());
        };
        const paintedRow = (): number => Number(emphasized[0]?.startContainer.parentElement?.closest('[data-at]')?.getAttribute('data-at') ?? -1);

        test('presses queued during a walk apply one at a time and paint the match the count names', async () => {
            rows = reply(40, [2, 14, 26, 38]);
            scrollTop = 39 * ROW;
            const bar = await open(4);
            await settle();
            expect([bar.position(), paintedRow()]).toEqual(['4 of 4', 38]);
            await bar.next();
            await bar.next();
            await bar.next();
            await settle();
            expect([bar.position(), paintedRow()]).toEqual(['3 of 4', 26]);
        });

        test('an input drops the queued presses, and the next press paints the match the count names', async () => {
            rows = reply(40, [2, 14, 26, 38]);
            scrollTop = 39 * ROW;
            const bar = await open(4);
            await settle();
            await bar.previous();
            await bar.previous();
            await act(async () => frame());
            await act(async () => { chat.dispatchEvent(new Event('wheel')); });
            const stopped = scrolls;
            await settle();
            expect(scrolls).toBe(stopped);
            expect(bar.position()).toBe('3 of 4');
            await bar.previous();
            await settle();
            expect([bar.position(), paintedRow()]).toEqual(['2 of 4', 14]);
        });

        test('the only match is shown again after the reader scrolled away from it', async () => {
            rows = reply(30, [12]);
            const bar = await open(1);
            await settle();
            expect([bar.position(), paintedRow()]).toEqual(['1 of 1', 12]);
            scrollTop = 0;
            await bar.next();
            await settle();
            expect(scrollTop).toBeGreaterThanOrEqual(12 * ROW - VIEWPORT);
            expect(scrollTop).toBeLessThan(13 * ROW);
            expect([bar.position(), paintedRow()]).toEqual(['1 of 1', 12]);
        });

        test('showing that match again starts from where it was shown', async () => {
            rows = reply(30, [12]);
            const bar = await open(1);
            await settle();
            scrollTop = 20 * ROW;
            await bar.next();
            let furthestUp = scrollTop;
            for (let ran = 0; frames.length > 0 && ran < 400; ran += 1) {
                await act(async () => frame());
                furthestUp = Math.min(furthestUp, scrollTop);
            }
            expect(furthestUp).toBeGreaterThanOrEqual(12 * ROW - VIEWPORT);
            expect([bar.position(), paintedRow()]).toEqual(['1 of 1', 12]);
        });
    });

    test('a step ends a navigation settling on another row', () => {
        rows = reply(3, [1]);
        let released = 0;
        const stopListening = onNavigationRelease(chat, () => { released += 1; });
        show({ kind: 'index', index: 0 });
        run();
        stopListening();
        expect(released).toBeGreaterThan(0);
    });
});
