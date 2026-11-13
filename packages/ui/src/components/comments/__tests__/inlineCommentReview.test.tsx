import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { I18nProvider } from '@/lib/i18n';
import { InlineCommentInput, type InlineCommentInputProps } from '../InlineCommentInput';

describe('the comment field outside and inside a change request review', () => {
    let browser: Window;
    let root: Root;
    let restoreGlobals: () => void;

    beforeEach(() => {
        browser = new Window();
        const globals = {
            window: browser,
            document: browser.document,
            navigator: browser.navigator,
            HTMLElement: browser.HTMLElement,
            Element: browser.Element,
            Node: browser.Node,
            MutationObserver: browser.MutationObserver,
            ResizeObserver: browser.ResizeObserver,
            requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
            cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
            getComputedStyle: browser.getComputedStyle.bind(browser),
            localStorage: browser.localStorage,
            IS_REACT_ACT_ENVIRONMENT: true,
        };
        const descriptors = Object.getOwnPropertyDescriptors(globalThis);
        Object.assign(globalThis, globals);
        restoreGlobals = () => {
            for (const key of Object.keys(globals)) {
                const descriptor = descriptors[key];
                if (descriptor) Object.defineProperty(globalThis, key, descriptor);
                else Reflect.deleteProperty(globalThis, key);
            }
        };
        const host = document.createElement('div');
        document.body.append(host);
        root = createRoot(host);
    });

    afterEach(async () => {
        await act(async () => root.unmount());
        browser.close();
        restoreGlobals();
    });

    const mount = async (props: Partial<InlineCommentInputProps>) => {
        await act(async () => root.render(
            <I18nProvider>
                <InlineCommentInput initialText="Note" onSave={props.onSave ?? (() => undefined)} onCancel={() => undefined} {...props} />
            </I18nProvider>,
        ));
    };
    const buttons = () => [...document.querySelectorAll('button')].map((button) => button.getAttribute('aria-label') ?? button.textContent?.trim());
    const footer = () => document.querySelector('[data-comment-input]')?.textContent ?? '';

    test('keeps only Attach where no review is offered, and names the file and line', async () => {
        await mount({ fileLabel: 'src/app/main.ts', lineRange: { start: 7, end: 7 } });

        expect(buttons().join(' ')).toContain('Attach');
        expect(buttons().join(' ')).not.toContain('Add to review');
        expect(buttons().join(' ')).not.toContain('Suggest change');
        expect(footer()).toContain('main.ts');
        expect(footer()).not.toContain('src/app');
        expect(footer()).toContain('Line 7');
    });

    test('names a range and a whole file', async () => {
        await mount({ fileLabel: 'a.ts', lineRange: { start: 2, end: 9 } });
        expect(footer()).toContain('Lines 2-9');
        await mount({ fileLabel: 'a.ts', wholeFile: true });
        expect(footer()).toContain('Whole file');
    });

    test('a review adds its button and leaves Attach what Enter does', async () => {
        const add = mock(async (_text: string) => true);
        const onSave = mock((_text: string) => undefined);
        await mount({ onSave, review: { add, suggestionCode: () => 'line' } });

        const field = browser.document.querySelector('textarea');
        await act(async () => {
            field?.dispatchEvent(new browser.KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
        });
        expect(onSave).toHaveBeenCalledTimes(1);
        expect(add).not.toHaveBeenCalled();

        const addButton = [...document.querySelectorAll('button')].find((button) => button.textContent?.includes('Add to review'));
        await act(async () => { addButton?.click(); });
        expect(add).toHaveBeenCalledTimes(1);
    });

    test('a suggestion starts from the selected lines', async () => {
        await mount({ review: { add: async () => true, suggestionCode: () => 'const a = 1;' } });

        await act(async () => { document.querySelector<HTMLButtonElement>('[aria-label="Suggest change"]')?.click(); });

        expect(document.querySelector('textarea')?.value).toContain('```suggestion\nconst a = 1;\n```');
    });

    test('a floating preview field keeps its round button and no footer', async () => {
        await mount({ floating: true, fileLabel: 'a.md', review: undefined });

        expect(buttons()).toEqual(['Comment']);
        expect(footer()).not.toContain('a.md');
    });
});
