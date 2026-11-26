import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import type { ReactNode } from 'react';
import type { Root } from 'react-dom/client';

import { CollapsedBody } from './CollapsedBody';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
    window: browser, document: browser.document, navigator: browser.navigator, localStorage: browser.localStorage,
    Element: browser.Element, HTMLElement: browser.HTMLElement, Node: browser.Node, Text: browser.Text,
    SVGElement: browser.SVGElement, sessionStorage: browser.sessionStorage,
    Event: browser.Event, CustomEvent: browser.CustomEvent, KeyboardEvent: browser.KeyboardEvent, MouseEvent: browser.MouseEvent,
    MutationObserver: browser.MutationObserver, ResizeObserver: browser.ResizeObserver,
    getComputedStyle: browser.getComputedStyle.bind(browser), requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
    cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser), IS_REACT_ACT_ENVIRONMENT: true,
});
globalThis.fetch = Object.assign(() => new Promise<Response>(() => {}), globalThis.fetch);

const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
});

afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
});

const render = async (node: ReactNode) => {
    await act(async () => {
        root.render(<I18nProvider>{node}</I18nProvider>);
    });
};

/** happy-dom lays nothing out, so clientHeight is 0 and scrollHeight stands for the content. */
const withContentHeight = async (height: () => number, run: () => Promise<void>) => {
    const prototype = browser.HTMLElement.prototype;
    const original = Object.getOwnPropertyDescriptor(prototype, 'scrollHeight');
    Object.defineProperty(prototype, 'scrollHeight', { configurable: true, get: height });
    try {
        await run();
    } finally {
        if (original) Object.defineProperty(prototype, 'scrollHeight', original);
        else Reflect.deleteProperty(prototype, 'scrollHeight');
    }
};

const withRects = async (read: (element: HTMLElement) => { top: number; bottom: number }, run: () => Promise<void>) => {
    const prototype = browser.HTMLElement.prototype;
    const original = Object.getOwnPropertyDescriptor(prototype, 'getBoundingClientRect');
    Object.defineProperty(prototype, 'getBoundingClientRect', {
        configurable: true,
        value(this: HTMLElement) {
            const { top, bottom } = read(this);
            return { top, bottom, left: 0, right: 0, width: 0, height: bottom - top, x: 0, y: top, toJSON: () => ({}) };
        },
    });
    try {
        await run();
    } finally {
        if (original) Object.defineProperty(prototype, 'getBoundingClientRect', original);
        else Reflect.deleteProperty(prototype, 'getBoundingClientRect');
    }
};

const buttonNamed = (name: string) => [...host.querySelectorAll('button')].find((button) => button.textContent?.trim() === name);

describe('CollapsedBody', () => {
    test('offers no control for a body that fits under the cap', async () => {
        await withContentHeight(() => 0, async () => {
            await render(<CollapsedBody collapsed><p>Short body</p></CollapsedBody>);
            expect(Boolean(buttonNamed('Expand'))).toBe(false);
        });
    });

    test('keeps only the controls cut off below the body out of the tab order until it expands', async () => {
        await withContentHeight(() => 400, async () => {
            await withRects((element) => (element.hasAttribute('data-collapsed-body')
                ? { top: 0, bottom: 100 }
                : { top: Number(element.dataset.top ?? 0), bottom: Number(element.dataset.bottom ?? 0) }), async () => {
                await render(
                    <CollapsedBody collapsed>
                        <p><a href="https://example.com/above" data-top="10" data-bottom="20">above</a></p>
                        <p><a href="https://example.com/below" data-top="200" data-bottom="220">below</a></p>
                    </CollapsedBody>,
                );
                const above = host.querySelector('a[href$="/above"]');
                const below = host.querySelector('a[href$="/below"]');
                expect(above?.hasAttribute('tabindex')).toBe(false);
                expect(below?.getAttribute('tabindex')).toBe('-1');

                const expand = buttonNamed('Expand');
                if (!expand) throw new Error('Expected the Expand control');
                await act(async () => { expand.click(); });
                const mounted = [...host.querySelectorAll('a')];
                expect(mounted.map((link) => link.getAttribute('href'))).toEqual(['https://example.com/above', 'https://example.com/below']);
                expect(mounted.every((link) => link.isConnected && !link.hasAttribute('tabindex'))).toBe(true);
            });
        });
    });

    test('takes a link out of the tab order when a refresh turns text below the cutoff into one, without a resize', async () => {
        await withContentHeight(() => 400, async () => {
            await withRects((element) => (element.hasAttribute('data-collapsed-body')
                ? { top: 0, bottom: 100 }
                : { top: Number(element.dataset.top ?? 0), bottom: Number(element.dataset.bottom ?? 0) }), async () => {
                const Body = ({ linked }: { linked: boolean }) => (
                    <CollapsedBody collapsed>
                        <p>Short intro</p>
                        {linked
                            ? <p><a href="https://example.com/late" data-top="200" data-bottom="220">late</a></p>
                            : <p data-top="200" data-bottom="220">late</p>}
                    </CollapsedBody>
                );
                await render(<Body linked={false} />);
                expect(host.querySelector('a')).toBeNull();

                await render(<Body linked />);
                await act(async () => { await Promise.resolve(); });
                const late = host.querySelector('a[href$="/late"]');
                expect(late?.getAttribute('tabindex')).toBe('-1');

                const expand = buttonNamed('Expand');
                if (!expand) throw new Error('Expected the Expand control');
                await act(async () => { expand.click(); });
                const mounted = host.querySelector('a[href$="/late"]');
                expect(mounted?.isConnected).toBe(true);
                expect(mounted?.hasAttribute('tabindex')).toBe(false);
            });
        });
    });

    test('offers Expand when late content grows the inner body', async () => {
        let height = 0;
        await withContentHeight(() => height, async () => {
            const RealResizeObserver = globalThis.ResizeObserver;
            const observers: Array<{ targets: Element[]; fire: () => void }> = [];
            class FakeResizeObserver implements ResizeObserver {
                private readonly record: { targets: Element[]; fire: () => void };
                constructor(callback: ResizeObserverCallback) {
                    this.record = { targets: [], fire: () => callback([], this) };
                    observers.push(this.record);
                }
                observe(target: Element) { this.record.targets.push(target); }
                unobserve() {}
                disconnect() { this.record.targets = []; }
            }
            globalThis.ResizeObserver = FakeResizeObserver;
            try {
                await render(<CollapsedBody collapsed><p>Late picture</p></CollapsedBody>);
                expect(Boolean(buttonNamed('Expand'))).toBe(false);

                // Only the inner body grows, so only an observer watching it may report.
                const inner = host.querySelector('[data-collapsed-content]');
                if (!inner) throw new Error('Expected the inner body');
                height = 400;
                await act(async () => {
                    for (const observer of observers) {
                        if (observer.targets.includes(inner)) observer.fire();
                    }
                });
                expect(Boolean(buttonNamed('Expand'))).toBe(true);
            } finally {
                globalThis.ResizeObserver = RealResizeObserver;
            }
        });
    });
});
