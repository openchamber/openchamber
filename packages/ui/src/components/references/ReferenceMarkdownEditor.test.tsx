import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { ReferenceMarkdownEditor } from './ReferenceMarkdownEditor';

const wordModifier = /Mac/.test(navigator.platform) ? { altKey: true } : { ctrlKey: true };

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

    const show = async (value = 'First line\n\nA `code` block stays Markdown.', onChange = (_value: string) => {}, autoFocus = false, compact = false) => act(async () => root.render(
        <ReferenceMarkdownEditor
            value={value}
            onChange={onChange}
            autoFocus={autoFocus}
            compact={compact}
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

    /** The editor's height cap is measured from the line height its CSS resolves; happy-dom loads no CSS. */
    const withLineHeight = async (lineHeight: string, run: () => Promise<void>) => {
        const original = globalThis.getComputedStyle;
        Object.defineProperty(globalThis, 'getComputedStyle', {
            configurable: true,
            writable: true,
            // SAFETY: the stub answers only `lineHeight`, the single property ComposerEditor's height cap reads; the real style object is returned for every other element.
            value: (element: Element) => element instanceof HTMLElement && element.classList.contains('cm-content')
                ? ({ lineHeight } as CSSStyleDeclaration)
                : original(element),
        });
        try {
            await run();
        } finally {
            Object.defineProperty(globalThis, 'getComputedStyle', { configurable: true, writable: true, value: original });
        }
    };

    test("draws Markdown at the body's type and the preview height both host-text editors share", async () => {
        // 21px is the used line height of --text-markdown at the default zoom.
        await withLineHeight('21px', () => show());
        expect(host.querySelector('.composer-editor')?.className).toContain('typography-markdown');
        expect(host.querySelector('.composer-editor')?.className).toContain('min-h-[calc(12*1lh)]');
        expect(host.querySelector<HTMLElement>('.cm-scroller')?.style.maxHeight).toBe('252px');
    });

    test('a call site can ask for a shorter empty box without lowering the 12-line cap', async () => {
        await withLineHeight('21px', () => show(undefined, undefined, false, true));
        expect(host.querySelector('.composer-editor')?.className).toContain('min-h-[calc(4*1lh)]');
        expect(host.querySelector<HTMLElement>('.cm-scroller')?.style.maxHeight).toBe('252px');
    });

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

    test('an IME confirming Enter neither saves nor cancels', async () => {
        await show();
        const field = browser.document.querySelector('[contenteditable]');
        if (!field) throw new Error('Expected the editor');
        await act(async () => {
            field.dispatchEvent(new browser.KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', ctrlKey: true, isComposing: true, bubbles: true, cancelable: true }));
        });
        expect(saves).toBe(0);
        expect(cancels).toBe(0);
    });

    test('word backspace deletes a mixed-script word as one group', async () => {
        let value = '检查openchamber的配置';
        await show(value, (next) => { value = next; }, true);
        const field = browser.document.querySelector('[contenteditable]');
        if (!field) throw new Error('Expected the editor');
        field.dispatchEvent(new browser.KeyboardEvent('keydown', {
            key: 'Backspace', code: 'Backspace', bubbles: true, cancelable: true, ...wordModifier,
        }));
        expect(value).toBe('');
    });
});
