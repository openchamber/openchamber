import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { I18nProvider } from '@/lib/i18n';
import { ReviewSubmitForm } from './ReviewSubmitButton';
import type { ChangeRequestReview } from './useChangeRequestReview';

describe('sending a review', () => {
    let browser: Window;
    let root: Root;
    let restoreGlobals: () => void;

    beforeEach(() => {
        browser = new Window({ url: 'http://localhost/' });
        const globals = {
            window: browser, document: browser.document, navigator: browser.navigator,
            HTMLElement: browser.HTMLElement, Element: browser.Element, Node: browser.Node, SVGElement: browser.SVGElement,
            MutationObserver: browser.MutationObserver, ResizeObserver: browser.ResizeObserver,
            requestAnimationFrame: browser.requestAnimationFrame.bind(browser), cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
            getComputedStyle: browser.getComputedStyle.bind(browser), localStorage: browser.localStorage, IS_REACT_ACT_ENVIRONMENT: true,
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
        await browser.happyDOM.abort();
        browser.close();
        restoreGlobals();
    });

    const review = (submit: ChangeRequestReview['submit']): ChangeRequestReview => ({
        state: {
            viewerIsAuthor: false, headSha: 'abc', truncated: false, threads: [],
            draft: { id: 'R', body: '', comments: [
                { id: '1', path: 'a.ts', side: 'new', line: 1, startLine: null, body: 'x', author: null },
                { id: '2', path: 'a.ts', side: 'new', line: 2, startLine: null, body: 'y', author: null },
            ] },
        },
        readFailed: false,
        fileComments: true,
        addComment: async () => true, updateComment: async () => true, deleteComment: async () => true,
        reply: async () => true, setResolved: async () => true, attachThread: () => undefined, discard: async () => true,
        submit,
    });
    const button = (label: string) => [...document.querySelectorAll('button')].find((entry) => entry.textContent?.includes(label));

    test('the send button waits with a spinner and takes no second press', async () => {
        let finish: (sent: boolean) => void = () => undefined;
        const submit = mock((): Promise<boolean> => new Promise((resolve) => { finish = resolve; }));
        await act(async () => root.render(<I18nProvider><ReviewSubmitForm review={review(submit)} provider="github" onDone={() => undefined} /></I18nProvider>));

        const send = button('Send 2 comments');
        expect(send).toBeTruthy();
        await act(async () => { send?.click(); });

        expect(send?.querySelector('[data-spinner]')).toBeTruthy();
        expect(button('Send 2 comments')?.hasAttribute('disabled')).toBe(true);
        await act(async () => { send?.click(); });
        expect(submit).toHaveBeenCalledTimes(1);

        await act(async () => { finish(false); });
        expect(button('Send 2 comments')?.querySelector('[data-spinner]')).toBeFalsy();
    });
});
