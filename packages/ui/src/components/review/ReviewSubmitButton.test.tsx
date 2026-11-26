import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { I18nProvider } from '@/lib/i18n';
import { useSourceControlProviderRegistry } from '@/lib/source-control/providers/registry';
import { githubLikeDescriptor } from '@/lib/source-control/providers/descriptor.fixture';
import { ReviewSubmitButton, ReviewSubmitForm } from './ReviewSubmitButton';
import type { ChangeRequestReview } from './useChangeRequestReview';

describe('sending a review', () => {
    let browser: Window;
    let root: Root;
    let restoreGlobals: () => void;
    let restoreProviders: () => void;

    const seedProvider = (reviews: boolean) => {
        const previous = useSourceControlProviderRegistry.getState();
        restoreProviders = () => useSourceControlProviderRegistry.setState(previous);
        const descriptor = githubLikeDescriptor();
        useSourceControlProviderRegistry.setState({
            byId: new Map([['github', { ...descriptor, features: { ...descriptor.features, reviews } }]]),
            ordered: [{ ...descriptor, features: { ...descriptor.features, reviews } }],
            status: 'ready',
            holdsList: true,
        });
    };

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
        seedProvider(true);
    });

    afterEach(async () => {
        await act(async () => root.unmount());
        await browser.happyDOM.abort();
        browser.close();
        restoreGlobals();
        restoreProviders();
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
        canWrite: true,
        addComment: async () => true, updateComment: async () => true, deleteComment: async () => true,
        reply: async () => true, setResolved: async () => true, attachThread: () => undefined, discard: async () => true,
        submit,
    });
    const button = (label: string) => [...document.querySelectorAll('button')].find((entry) => entry.textContent?.includes(label));
    const reviewWithoutDraft = (submit: ChangeRequestReview['submit']): ChangeRequestReview => {
        const base = review(submit);
        return { ...base, state: { ...base.state!, draft: null } };
    };

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

    test('a draft-only host keeps the draft and its discard, without send or verdicts', async () => {
        seedProvider(false);
        const submit = mock(async () => true);
        await act(async () => root.render(<I18nProvider><ReviewSubmitForm review={review(submit)} provider="github" onDone={() => undefined} /></I18nProvider>));

        expect(button('Send 2 comments')).toBeFalsy();
        expect(button('Approve')).toBeFalsy();
        expect(button('Request changes')).toBeFalsy();
        expect(button('Discard review')).toBeTruthy();
        expect(document.querySelector('textarea')).toBeNull();
    });

    test('an account denied write access keeps the draft in view without its discard', async () => {
        seedProvider(false);
        const denied = { ...review(mock(async () => true)), canWrite: false };
        await act(async () => root.render(<I18nProvider><ReviewSubmitForm review={denied} provider="github" onDone={() => undefined} /></I18nProvider>));
        expect(button('Discard review')).toBeFalsy();

        await act(async () => root.render(<I18nProvider><ReviewSubmitButton review={denied} provider="github" /></I18nProvider>));
        expect(button('Review')).toBeFalsy();
    });

    test('a host with reviews keeps sending and the verdicts', async () => {
        const submit = mock(async () => true);
        await act(async () => root.render(<I18nProvider><ReviewSubmitForm review={review(submit)} provider="github" onDone={() => undefined} /></I18nProvider>));

        expect(button('Send 2 comments')).toBeTruthy();
        expect(button('Approve')).toBeTruthy();
        expect(button('Discard review')).toBeTruthy();
        expect(document.querySelector('textarea')).toBeTruthy();
    });

    test('the review trigger is absent on a draft-only host with nothing to send', async () => {
        seedProvider(false);
        await act(async () => root.render(<I18nProvider><ReviewSubmitButton review={reviewWithoutDraft(async () => true)} provider="github" /></I18nProvider>));
        expect(button('Review')).toBeFalsy();
    });

    test('a failed first read on a draft-only host keeps the trigger and says so in its form', async () => {
        seedProvider(false);
        const failed = { ...review(async () => true), state: null, readFailed: true };
        await act(async () => root.render(<I18nProvider><ReviewSubmitButton review={failed} provider="github" /></I18nProvider>));
        expect(button('Review')).toBeTruthy();
        await act(async () => root.render(<I18nProvider><ReviewSubmitForm review={failed} provider="github" onDone={() => undefined} /></I18nProvider>));
        expect(document.body.textContent).toContain("This review couldn't be read.");
    });

    test('the review trigger stays on a host that serves reviews', async () => {
        await act(async () => root.render(<I18nProvider><ReviewSubmitButton review={reviewWithoutDraft(async () => true)} provider="github" /></I18nProvider>));
        expect(button('Review')).toBeTruthy();
    });
});
