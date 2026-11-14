import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { ReferenceMarkdownEditor } from './ReferenceMarkdownEditor';

describe('a host item text edited in the composer editor', () => {
    let browser: Window;
    let root: Root;
    let host: HTMLDivElement;
    let descriptors: Map<string, PropertyDescriptor | undefined>;
    let saves: number;
    let cancels: number;

    beforeEach(() => {
        browser = new Window();
        const globals = {
            window: browser, document: browser.document, navigator: browser.navigator,
            HTMLElement: browser.HTMLElement, Element: browser.Element, Node: browser.Node,
            MutationObserver: browser.MutationObserver, ResizeObserver: browser.ResizeObserver,
            requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
            cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
            getComputedStyle: browser.getComputedStyle.bind(browser), IS_REACT_ACT_ENVIRONMENT: true,
        };
        descriptors = new Map(Object.keys(globals).map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
        for (const [name, value] of Object.entries(globals)) Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
        host = document.createElement('div');
        document.body.append(host);
        root = createRoot(host);
        saves = 0;
        cancels = 0;
    });

    afterEach(async () => {
        await act(async () => root.unmount());
        browser.close();
        for (const [name, descriptor] of descriptors) {
            if (descriptor) Object.defineProperty(globalThis, name, descriptor);
            else Reflect.deleteProperty(globalThis, name);
        }
    });

    const show = async () => act(async () => root.render(
        <ReferenceMarkdownEditor
            value={'First line\n\nA `code` block stays Markdown.'}
            onChange={() => undefined}
            onSubmit={() => { saves += 1; }}
            onCancel={() => { cancels += 1; }}
            placeholder="Description"
            aria-label="Description"
        />,
    ));

    const press = async (key: string, init: { ctrlKey?: boolean; metaKey?: boolean } = {}) => {
        const field = browser.document.querySelector('[contenteditable]');
        if (!field) throw new Error('Expected the editor');
        await act(async () => {
            field.dispatchEvent(new browser.KeyboardEvent('keydown', { key, code: key === 'Escape' ? 'Escape' : 'Enter', bubbles: true, cancelable: true, ...init }));
        });
    };

    test('shows the Markdown source it was given', async () => {
        await show();
        expect(host.querySelector('[contenteditable]')?.textContent).toContain('First line');
        expect(host.querySelector('[contenteditable]')?.textContent).toContain('A `code` block stays Markdown.');
    });

    test('Escape cancels and Mod+Enter saves', async () => {
        await show();
        await press('Escape');
        expect(cancels).toBe(1);
        await press('Enter', { ctrlKey: true });
        expect(saves).toBe(1);
    });

    test('Enter alone is a new line, not a save', async () => {
        await show();
        await press('Enter');
        expect(saves).toBe(0);
    });
});
