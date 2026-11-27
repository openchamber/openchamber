import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import type { Root } from 'react-dom/client';

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
const { MobileFullscreenSurface } = await import('./MobileFullscreenSurface');

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

const show = async (onClose: () => void) => {
    await act(async () => {
        root.render(
            <I18nProvider>
                <MobileFullscreenSurface open onClose={onClose} title="Board">
                    <button type="button">Inside</button>
                </MobileFullscreenSurface>
            </I18nProvider>,
        );
    });
};

const pressEscape = async (prevented: boolean) => {
    await act(async () => {
        const handled = (event: Event) => { if (prevented) event.preventDefault(); };
        document.addEventListener('keydown', handled, { capture: true, once: true });
        browser.document.dispatchEvent(new browser.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        document.removeEventListener('keydown', handled, { capture: true });
    });
};

describe('the phone surface and Escape', () => {
    test('closes on an Escape nothing else handled', async () => {
        const onClose = spyOn({ close() {} }, 'close');
        await show(() => onClose());
        await pressEscape(false);
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    test('stays open when the field inside already handled the Escape', async () => {
        const onClose = spyOn({ close() {} }, 'close');
        await show(() => onClose());
        await pressEscape(true);
        expect(onClose).toHaveBeenCalledTimes(0);
    });
});
